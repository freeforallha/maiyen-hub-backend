"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createHomeActivityDomain,
} = require("../domains/notifications/home_activity");

function clone(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}

function splitPath(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean);
}

function getAt(root, pathValue) {
  let current = root;

  for (const part of splitPath(pathValue)) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function setAt(root, pathValue, value) {
  const parts = splitPath(pathValue);

  if (parts.length === 0) {
    throw new Error("Root set is not used by this test database");
  }

  let current = root;

  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }

  const last = parts.at(-1);

  if (value === null || value === undefined) {
    delete current[last];
  } else {
    current[last] = clone(value);
  }
}

function createMemoryDb(initial = {}) {
  const data = clone(initial) || {};
  const operations = [];
  const listeners = [];
  let pushCounter = 0;

  class Snapshot {
    constructor(ref, value) {
      this.ref = ref;
      this.key = ref.key;
      this._value = clone(value);
    }

    val() {
      return clone(this._value);
    }

    exists() {
      return this._value !== undefined && this._value !== null;
    }

    child(pathValue) {
      const value = getAt(this._value || {}, pathValue);
      return new Snapshot(this.ref.child(pathValue), value);
    }
  }

  class Ref {
    constructor(pathValue) {
      this.path = splitPath(pathValue).join("/");
      this.key = splitPath(this.path).at(-1) || null;
    }

    child(pathValue) {
      return new Ref([this.path, pathValue].filter(Boolean).join("/"));
    }

    push() {
      pushCounter += 1;
      return this.child(`push_${pushCounter}`);
    }

    async once() {
      return new Snapshot(this, getAt(data, this.path));
    }

    async set(value) {
      operations.push({ type: "set", path: this.path, value: clone(value) });
      setAt(data, this.path, value);
    }

    async update(value) {
      operations.push({ type: "update", path: this.path, value: clone(value) });

      for (const [key, item] of Object.entries(value || {})) {
        setAt(data, [this.path, key].filter(Boolean).join("/"), item);
      }
    }

    async remove() {
      operations.push({ type: "remove", path: this.path });
      setAt(data, this.path, null);
    }

    on(event, callback) {
      listeners.push({ type: "on", path: this.path, event, callback });
    }

    off(event, callback) {
      listeners.push({ type: "off", path: this.path, event, callback });
    }
  }

  return {
    db: {
      ref(pathValue = "") {
        return new Ref(pathValue);
      },
    },
    data,
    operations,
    listeners,
  };
}

function createDomain({ initial, receivers = ["owner"], overrides = {} } = {}) {
  const runtime = createMemoryDb(initial);
  const cleanups = [];
  const chatPushes = [];

  const domain = createHomeActivityDomain({
    db: runtime.db,
    getUserLanguageCode: () => "vi",
    localizeBackendText: (languageCode, text) =>
      `${languageCode}:${text}`,
    queueOrderedListCleanup: (...args) => cleanups.push(args),
    getAlarmReceiverUidsForHome: () => receivers,
    lastNotificationMap: {},
    getCachedAccountData: (uid) => getAt(runtime.data, `accounts/${uid}`),
    buildUserDirectoryData: (account) => ({
      name: String(account?.profile?.name || account?.name || ""),
      email: String(account?.email || ""),
    }),
    incrementChatUnreadCounter: async () => 2,
    sendChatNotificationPush: async (payload) => chatPushes.push(payload),
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
    log: () => {},
    ...overrides,
  });

  return { ...runtime, domain, cleanups, chatPushes };
}

test("Home Notification is localized, persisted and queued for trimming", async () => {
  const runtime = createDomain();

  await runtime.domain.addHomeNotificationFromBackend({
    uid: "u1",
    ownerUid: "owner",
    homeId: "home1",
    homeName: "Nhà chính",
    type: "mode_changed",
    title: "Tiêu đề",
    message: "Nội dung",
    actorUid: "actor",
    data: { reason: "manual" },
  });

  const write = runtime.operations.find(
    (operation) =>
      operation.type === "set" &&
      operation.path === "accounts/u1/notifications/push_1",
  );

  assert.ok(write);
  assert.equal(write.value.title, "vi:Tiêu đề");
  assert.equal(write.value.message, "vi:Nội dung");
  assert.equal(write.value.homeName, "Nhà chính");
  assert.equal(write.value.ownerUid, "owner");
  assert.equal(write.value.actorUid, "actor");
  assert.equal(write.value.data.reason, "manual");
  assert.equal(write.value.data.homeName, "Nhà chính");
  assert.equal(runtime.cleanups.length, 1);
  assert.equal(runtime.cleanups[0][0], "home_notifications:u1");
  assert.equal(runtime.cleanups[0][2], 120);
});

