"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDeviceFirebaseUpdate,
  memberPresenceStatusSignature,
  presenceCleanupTargetSignature,
  updatePersistedTelemetrySnapshot,
} = require("../firebase_write_policy");

const MINUTE = 60 * 1000;

test("packet telemetry lặp trong 60 giây không ghi Firebase", () => {
  const now = 200_000;
  const result = buildDeviceFirebaseUpdate({
    candidateUpdate: {
      last_seen: "2026-07-29T12:00:30.000Z",
      linkquality: 55,
    },
    currentDevice: {
      last_seen: "2026-07-29T12:00:20.000Z",
      linkquality: 55,
    },
    persistedTelemetry: {
      last_seen: "2026-07-29T12:00:00.000Z",
      linkquality: 55,
    },
    now,
    lastTelemetryPersistAt: now - 30_000,
    telemetryIntervalMs: MINUTE,
  });

  assert.deepEqual(result, {});
});

test("last_seen được ghi khi đủ chu kỳ 60 giây", () => {
  const now = 200_000;
  const result = buildDeviceFirebaseUpdate({
    candidateUpdate: {
      last_seen: "2026-07-29T12:01:00.000Z",
      linkquality: 55,
    },
    currentDevice: {
      last_seen: "2026-07-29T12:00:50.000Z",
      linkquality: 55,
    },
    persistedTelemetry: {
      last_seen: "2026-07-29T12:00:00.000Z",
      linkquality: 55,
    },
    now,
    lastTelemetryPersistAt: now - MINUTE,
    telemetryIntervalMs: MINUTE,
  });

  assert.deepEqual(result, {
    last_seen: "2026-07-29T12:01:00.000Z",
    updated_at: now,
  });
});

test("trạng thái cửa thay đổi được ghi ngay và mang theo telemetry mới", () => {
  const now = 200_000;
  const result = buildDeviceFirebaseUpdate({
    candidateUpdate: {
      contact: false,
      last_seen: "2026-07-29T12:00:30.000Z",
      linkquality: 60,
      last_event: now,
    },
    currentDevice: {
      contact: true,
      last_seen: "2026-07-29T12:00:20.000Z",
      linkquality: 55,
    },
    persistedTelemetry: {
      last_seen: "2026-07-29T12:00:00.000Z",
      linkquality: 55,
    },
    now,
    lastTelemetryPersistAt: now - 10_000,
    telemetryIntervalMs: MINUTE,
  });

  assert.deepEqual(result, {
    contact: false,
    last_event: now,
    last_seen: "2026-07-29T12:00:30.000Z",
    linkquality: 60,
    updated_at: now,
  });
});

test("nhiệt độ thay đổi chỉ ghi khi đến chu kỳ telemetry", () => {
  const now = 200_000;
  const base = {
    candidateUpdate: {
      temperature: 27.4,
      humidity: 70,
    },
    currentDevice: {
      temperature: 27.4,
      humidity: 70,
    },
    persistedTelemetry: {
      temperature: 27.1,
      humidity: 70,
    },
    now,
    telemetryIntervalMs: MINUTE,
  };

  assert.deepEqual(
    buildDeviceFirebaseUpdate({
      ...base,
      lastTelemetryPersistAt: now - 20_000,
    }),
    {},
  );

  assert.deepEqual(
    buildDeviceFirebaseUpdate({
      ...base,
      lastTelemetryPersistAt: now - MINUTE,
    }),
    {
      temperature: 27.4,
      updated_at: now,
    },
  );
});

test("snapshot telemetry chỉ cập nhật các field thực sự đã ghi", () => {
  const next = updatePersistedTelemetrySnapshot(
    {
      last_seen: "old",
      temperature: 26,
    },
    {
      contact: false,
      last_seen: "new",
      updated_at: 123,
    },
  );

  assert.deepEqual(next, {
    last_seen: "new",
    temperature: 26,
  });
});

test("Presence cùng trạng thái không ghi lại chỉ vì timestamp heartbeat đổi", () => {
  const first = {
    uid: {
      online: true,
      connected: false,
      autoAwayParticipant: true,
      state: "outside",
      locationKnown: true,
      monitoringEligible: true,
      monitoringAvailable: true,
      monitoringWarnings: [],
      monitoringHealth: "active",
      appState: "background_event",
      reason: "",
      lastConfirmedAt: 100,
      lastSeenAt: 100,
      updatedAt: 100,
    },
  };

  const second = {
    uid: {
      ...first.uid,
      lastConfirmedAt: 200,
      lastSeenAt: 200,
      updatedAt: 200,
    },
  };

  assert.equal(
    memberPresenceStatusSignature(first),
    memberPresenceStatusSignature(second),
  );
});

test("Presence vẫn ghi khi trạng thái hoặc sức khỏe thực sự đổi", () => {
  const base = {
    uid: {
      online: true,
      connected: false,
      autoAwayParticipant: true,
      state: "outside",
      locationKnown: true,
      monitoringEligible: true,
      monitoringAvailable: true,
      monitoringWarnings: [],
      monitoringHealth: "active",
      appState: "background_event",
      reason: "",
    },
  };

  assert.notEqual(
    memberPresenceStatusSignature(base),
    memberPresenceStatusSignature({
      uid: {
        ...base.uid,
        state: "unknown",
        locationKnown: false,
        monitoringHealth: "unavailable",
        reason: "session_stale",
      },
    }),
  );
});

test("cleanup Presence cùng reason có target signature ổn định", () => {
  assert.equal(
    presenceCleanupTargetSignature("session_stale"),
    presenceCleanupTargetSignature("session_stale"),
  );
  assert.notEqual(
    presenceCleanupTargetSignature("session_stale"),
    presenceCleanupTargetSignature("signed_out"),
  );
});
