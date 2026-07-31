"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  buildDeviceFirebaseUpdate,
  firebaseUpdateContainsTelemetry,
  updatePersistedTelemetrySnapshot,
} = require("../firebase_write_policy");
const {
  isActiveSignal,
  isVibrationAction,
  isGlassBreakAction,
  normalizeLockState,
  inferDeviceTypeFromPayload,
} = require("../domains/devices/device_profile");
const {
  createMqttDeviceIngestionDomain,
} = require("../domains/devices/mqtt_device_ingestion");

function snapshot(value, exists = value !== undefined && value !== null) {
  return {
    val: () => value,
    exists: () => exists,
  };
}

function createHarness(overrides = {}) {
  const client = overrides.client || new EventEmitter();
  const writes = [];
  const removals = [];
  const notifications = [];
  const alarmCalls = [];
  const validations = [];
  const queued = [];
  const logs = [];
  const paths = new Map();
  const deviceMap = overrides.deviceMap || {};
  const homes = overrides.homes || {};

  const db = {
    ref(path) {
      return {
        async once() {
          return snapshot(paths.get(path));
        },
        async update(value) {
          writes.push({ path, value: { ...value } });
          const previous = paths.get(path) || {};
          paths.set(path, { ...previous, ...value });
        },
        async remove() {
          removals.push(path);
          paths.delete(path);
        },
      };
    },
  };

  const domain = createMqttDeviceIngestionDomain({
    client,
    db,
    deviceMap,
    getFirebaseConnected: () => overrides.firebaseConnected !== false,
    getCachedHomeData: (uid, homeId) => homes[`${uid}|${homeId}`] || null,
    applyDeviceUpdateToLocalCache: (uid, homeId, deviceId, update) => {
      const key = `${uid}|${homeId}`;
      const home = homes[key] || { name: homeId, devices: {} };
      const device = home.devices?.[deviceId] || {};
      homes[key] = {
        ...home,
        devices: {
          ...(home.devices || {}),
          [deviceId]: { ...device, ...update },
        },
      };
      return homes[key];
    },
    enqueueOfflineFirebaseUpdate: (path, value) => {
      queued.push({ path, value: { ...value } });
    },
    buildDeviceFirebaseUpdate,
    firebaseUpdateContainsTelemetry,
    updatePersistedTelemetrySnapshot,
    isActiveSignal,
    isVibrationAction,
    isGlassBreakAction,
    normalizeLockState,
    inferDeviceTypeFromPayload,
    applyEmergencyStatusLatch: overrides.applyEmergencyStatusLatch || (() => false),
    scheduleEmergencyStatusClear: () => {},
    scheduleSosStateClear: () => {},
    scheduleVibrationStateClear: () => {},
    cancelVibrationStateClear: () => {},
    getHomeSirenRuntime: overrides.getHomeSirenRuntime || (() => null),
    setPhysicalSirenForHome: overrides.setPhysicalSirenForHome || (async () => {}),
    validateSecurityIncidentsForHome: async (...args) => {
      validations.push(args);
    },
    isPersistentEmergencyIncidentItem:
      overrides.isPersistentEmergencyIncidentItem || (() => false),
    isEmergencyIncidentItemStillUnsafe:
      overrides.isEmergencyIncidentItemStillUnsafe || (() => null),
    resolveClearedPersistentEmergencyIncidents: async () => {},
    addDeviceNotification: async (...args) => {
      notifications.push(args);
    },
    getAlarmReceiverUidsForHome:
      overrides.getAlarmReceiverUidsForHome || (() => ["owner"]),
    processScheduleAlarmsForOwner: async (...args) => {
      alarmCalls.push(args);
    },
    reconcileOfflineAlarmDemandsForHome: async () => {},
    emergencyStatusHoldMs: 300000,
    vibrationActiveWindowMs: 15000,
    coValuePersistIntervalMs: 30000,
    coTelemetryPersistIntervalMs: 60000,
    deviceTelemetryPersistIntervalMs: 60000,
    log: (...args) => logs.push(args),
  });

  return {
    alarmCalls,
    client,
    deviceMap,
    domain,
    homes,
    logs,
    notifications,
    paths,
    queued,
    removals,
    validations,
    writes,
  };
}

function message(value) {
  return Buffer.from(JSON.stringify(value));
}

test("CO payload detection and telemetry comparison remain deterministic", () => {
  const { domain } = createHarness();

  assert.equal(domain.isCarbonMonoxidePayload({ co: 12 }), true);
  assert.equal(domain.isCarbonMonoxidePayload({ co_alarm: false }), true);
  assert.equal(domain.isCarbonMonoxidePayload({ temperature: 20 }), false);
  assert.equal(domain.telemetryValueChanged("12", 12), false);
  assert.equal(domain.telemetryValueChanged(12, 13), true);
  assert.equal(domain.telemetryValueChanged("online", "offline"), true);
  assert.equal(domain.telemetryValueChanged("x", undefined), false);
});

test("MQTT ingestion listener starts once and can be stopped", () => {
  const { client, domain } = createHarness();

  assert.equal(domain.startMqttDeviceIngestion(), true);
  assert.equal(domain.startMqttDeviceIngestion(), false);
  assert.equal(client.listenerCount("message"), 1);
  assert.equal(domain.getRuntimeState().started, true);

  assert.equal(domain.stopMqttDeviceIngestion(), true);
  assert.equal(domain.stopMqttDeviceIngestion(), false);
  assert.equal(client.listenerCount("message"), 0);
  assert.equal(domain.getRuntimeState().started, false);
});

