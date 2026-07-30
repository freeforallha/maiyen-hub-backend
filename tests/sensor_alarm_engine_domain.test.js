"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAlarmIncidentDomain,
} = require("../domains/alarm/alarm_incident");
const {
  SENSOR_EVENT_CATEGORY,
  SENSOR_EVENT_SEVERITY,
  ALARM_INCIDENT_SCHEMA_VERSION,
  SAME_ALARM_EVENT_MIN_INTERVAL_MS,
  normalizeHomeSecurityMode,
  buildStandardIncidentFields,
  getSensorAlarmEventCode,
  isAlarmEventCodeActiveForDevice,
  didEmergencyStatusTrigger,
  createSensorAlarmEngine,
} = require("../domains/alarm/sensor_alarm_engine");

function createHarness({ now = 1_000_000 } = {}) {
  let currentNow = now;
  const databaseUpdates = [];
  const accounts = new Map();
  const incident = createAlarmIncidentDomain({
    localActiveAlarmIncidentMap: new Map(),
    offlineTransientAlarmTtlMs: 5 * 60 * 1000,
    alarmIncidentAutoExpireMs: 30 * 60 * 1000,
  });
  const db = {
    ref() {
      return {
        async update(value) {
          databaseUpdates.push(value);
        },
      };
    },
  };
  const engine = createSensorAlarmEngine({
    db,
    getCachedAccountData: (uid) => accounts.get(uid) || null,
    normalizeAlarmIncidentItems: incident.normalizeAlarmIncidentItems,
    isSecurityDeviceType: incident.isSecurityDeviceType,
    isEmergencyDeviceType: incident.isEmergencyDeviceType,
    nowFn: () => currentNow,
    log() {},
  });

  return {
    engine,
    accounts,
    databaseUpdates,
    setNow(value) {
      currentNow = value;
    },
    advance(duration) {
      currentNow += duration;
    },
  };
}

function alarmItem(overrides = {}) {
  return {
    ownerUid: "owner-a",
    homeId: "home-a",
    homeName: "Nhà A",
    deviceId: "door-a",
    deviceName: "Cửa chính",
    type: "door",
    reason: "Cửa chính: Cửa mở bất thường",
    ...overrides,
  };
}

test("incident schema fields and home mode normalization stay canonical", () => {
  assert.equal(ALARM_INCIDENT_SCHEMA_VERSION, 2);
  assert.equal(normalizeHomeSecurityMode("ARMED"), "armed");
  assert.equal(normalizeHomeSecurityMode("unprotected"), "unprotected");
  assert.equal(normalizeHomeSecurityMode("invalid"), "normal");

  assert.deepEqual(
    buildStandardIncidentFields("emergency", "sensor_triggered"),
    {
      schemaVersion: 2,
      eventCategory: SENSOR_EVENT_CATEGORY.EMERGENCY,
      alarmLevel: SENSOR_EVENT_SEVERITY.EMERGENCY,
      severity: "critical",
      statusReason: "sensor_triggered",
    },
  );
});

test("device policy and Alarm activation priority preserve emergency and security rules", () => {
  const { engine } = createHarness();

  assert.deepEqual(engine.normalizeDeviceAlarmPolicy({}, "door"), {
    enabled: true,
    notificationEnabled: true,
    physicalSirenEnabled: true,
    fullscreenEnabled: true,
  });
  assert.equal(
    engine.normalizeDeviceAlarmPolicy(
      { alarmPolicy: { enabled: false } },
      "smoke",
    ).enabled,
    true,
  );

  assert.equal(
    engine.resolveAlarmActivationPriority({
      deviceType: "smoke",
      homeMode: "normal",
    }).source,
    "emergency_sensor",
  );
  assert.equal(
    engine.resolveAlarmActivationPriority({
      deviceType: "door",
      homeMode: "armed",
      modeRepeatMinutes: 15,
    }).source,
    "security_mode",
  );
  assert.equal(
    engine.resolveAlarmActivationPriority({
      deviceType: "door",
      homeMode: "normal",
      activeSchedule: { alarm: { repeatMinutes: 30 } },
    }).repeatMinutes,
    30,
  );
  assert.equal(
    engine.resolveAlarmActivationPriority({
      deviceType: "door",
      homeMode: "unprotected",
    }).active,
    false,
  );
});

test("event codes distinguish persistent states and current device safety", () => {
  assert.equal(getSensorAlarmEventCode("door", "đang mở"), "door:open");
  assert.equal(
    getSensorAlarmEventCode("door", "Thiết bị bị tháo"),
    "door:tamper",
  );
  assert.equal(getSensorAlarmEventCode("smoke", "khói"), "smoke:active");
  assert.equal(getSensorAlarmEventCode("sos", "nhấn"), "sos:pressed");

  assert.equal(
    isAlarmEventCodeActiveForDevice("door:open", { contact: false }),
    true,
  );
  assert.equal(
    isAlarmEventCodeActiveForDevice("lock:unlocked", { state: "LOCK" }),
    false,
  );
  assert.equal(
    isAlarmEventCodeActiveForDevice("co:active", { co_alarm: "ON" }),
    true,
  );
});