test("recipient fanout deduplicates the same activity inside its window", async () => {
  const runtime = createDomain({ receivers: ["u1", "u2"] });
  const payload = {
    ownerUid: "owner",
    homeId: "home1",
    homeName: "Nhà",
    type: "device_updated",
    title: "Thiết bị",
    message: "Đã thay đổi",
    dedupeKey: "device|d1",
    dedupeMs: 60_000,
  };

  await runtime.domain.addHomeNotificationToHomeRecipients(payload);
  await runtime.domain.addHomeNotificationToHomeRecipients(payload);

  const writes = runtime.operations.filter(
    (operation) =>
      operation.type === "set" &&
      /accounts\/u[12]\/notifications\//.test(operation.path),
  );

  assert.equal(writes.length, 2);
});

test("cached display name prefers profile name and falls back to email", () => {
  const runtime = createDomain({
    initial: {
      accounts: {
        named: { profile: { name: "Mai" }, email: "mai@example.com" },
        emailOnly: { email: "user@example.com" },
      },
    },
  });

  assert.equal(runtime.domain.getCachedUserDisplayName("named"), "Mai");
  assert.equal(
    runtime.domain.getCachedUserDisplayName("emailOnly"),
    "user@example.com",
  );
  assert.equal(
    runtime.domain.getCachedUserDisplayName("missing"),
    "Một thành viên",
  );
});

test("Home Activity monitor starts once and unregisters its listener", () => {
  const runtime = createDomain();

  assert.equal(runtime.domain.startHomeActivityMonitor(), true);
  assert.equal(runtime.domain.startHomeActivityMonitor(), false);
  runtime.domain.stopHomeActivityMonitor();

  assert.equal(
    runtime.listeners.filter((entry) => entry.type === "on").length,
    1,
  );
  assert.equal(
    runtime.listeners.filter((entry) => entry.type === "off").length,
    1,
  );
});

test("invalid request publishes a rejected result before removing request", async () => {
  const runtime = createDomain();
  const requestRef = runtime.db.ref("home_notification_requests/r1");
  const requestSnap = {
    key: "r1",
    ref: requestRef,
    val: () => ({
      status: "invalid",
      requestedBy: "u1",
    }),
  };

  await runtime.domain.processHomeNotificationRequestSnapshot(requestSnap);

  const resultIndex = runtime.operations.findIndex(
    (operation) =>
      operation.type === "set" &&
      operation.path ===
        "accounts/u1/homeNotificationRequestResults/r1",
  );
  const removeIndex = runtime.operations.findIndex(
    (operation) =>
      operation.type === "remove" &&
      operation.path === "home_notification_requests/r1",
  );

  assert.ok(resultIndex >= 0);
  assert.ok(removeIndex > resultIndex);
  assert.equal(runtime.operations[resultIndex].value.status, "rejected");
  assert.equal(runtime.operations[resultIndex].value.reason, "INVALID DATA");
});

