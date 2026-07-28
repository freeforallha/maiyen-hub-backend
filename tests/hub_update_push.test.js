"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildHubUpdatePushMessage,
  createHubUpdatePushCoordinator,
} = require("../hub_update_push");

function createMemoryDatabase(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));

  return {
    values,
    ref(path) {
      return {
        async once() {
          return {
            val() {
              return values.has(path)
                ? values.get(path)
                : null;
            },
          };
        },
        async set(value) {
          values.set(path, value);
        },
        async update(patch) {
          const current =
            values.get(path) &&
            typeof values.get(path) === "object"
              ? values.get(path)
              : {};

          values.set(path, {
            ...current,
            ...patch,
          });
        },
      };
    },
  };
}

function manifest(releaseId = "v1.2.6") {
  return {
    schemaVersion: 1,
    releaseId,
    backendVersion: "1.2.6",
    hubFirmwareVersion: "1.1.0",
    protocolVersion: "1.0.0",
    minBackendVersion: "1.2.5",
    packageUrl:
      "https://github.com/example/release.zip",
    packageSha256: "a".repeat(64),
    publishedAt: 1785200000000,
    critical: false,
    notes: {
      vi: "Cập nhật",
    },
  };
}

test("push payload matches the App hub-update contract", () => {
  const message = buildHubUpdatePushMessage({
    manifest: manifest(),
    ownerUid: "owner-1",
    homeId: "home-1",
    homeName: "Nhà chính",
    languageCode: "vi",
  });

  assert.deepEqual(message.data, {
    type: "hub_update_available",
    title: "Phiên bản v1.2.6 đã sẵn sàng.",
    body: "Nhà chính",
    ownerUid: "owner-1",
    homeId: "home-1",
    homeName: "Nhà chính",
    releaseId: "v1.2.6",
    backendVersion: "1.2.6",
    hubFirmwareVersion: "1.1.0",
    protocolVersion: "1.0.0",
    critical: "false",
    publishedAt: "1785200000000",
    clickAction: "hub_update",
  });

  assert.equal(message.android.priority, "high");
  assert.equal(
    message.apns.payload.aps.alert.title,
    "Phiên bản v1.2.6 đã sẵn sàng.",
  );
  assert.equal(
    message.apns.payload.aps.alert.body,
    "Nhà chính",
  );
});

test("critical update title follows the receiver language", () => {
  const message = buildHubUpdatePushMessage({
    manifest: {
      ...manifest(),
      critical: true,
    },
    ownerUid: "owner-1",
    homeId: "home-1",
    languageCode: "en-US",
  });

  assert.equal(
    message.data.title,
    "Critical update: v1.2.6",
  );
  assert.equal(message.data.body, "Hub update");
});

test("coordinator sends once for each receiver and release", async () => {
  const db = createMemoryDatabase();
  const sent = [];

  const coordinator = createHubUpdatePushCoordinator({
    db,
    deviceId: "dev_1234",
    getLinkedHomes: async () => [
      {
        uid: "owner-1",
        homeId: "home-1",
      },
    ],
    getReceiverUids: () => [
      "owner-1",
      "member-1",
      "member-1",
    ],
    getHomeData: () => ({
      name: "Nhà chính",
    }),
    getLanguageCode: (uid) =>
      uid === "member-1" ? "en" : "vi",
    sendPushToUser: async (uid, message, label) => {
      sent.push({
        uid,
        message,
        label,
      });

      return {
        sent: 1,
        failed: 0,
      };
    },
  });

  const first = await coordinator.handleReleaseCheck({
    manifest: manifest(),
    updateAvailable: true,
  });

  const second = await coordinator.handleReleaseCheck({
    manifest: manifest(),
    updateAvailable: true,
  });

  assert.equal(first.sent, 2);
  assert.equal(first.receivers, 2);
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((item) => item.uid).sort(),
    ["member-1", "owner-1"],
  );
  assert.equal(
    sent.find((item) => item.uid === "member-1")
      .message.data.title,
    "Version v1.2.6 is ready.",
  );
});

test("coordinator retries a missing token only after cooldown", async () => {
  const db = createMemoryDatabase();
  let currentTime = 1000000;
  let attempts = 0;

  const coordinator = createHubUpdatePushCoordinator({
    db,
    deviceId: "dev_1234",
    getLinkedHomes: async () => [
      {
        uid: "owner-1",
        homeId: "home-1",
      },
    ],
    getReceiverUids: () => ["owner-1"],
    getHomeData: () => ({
      name: "Nhà chính",
    }),
    getLanguageCode: () => "vi",
    sendPushToUser: async () => {
      attempts++;

      return {
        sent: 0,
        failed: 0,
      };
    },
    retryIntervalMs: 60 * 1000,
    now: () => currentTime,
  });

  await coordinator.handleReleaseCheck({
    manifest: manifest(),
    updateAvailable: true,
  });

  await coordinator.handleReleaseCheck({
    manifest: manifest(),
    updateAvailable: true,
  });

  assert.equal(attempts, 1);

  currentTime += 61 * 1000;

  await coordinator.handleReleaseCheck({
    manifest: manifest(),
    updateAvailable: true,
  });

  assert.equal(attempts, 2);
});