test("sensor edge detection emits one canonical security or emergency trigger", () => {
  const { engine } = createHarness({ now: 50_000 });

  assert.deepEqual(
    engine.buildAlarmTriggerFromSensorEvent({
      deviceType: "smoke",
      deviceName: "Báo khói",
      oldDevice: { smoke: false },
      updateData: { smoke: true },
    }),
    {
      category: "emergency",
      severity: "emergency",
      reason: "Báo khói: Phát hiện khói",
    },
  );

  assert.equal(
    engine.buildAlarmTriggerFromSensorEvent({
      deviceType: "door",
      deviceName: "Cửa chính",
      oldDevice: { contact: true },
      updateData: { contact: false },
    }).reason,
    "Cửa chính: Cửa mở bất thường",
  );

  assert.equal(
    engine.buildAlarmTriggerFromSensorEvent({
      deviceType: "vibration",
      deviceName: "Rung cửa",
      oldDevice: { action: "vibration", last_vibration_at: 1 },
      updateData: { action: "vibration" },
    }).reason,
    "Rung cửa: Phát hiện rung/chấn động",
  );

  assert.equal(
    engine.buildAlarmTriggerFromSensorEvent({
      deviceType: "lock",
      deviceName: "Khóa cửa",
      oldDevice: { state: "LOCK" },
      updateData: { state: "UNLOCK" },
    }).reason,
    "Khóa cửa: Khóa đã mở",
  );
});

test("emergency status latch covers safety sensors and electrical faults", () => {
  const { engine } = createHarness();
  const update = { smoke: true };

  assert.equal(
    didEmergencyStatusTrigger("smoke", { smoke: false }, update),
    true,
  );
  assert.equal(
    didEmergencyStatusTrigger(
      "smart_plug",
      { over_current: false },
      { over_current: true },
    ),
    true,
  );
  assert.equal(
    engine.applyEmergencyStatusLatch(update, { smoke: false }, "smoke", 10),
    true,
  );
  assert.equal(update.emergency_triggered_at, 10);
  assert.equal(update.emergency_active_until, 10 + 5 * 60 * 1000);
});

test("packet debounce is scoped by receiver, device and event code", () => {
  const runtime = createHarness({ now: 10_000 });
  const base = {
    receiverUid: "member-a",
    ownerUid: "owner-a",
    homeId: "home-a",
    deviceId: "door-a",
    deviceType: "door",
    reason: "Cửa chính: Cửa mở bất thường",
  };

  assert.equal(runtime.engine.shouldAcceptSensorAlarmTrigger(base), true);
  assert.equal(runtime.engine.shouldAcceptSensorAlarmTrigger(base), false);
  assert.equal(
    runtime.engine.shouldAcceptSensorAlarmTrigger({
      ...base,
      reason: "Cửa chính: Thiết bị bị tháo",
    }),
    true,
  );
  assert.equal(
    runtime.engine.shouldAcceptSensorAlarmTrigger({
      ...base,
      deviceId: "door-b",
    }),
    true,
  );

  runtime.advance(SAME_ALARM_EVENT_MIN_INTERVAL_MS);
  assert.equal(runtime.engine.shouldAcceptSensorAlarmTrigger(base), true);
});

test("event controls persist latches, suppress repeats and rearm after safe state", async () => {
  const runtime = createHarness({ now: 1000 });
  const item = alarmItem();

  await runtime.engine.markAlarmItemsTriggered("member-a", [item]);
  assert.equal(runtime.databaseUpdates.length, 1);
  assert.equal(
    runtime.engine.filterNewAlarmItemsByEventControl(
      "member-a",
      [item],
      1001,
    ).length,
    0,
  );

  runtime.setNow(2000);
  await runtime.engine.releaseAlarmEventControlsForDeviceState({
    receiverUid: "member-a",
    ownerUid: "owner-a",
    homeId: "home-a",
    deviceId: "door-a",
    device: { contact: true },
  });

  assert.equal(runtime.databaseUpdates.length, 2);
  assert.equal(
    runtime.engine.filterNewAlarmItemsByEventControl(
      "member-a",
      [item],
      1000 + SAME_ALARM_EVENT_MIN_INTERVAL_MS - 1,
    ).length,
    0,
  );
  assert.equal(
    runtime.engine.filterNewAlarmItemsByEventControl(
      "member-a",
      [item],
      1000 + SAME_ALARM_EVENT_MIN_INTERVAL_MS,
    ).length,
    1,
  );
});

test("event acknowledgement extends cooldown without changing the condition identity", async () => {
  const runtime = createHarness({ now: 5000 });
  const item = alarmItem();

  await runtime.engine.markAlarmItemsTriggered("member-a", [item], 5000);
  await runtime.engine.markAlarmItemsAcknowledged(
    "member-a",
    [item],
    "member-a",
    10_000,
  );

  const latestUpdate = runtime.databaseUpdates.at(-1);
  const state = Object.values(latestUpdate)[0];

  assert.equal(state.acknowledgedBy, "member-a");
  assert.equal(state.acknowledgedAt, 10_000);
  assert.equal(
    state.cooldownUntil,
    10_000 + SAME_ALARM_EVENT_MIN_INTERVAL_MS,
  );
});
