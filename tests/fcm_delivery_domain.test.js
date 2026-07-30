"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFcmDeliveryDomain,
} = require("../domains/notifications/fcm_delivery");

function createHarness({
  accounts = {},
  cachedAccounts = {},
  sendImpl = async () => "message-id",
} = {}) {
  const rootUpdates = [];
  const sentMessages = [];
  const logs = [];

  const db = {
    ref(path = "") {
      if (!path) {
        return {
          async update(value) {
            rootUpdates.push(value);
          },
        };
      }

      return {
        async once(eventName) {
          assert.equal(eventName, "value");
          const uid = path.split("/")[1] || "";
          return {
            val: () => accounts[uid] || null,
          };
        },
      };
    },
  };

  const admin = {
    messaging() {
      return {
        async send(message) {
          sentMessages.push(message);
          return sendImpl(message);
        },
      };
    },
  };

  const runtime = createFcmDeliveryDomain({
    db,
    admin,
    accountCache: new Map(Object.entries(cachedAccounts)),
    normalizeLanguageCode: (value) =>
      ["vi", "en"].includes(value) ? value : "vi",
    localizeBackendText: (languageCode, text) =>
      `${languageCode}:${text}`,
    localizeAlarmItemsJson: (languageCode, value) =>
      `${languageCode}:items:${value}`,
    log: (...args) => logs.push(args),
  });

  return {
    runtime,
    rootUpdates,
    sentMessages,
    logs,
  };
}

function activeAccount(overrides = {}) {
  return {
    activeSession: {
      installationId: "install-1",
      sessionId: "session-1",
    },
    sessions: {
      "install-1": {
        sessionId: "session-1",
        signedIn: true,
      },
    },
    fcmTokens: {
      "install-1": {
        sessionId: "session-1",
        token: " token-1 ",
      },
    },
    ...overrides,
  };
}

test("active session selects only its matching installation token", async () => {
  const { runtime } = createHarness({
    accounts: { u1: activeAccount() },
  });

  assert.deepEqual(
    await runtime.getUserFcmTargets("u1"),
    [
      {
        token: "token-1",
        paths: ["accounts/u1/fcmTokens/install-1"],
      },
    ],
  );
});

test("session or token mismatch is rejected before Firebase Messaging", async () => {
  const mismatch = activeAccount({
    fcmTokens: {
      "install-1": {
        sessionId: "old-session",
        token: "token-1",
      },
    },
  });
  const { runtime, sentMessages } = createHarness({
    accounts: { u1: mismatch },
  });

  assert.deepEqual(await runtime.getUserFcmTargets("u1"), []);
  assert.deepEqual(
    await runtime.sendPushToUser("u1", { data: {} }),
    { total: 0, sent: 0, failed: 0, removed: 0 },
  );
  assert.equal(sentMessages.length, 0);
});

test("payload localization covers data notification APNs and Alarm items", () => {
  const { runtime } = createHarness({
    cachedAccounts: {
      u1: { profile: { languageCode: "en" } },
    },
  });
  const original = {
    data: {
      title: "Title",
      body: "Body",
      message: "Message",
      text: "Text",
      subtitle: "Subtitle",
      reason: "Reason",
      statusText: "Status",
      alarmItems: "[]",
      untouched: "raw",
    },
    notification: {
      title: "Notification title",
      body: "Notification body",
    },
    apns: {
      payload: {
        aps: {
          alert: {
            title: "APNs title",
            body: "APNs body",
          },
        },
      },
    },
  };

  const localized = runtime.localizePushMessageForUser(
    "u1",
    original,
  );

  assert.equal(localized.data.title, "en:Title");
  assert.equal(localized.data.body, "en:Body");
  assert.equal(localized.data.message, "en:Message");
  assert.equal(localized.data.text, "en:Text");
  assert.equal(localized.data.subtitle, "en:Subtitle");
  assert.equal(localized.data.reason, "en:Reason");
  assert.equal(localized.data.statusText, "en:Status");
  assert.equal(localized.data.alarmItems, "en:items:[]");
  assert.equal(localized.data.languageCode, "en");
  assert.equal(localized.data.untouched, "raw");
  assert.equal(
    localized.notification.title,
    "en:Notification title",
  );
  assert.equal(localized.notification.body, "en:Notification body");
  assert.equal(localized.apns.payload.aps.alert.title, "en:APNs title");
  assert.equal(localized.apns.payload.aps.alert.body, "en:APNs body");
  assert.equal(original.data.languageCode, undefined);
  assert.equal(original.data.title, "Title");
});

test("successful delivery sends localized payload to the active token", async () => {
  const { runtime, sentMessages } = createHarness({
    accounts: { u1: activeAccount() },
    cachedAccounts: { u1: { languageCode: "en" } },
  });

  const result = await runtime.sendPushToUser(
    "u1",
    { data: { title: "Alarm" } },
    "ALARM TEST",
  );

  assert.deepEqual(result, {
    total: 1,
    sent: 1,
    failed: 0,
    removed: 0,
  });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].token, "token-1");
  assert.equal(sentMessages[0].data.title, "en:Alarm");
  assert.equal(sentMessages[0].data.languageCode, "en");
});

test("invalid registration token is removed from its installation path", async () => {
  const invalidError = Object.assign(
    new Error("token invalid"),
    {
      errorInfo: {
        code: "messaging/registration-token-not-registered",
      },
    },
  );
  const { runtime, rootUpdates } = createHarness({
    accounts: { u1: activeAccount() },
    sendImpl: async () => {
      throw invalidError;
    },
  });

  const result = await runtime.sendPushToUser(
    "u1",
    { data: {} },
  );

  assert.deepEqual(result, {
    total: 1,
    sent: 0,
    failed: 1,
    removed: 1,
  });
  assert.deepEqual(rootUpdates, [
    {
      "accounts/u1/fcmTokens/install-1": null,
    },
  ]);
});

test("transient delivery error does not delete a valid token", async () => {
  const { runtime, rootUpdates } = createHarness({
    accounts: { u1: activeAccount() },
    sendImpl: async () => {
      throw new Error("temporary unavailable");
    },
  });

  const result = await runtime.sendPushToUser(
    "u1",
    { data: {} },
  );

  assert.deepEqual(result, {
    total: 1,
    sent: 0,
    failed: 1,
    removed: 0,
  });
  assert.deepEqual(rootUpdates, []);
});

test("empty invalid-token cleanup is a no-op and error codes stay strict", async () => {
  const { runtime, rootUpdates } = createHarness();

  await runtime.removeInvalidFcmTokenPaths(["", null]);

  assert.deepEqual(rootUpdates, []);
  assert.equal(
    runtime.isInvalidFcmTokenError({
      code: "messaging/invalid-registration-token",
    }),
    true,
  );
  assert.equal(
    runtime.isInvalidFcmTokenError({
      code: "messaging/server-unavailable",
    }),
    false,
  );
});