test("availability updates cache and Firebase only when state changes", async () => {
  const homes = {
    "u1|h1": {
      name: "Home",
      devices: {
        d1: { type: "door", availability: "offline" },
      },
    },
  };
  const harness = createHarness({
    deviceMap: { d1: { uid: "u1", homeId: "h1" } },
    homes,
  });

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/d1/availability",
    message({ state: "online" }),
  );

  assert.equal(homes["u1|h1"].devices.d1.availability, "online");
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].value.availability, "online");

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/d1/availability",
    message({ state: "online" }),
  );

  assert.equal(harness.writes.length, 1);
});

test("availability resolves a missing device map and removes stale index entries", async () => {
  const harness = createHarness({ deviceMap: {}, homes: {} });
  harness.paths.set("system/devices_by_ieee/d2", {
    uid: "u2",
    homeId: "h2",
  });
  harness.paths.set(
    "accounts/u2/homes/h2/devices/d2",
    null,
  );

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/d2/availability",
    message("online"),
  );

  assert.equal(harness.deviceMap.d2, undefined);
  assert.deepEqual(harness.removals, ["system/devices_by_ieee/d2"]);
});

test("door state packet persists the edge, validates incidents and fans out Alarm", async () => {
  const homes = {
    "u1|h1": {
      name: "Nhà chính",
      devices: {
        d1: {
          name: "Cửa chính",
          type: "door",
          contact: true,
          tamper: false,
          updated_at: 0,
        },
      },
    },
  };
  const harness = createHarness({
    deviceMap: { d1: { uid: "u1", homeId: "h1" } },
    homes,
    getAlarmReceiverUidsForHome: () => ["u1", "u2"],
  });

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/d1",
    message({ contact: false, last_seen: "2026-07-31T10:00:00Z" }),
  );

  assert.equal(homes["u1|h1"].devices.d1.contact, false);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].value.contact, false);
  assert.ok(Number(harness.writes[0].value.last_event) > 0);
  assert.equal(harness.validations.length, 1);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0][3], "Cửa mở");
  assert.equal(harness.alarmCalls.length, 2);
  assert.deepEqual(
    harness.alarmCalls.map((args) => args[0]),
    ["u1", "u2"],
  );
});

test("repeated telemetry packet does not write Firebase before the interval", async () => {
  const homes = {
    "u1|h1": {
      name: "Home",
      devices: {
        d1: {
          name: "Nhiệt độ",
          type: "temperature",
          temperature: 25,
          last_seen: "old",
          updated_at: 0,
        },
      },
    },
  };
  const harness = createHarness({
    deviceMap: { d1: { uid: "u1", homeId: "h1" } },
    homes,
    getAlarmReceiverUidsForHome: () => [],
  });

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/d1",
    message({ temperature: 26, last_seen: "new" }),
  );
  const firstWriteCount = harness.writes.length;

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/d1",
    message({ temperature: 26, last_seen: "new" }),
  );

  assert.equal(firstWriteCount, 1);
  assert.equal(harness.writes.length, 1);
  assert.equal(
    harness.domain.getRuntimeState().persistenceRuntimeCount,
    1,
  );
});

test("device alarm field is persisted only for a physical siren", async () => {
  const homes = {
    "u1|h1": {
      name: "Home",
      devices: {
        door1: { name: "Door", type: "door", alarm: { legacy: true } },
        siren1: { name: "Siren", type: "siren", alarm: false },
      },
    },
  };
  const harness = createHarness({
    deviceMap: {
      door1: { uid: "u1", homeId: "h1" },
      siren1: { uid: "u1", homeId: "h1" },
    },
    homes,
    getAlarmReceiverUidsForHome: () => [],
  });

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/door1",
    message({ alarm: true }),
  );
  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/siren1",
    message({ alarm: true }),
  );

  const doorWrite = harness.writes.find((entry) => entry.path.includes("door1"));
  const sirenWrite = harness.writes.find((entry) => entry.path.includes("siren1"));

  assert.equal(doorWrite, undefined);
  assert.equal(sirenWrite.value.alarm, true);
  assert.equal(sirenWrite.value.siren_command_status, "reported_on");
  assert.ok(Number(sirenWrite.value.last_siren_report_at) > 0);
});

test("CO alarm edge is persisted immediately and delivered to every receiver", async () => {
  const homes = {
    "u1|h1": {
      name: "Home",
      devices: {
        co1: {
          name: "CO",
          type: "carbon_monoxide",
          carbon_monoxide: false,
          co_alarm: false,
          co: 0,
        },
      },
    },
  };
  const harness = createHarness({
    deviceMap: { co1: { uid: "u1", homeId: "h1" } },
    homes,
    getAlarmReceiverUidsForHome: () => ["u1", "u2"],
  });

  await harness.domain.handleMqttDeviceMessage(
    "zigbee2mqtt/co1",
    message({ carbon_monoxide: true, co: 42, last_seen: "now" }),
  );

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].value.carbon_monoxide, true);
  assert.equal(harness.writes[0].value.co, 42);
  assert.ok(Number(harness.writes[0].value.emergency_active_until) > Date.now());
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0][3], /Phát hiện khí CO/);
  assert.equal(harness.alarmCalls.length, 2);
  assert.equal(harness.domain.getRuntimeState().coRuntimeCount, 1);
  assert.equal(harness.domain.getRuntimeState().coQueueCount, 0);
});