test("valid owner activity writes recipient notification, timeline and result", async () => {
  const runtime = createDomain({
    initial: {
      accounts: {
        owner: {
          profile: { name: "Chủ nhà" },
          homes: {
            home1: { name: "Nhà chính", devices: {} },
          },
        },
      },
      sharedByHome: { home1: {} },
    },
  });
  const requestRef = runtime.db.ref("home_notification_requests/r2");
  const requestSnap = {
    key: "r2",
    ref: requestRef,
    val: () => ({
      status: "pending",
      requestedBy: "owner",
      ownerUid: "owner",
      homeId: "home1",
      recipientUid: "",
      type: "mode_changed",
      category: "home",
      severity: "info",
      title: "Mode",
      message: "Đã thay đổi Mode",
      deviceId: "",
      entityType: "home",
      entityId: "home1",
      includeActor: true,
      writeHomeTimeline: true,
      time: Date.now(),
      data: { source: "manual" },
    }),
  };

  await runtime.domain.processHomeNotificationRequestSnapshot(requestSnap);

  assert.ok(
    runtime.operations.some(
      (operation) =>
        operation.type === "set" &&
        /^accounts\/owner\/notifications\//.test(operation.path),
    ),
  );
  assert.ok(
    runtime.operations.some(
      (operation) =>
        operation.type === "set" &&
        /^accounts\/owner\/homes\/home1\/events\//.test(operation.path),
    ),
  );

  const resultIndex = runtime.operations.findIndex(
    (operation) =>
      operation.type === "set" &&
      operation.path ===
        "accounts/owner/homeNotificationRequestResults/r2",
  );
  const removeIndex = runtime.operations.findIndex(
    (operation) =>
      operation.type === "remove" &&
      operation.path === "home_notification_requests/r2",
  );

  assert.equal(runtime.operations[resultIndex].value.status, "completed");
  assert.ok(removeIndex > resultIndex);
});

test("targeted request cannot write the shared Home timeline", async () => {
  const runtime = createDomain();
  const requestRef = runtime.db.ref("home_notification_requests/r3");
  const requestSnap = {
    key: "r3",
    ref: requestRef,
    val: () => ({
      status: "pending",
      requestedBy: "owner",
      ownerUid: "owner",
      homeId: "home1",
      recipientUid: "member",
      type: "share_request",
      category: "member",
      severity: "info",
      title: "Mời",
      message: "Tham gia nhà",
      deviceId: "",
      entityType: "home",
      entityId: "home1",
      includeActor: false,
      writeHomeTimeline: true,
      time: Date.now(),
    }),
  };

  await runtime.domain.processHomeNotificationRequestSnapshot(requestSnap);

  const result = runtime.operations.find(
    (operation) =>
      operation.type === "set" &&
      operation.path ===
        "accounts/owner/homeNotificationRequestResults/r3",
  );

  assert.equal(result.value.status, "rejected");
  assert.equal(result.value.reason, "TARGET TIMELINE NOT ALLOWED");
});

test("verified chat activity delegates unread counting and push delivery", async () => {
  const messageTime = Date.now();
  const runtime = createDomain({
    initial: {
      accounts: {
        owner: {
          profile: { name: "Chủ nhà" },
          homes: { home1: { name: "Nhà", devices: {} } },
        },
        member: {
          sharedHomes: {
            home1: { ownerUid: "owner", role: "member" },
          },
        },
      },
      sharedByHome: { home1: { member: true } },
      homeChats: {
        home1: {
          messages: {
            m1: { uid: "owner", text: "Xin chào", time: messageTime },
          },
        },
      },
    },
  });
  const requestRef = runtime.db.ref("home_notification_requests/r4");
  const requestSnap = {
    key: "r4",
    ref: requestRef,
    val: () => ({
      status: "pending",
      requestedBy: "owner",
      ownerUid: "owner",
      homeId: "home1",
      recipientUid: "",
      type: "chat",
      category: "chat",
      severity: "info",
      title: "Nhà",
      message: "Xin chào",
      deviceId: "",
      entityType: "chat",
      entityId: "m1",
      includeActor: false,
      writeHomeTimeline: false,
      time: messageTime,
      data: { messageId: "m1" },
    }),
  };

  await runtime.domain.processHomeNotificationRequestSnapshot(requestSnap);

  assert.equal(runtime.chatPushes.length, 1);
  assert.equal(runtime.chatPushes[0].receiverUid, "member");
  assert.equal(runtime.chatPushes[0].messageId, "m1");
  assert.equal(runtime.chatPushes[0].unreadCount, 2);
  assert.equal(
    runtime.operations.filter(
      (operation) =>
        operation.type === "set" &&
        /\/notifications\//.test(operation.path),
    ).length,
    0,
  );
});
