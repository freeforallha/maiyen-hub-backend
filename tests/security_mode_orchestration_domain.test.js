"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSecurityModeOrchestrationDomain,
  getSecurityModeHomeKey,
} = require("../domains/security/security_mode_orchestration");

function keyFromPath(path) {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean);

  return parts.at(-1) || null;
}

function createSnapshot(db, path, value, key = keyFromPath(path)) {
  return {
    key,
    ref: db.ref(path),
    val: () => value,
    exists: () => value !== undefined && value !== null,
  };
}

function createFakeDb(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  const operations = [];

  function listenerKey(path, eventName) {
    return `${path}|${eventName}`;
  }

  function ref(rawPath = "") {
    const path = String(rawPath || "").replace(/^\/+|\/+$/g, "");

    return {
      path,
      on(eventName, handler) {
        const key = listenerKey(path, eventName);
        const handlers = listeners.get(key) || new Set();
        handlers.add(handler);
        listeners.set(key, handlers);
      },
      off(eventName, handler) {
        const key = listenerKey(path, eventName);
        const handlers = listeners.get(key);
        handlers?.delete(handler);
      },
      async once() {
        return createSnapshot(db, path, values.get(path));
      },
      async update(value) {
        operations.push({ type: "update", path, value });

        if (path === "") {
          for (const [childPath, childValue] of Object.entries(value)) {
            if (childValue === null) {
              values.delete(childPath);
            } else {
              values.set(childPath, childValue);
            }
          }
        }
      },
    };
  }

  const db = {
    ref,
    async emit(path, eventName, value, childKey = "") {
      const handlers = Array.from(
        listeners.get(listenerKey(path, eventName)) || [],
      );
      const snapshotPath = childKey
        ? [path, childKey].filter(Boolean).join("/")
        : path;
      const snapshot = createSnapshot(
        db,
        snapshotPath,
        value,
        childKey || keyFromPath(path),
      );

      await Promise.all(handlers.map((handler) => handler(snapshot)));
    },
    listenerCount(path, eventName) {
      return listeners.get(listenerKey(path, eventName))?.size || 0;
    },
    operations,
    values,
  };

  return db;
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(overrides = {}) {
  const nowValue = overrides.nowValue || 1_000_000;
  const initialHome = overrides.home || {
    name: "Nhà chính",
    securityMode: "normal",
    devices: {},
  };
  const db = overrides.db || createFakeDb({
    "accounts/owner/homes/h1": initialHome,
    "accounts/owner/alarmIncidents": {},
  });
  const timers = [];
  const starts = [];
  const resolvedPushes = [];
  const resolvedIncidents = [];
  const clearedOffline = [];
  const sirenCalls = [];
  const validations = [];
  const scheduleChecks = [];
  const clearedScheduleHomes = [];
  const logs = [];
  const offlineAlarmDemandMap = overrides.offlineAlarmDemandMap || new Map();

  const domain = createSecurityModeOrchestrationDomain({
    db,
    normalizeHomeSecurityMode: (value) => {
      return value === "armed" || value === "unprotected"
        ? value
        : "normal";
    },
    normalizeSecurityModeRepeatMinutes: (value) => Number(value || 0),
    getNextAlarmTimeText: (value) => `repeat:${value}`,
    isSecurityDeviceType:
      overrides.isSecurityDeviceType || ((type) => type === "door"),
    getUnsafeSecurityReason:
      overrides.getUnsafeSecurityReason ||
      ((name, type, device) => {
        return type === "door" && device.contact === false
          ? `${name} đang mở`
          : "";
      }),
    getAlarmReceiverUidsForHome:
      overrides.getAlarmReceiverUidsForHome || (() => ["receiver"]),
    getCachedAccountData: () => ({}),
    normalizeDeviceAlarmPolicy:
      overrides.normalizeDeviceAlarmPolicy ||
      (() => ({
        enabled: true,
        notificationEnabled: true,
        physicalSirenEnabled: true,
      })),
    resolveDeviceAlarmConfigurationForReceiver: async () => ({
      fullscreenEnabled: true,
    }),
    sensorEventSeverity: {
      ALARM: "alarm",
      EMERGENCY: "emergency",
    },
    sensorEventCategory: {
      SECURITY: "security",
      EMERGENCY: "emergency",
    },
    getAlarmIncidentTargetKey: (receiverUid, ownerUid, homeId, flow) => {
      return `${receiverUid}|${ownerUid}|${homeId}|${flow}`;
    },
    getActiveAlarmIncident:
      overrides.getActiveAlarmIncident || (async () => null),
    clearAlarmIncidentTimers: () => {},
    removeLocalActiveAlarmIncident: () => {},
    startOrMergeAlarmIncidents: async (receiverUid, items, options) => {
      starts.push({ receiverUid, items, options });
    },
    sendAlarmResolvedPush: async (payload) => {
      resolvedPushes.push(payload);
    },
    resolveAlarmIncidentForReceiver: async (payload) => {
      resolvedIncidents.push(payload);
      return true;
    },
    offlineAlarmDemandMap,
    clearOfflineAlarmDemand: (key) => {
      clearedOffline.push(key);
      offlineAlarmDemandMap.delete(key);
    },
    setPhysicalSirenForHome: async (...args) => {
      sirenCalls.push(args);
    },
    isEmergencyDeviceType:
      overrides.isEmergencyDeviceType || ((type) => type === "smoke"),
    getCurrentEmergencyReason:
      overrides.getCurrentEmergencyReason ||
      ((name, type, device) => {
        return type === "smoke" && device.smoke === true
          ? `${name} phát hiện khói`
          : "";
      }),
    getCachedHomeData:
      overrides.getCachedHomeData || (() => initialHome),
    validateSecurityIncidentsForHome: async (...args) => {
      validations.push(args);
    },
    clearScheduleAlarmRuntimeForHome: (...args) => {
      clearedScheduleHomes.push(args);
    },
    checkScheduledAlarms: async (options) => {
      scheduleChecks.push(options);
    },
    getCachedAccountsObject:
      overrides.getCachedAccountsObject ||
      (() => ({
        owner: {
          homes: {
            h1: initialHome,
          },
        },
      })),
    unprotectedTransientReplayWindowMs: 60_000,
    now: () => nowValue,
    setTimeoutFn: (handler, delay) => {
      const timer = {
        handler,
        delay,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    log: (...args) => logs.push(args),
  });

  async function runPendingTimers() {
    for (const timer of timers.splice(0)) {
      if (!timer.cleared) {
        timer.handler();
      }
    }

    await flushTasks();
  }

  return {
    clearedOffline,
    clearedScheduleHomes,
    db,
    domain,
    logs,
    offlineAlarmDemandMap,
    resolvedIncidents,
    resolvedPushes,
    runPendingTimers,
    scheduleChecks,
    sirenCalls,
    starts,
    timers,
    validations,
  };
}

test("security mode identity and unprotected normalization stay canonical", () => {
  assert.equal(getSecurityModeHomeKey(" owner ", " h1 "), "owner|h1");

  const harness = createHarness();
  assert.equal(
    harness.domain.isHomeUnprotected({ securityMode: "unprotected" }),
    true,
  );
  assert.equal(
    harness.domain.isHomeUnprotected({ securityMode: "armed" }),
    false,
  );
});

test("security mode orchestration starts once and detaches every listener", async () => {
  const harness = createHarness({
    home: { securityMode: "normal", devices: {} },
  });

  assert.equal(await harness.domain.startSecurityModeOrchestration(), true);
  assert.equal(await harness.domain.startSecurityModeOrchestration(), false);
  assert.equal(harness.db.listenerCount("accounts", "child_added"), 1);
  assert.equal(
    harness.db.listenerCount("accounts/owner/homes", "child_added"),
    1,
  );

  await harness.db.emit(
    "accounts/owner/homes",
    "child_added",
    { securityMode: "normal" },
    "h1",
  );
  assert.equal(
    harness.db.listenerCount(
      "accounts/owner/homes/h1/securityMode",
      "value",
    ),
    1,
  );

  assert.equal(harness.domain.stopSecurityModeOrchestration(), true);
  assert.equal(harness.domain.stopSecurityModeOrchestration(), false);
  assert.equal(harness.db.listenerCount("accounts", "child_added"), 0);
  assert.equal(
    harness.db.listenerCount(
      "accounts/owner/homes/h1/securityMode",
      "value",
    ),
    0,
  );
});

test("startup armed home schedules one security and emergency recheck", async () => {
  const home = {
    name: "Nhà chính",
    securityMode: "armed",
    devices: {},
  };
  const harness = createHarness({ home });

  await harness.domain.startSecurityModeOrchestration();
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 1000);

  await harness.runPendingTimers();
  assert.equal(harness.domain.getKnownMode("owner", "h1"), "armed");
  assert.equal(harness.timers.length, 0);
});

test("arming with an unsafe device supersedes the old security incident", async () => {
  const home = {
    name: "Nhà chính",
    securityMode: "armed",
    securityModeRepeatMinutes: 15,
    devices: {
      door1: {
        name: "Cửa chính",
        type: "door",
        contact: false,
      },
    },
  };
  const harness = createHarness({
    home,
    getActiveAlarmIncident: async () => ({
      incidentId: "old-incident",
      incident: {
        status: "active",
        flowType: "security",
      },
    }),
  });

  const result = await harness.domain.triggerAlarmForUnsafeStateOnArmed(
    "owner",
    "h1",
  );

  assert.equal(result, true);
  assert.equal(harness.starts.length, 1);
  assert.equal(harness.starts[0].items[0].alarmSource, "security_mode");
  assert.equal(harness.starts[0].items[0].repeatMinutes, 15);
  assert.equal(harness.resolvedPushes.length, 1);
  assert.equal(harness.resolvedPushes[0].incidentId, "old-incident");
  assert.equal(
    harness.db.operations[0].value[
      "accounts/receiver/alarmIncidents/old-incident/status"
    ],
    "superseded",
  );
});

test("unprotected mode resolves matching incidents and clears local demand", async () => {
  const offlineAlarmDemandMap = new Map([
    ["matching", { item: { ownerUid: "owner", homeId: "h1" } }],
    ["other", { item: { ownerUid: "owner", homeId: "h2" } }],
  ]);
  const db = createFakeDb({
    "accounts/owner/homes/h1": {
      securityMode: "unprotected",
      devices: {},
    },
    "accounts/receiver/alarmIncidents": {
      active: {
        status: "active",
        ownerUid: "owner",
        homeId: "h1",
      },
      foreign: {
        status: "active",
        ownerUid: "owner",
        homeId: "h2",
      },
    },
  });
  const harness = createHarness({
    db,
    offlineAlarmDemandMap,
    home: { securityMode: "unprotected", devices: {} },
  });

  const resolved = await harness.domain.resolveAllAlarmIncidentsForHome(
    "owner",
    "h1",
  );

  assert.equal(resolved, 1);
  assert.deepEqual(harness.clearedOffline, ["matching"]);
  assert.equal(harness.offlineAlarmDemandMap.has("other"), true);
  assert.equal(harness.resolvedIncidents[0].incidentId, "active");
  assert.deepEqual(harness.sirenCalls[0].slice(0, 3), [
    "owner",
    "h1",
    false,
  ]);
});

test("current emergency state is replayed only outside unprotected mode", async () => {
  const normalHome = {
    name: "Nhà chính",
    securityMode: "normal",
    devices: {
      smoke1: {
        name: "Báo khói",
        type: "smoke",
        smoke: true,
      },
    },
  };
  const harness = createHarness({ home: normalHome });

  assert.equal(
    await harness.domain.triggerEmergencyForCurrentUnsafeState(
      "owner",
      "h1",
    ),
    true,
  );
  assert.equal(harness.starts.length, 1);
  assert.equal(harness.starts[0].items[0].severity, "emergency");
  assert.equal(
    harness.starts[0].items[0].alarmSource,
    "emergency_sensor",
  );

  harness.db.values.set("accounts/owner/homes/h1", {
    ...normalHome,
    securityMode: "unprotected",
  });
  assert.equal(
    await harness.domain.triggerEmergencyForCurrentUnsafeState(
      "owner",
      "h1",
    ),
    false,
  );
  assert.equal(harness.starts.length, 1);
});

test("leaving unprotected validates security and rechecks emergency schedules", async () => {
  const harness = createHarness({
    home: { securityMode: "normal", devices: {} },
    getCachedAccountsObject: () => ({}),
  });

  harness.domain.handleModeValue("owner", "h1", "unprotected");
  assert.equal(harness.clearedScheduleHomes.length, 1);

  harness.domain.handleModeValue("owner", "h1", "normal");
  await flushTasks();

  assert.equal(harness.validations.length, 1);
  assert.equal(harness.validations[0][2], "security_mode_normal");
  assert.equal(harness.scheduleChecks.length, 1);
  assert.equal(
    harness.scheduleChecks[0].reason,
    "leave_unprotected_recheck",
  );
});

test("removed homes and accounts release their security mode runtime", async () => {
  const harness = createHarness({
    getCachedAccountsObject: () => ({}),
  });

  await harness.domain.startSecurityModeOrchestration();
  await harness.db.emit(
    "accounts",
    "child_added",
    { homes: {} },
    "owner",
  );
  await harness.db.emit(
    "accounts/owner/homes",
    "child_added",
    { securityMode: "normal" },
    "h1",
  );
  await harness.db.emit(
    "accounts/owner/homes/h1/securityMode",
    "value",
    "normal",
  );

  assert.equal(harness.domain.getRuntimeState().knownHomes, 1);

  await harness.db.emit(
    "accounts/owner/homes",
    "child_removed",
    null,
    "h1",
  );
  assert.equal(harness.domain.getRuntimeState().knownHomes, 0);

  await harness.db.emit("accounts", "child_removed", null, "owner");
  assert.equal(harness.domain.getRuntimeState().accountListeners, 0);
});
