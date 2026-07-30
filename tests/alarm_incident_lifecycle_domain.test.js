"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAlarmIncidentLifecycle,
} = require("../domains/alarm/alarm_incident_lifecycle");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMemoryDb(initial = {}) {
  const data = new Map(Object.entries(initial));
  const updates = [];
  const removals = [];

  return {
    data,
    updates,
    removals,
    ref(path) {
      return {
        async once() {
          return {
            val() {
              return data.get(path) ?? null;
            },
          };
        },
        async update(value) {
          const current = data.get(path) || {};
          data.set(path, { ...current, ...value });
          updates.push({ path, value });
        },
        async remove() {
          data.delete(path);
          removals.push(path);
        },
      };
    },
  };
}

function makeRuntime({ db = createMemoryDb(), ...overrides } = {}) {
  const state = {
    alarmIncidentTimerMap: {},
    alarmIncidentAdvanceInProgress: new Set(),
    alarmIncidentStartPromiseMap: new Map(),
    alarmIncidentQueuedStageMap: new Map(),
    alarmIncidentStageRetryCountMap: new Map(),
  };
  const calls = {
    localActive: [],
    sent: [],
    siren: [],
    expired: [],
    repeats: [],
  };

  const runtime = createAlarmIncidentLifecycle({
    db,
    ...state,
    getAlarmIncidentTimerKey: (uid, incidentId) => `${uid}_${incidentId}`,
    getAlarmStagePriority: (stage) => ({
      detected: 0,
      notification: 0,
      alarm: 1,
      siren: 2,
      fullscreen_siren: 2,
      calling: 3,
    })[stage] ?? -1,
    getAlarmStageRetryKey: (uid, incidentId, stage) =>
      `${uid}_${incidentId}_${stage}`,
    normalizeAlarmIncidentItems: (items) => Array.isArray(items)
      ? items.filter((item) => item && item.homeId && item.reason)
      : [],
    getAlarmIncidentItemIdentity: (item) =>
      [item.homeId, item.deviceId, item.type, item.reason].join("|"),
    getAlarmIncidentRuntimePreferences: () => ({
      notificationEnabled: true,
      fullscreenEnabled: true,
      physicalSirenEnabled: true,
    }),
    setLocalActiveAlarmIncident: (...args) => calls.localActive.push(args),
    validateAndResolveSecurityIncident: async (_uid, _id, incident) => ({
      active: true,
      items: Array.isArray(incident.items) ? incident.items : [],
    }),
    sendAlarmStageSummary: async (...args) => {
      calls.sent.push(args);
      return true;
    },
    isAlarmItemAllowedByCurrentHomeMode: async () => true,
    requestPhysicalSirenForIncident: async (...args) => {
      calls.siren.push(args);
    },
    expireAlarmIncident: async (...args) => {
      calls.expired.push(args);
    },
    scheduleSecurityModeRepeatTimer: (...args) => calls.repeats.push(args),
    alarmStageRetryDelayMs: 5,
    alarmStageMaxRetryCount: 2,
    alarmIncidentAutoExpireMs: 50,
    alarmIncidentCallDelayMs: 20,
    emergencyCallDelayMs: 10,
    iosTimeSensitiveAlertsEnabled: true,
    iosCriticalAlertsEnabled: true,
    ...overrides,
  });

  return { runtime, state, calls, db };
}

test("delivery identities are deterministic and APNs policy remains stable", () => {
  const { runtime } = makeRuntime();
  const items = [
    { homeId: "home", deviceId: "b", type: "door", reason: "Open" },
    { homeId: "home", deviceId: "a", type: "smoke", reason: "Smoke" },
  ];
  const reversed = [...items].reverse();

  const first = runtime.getMaiYenAlarmDeliveryId({
    uid: "u1",
    incidentId: "i1",
    stage: "alarm",
    flowType: "security",
    items,
  });
  const second = runtime.getMaiYenAlarmDeliveryId({
    uid: "u1",
    incidentId: "i1",
    stage: "alarm",
    flowType: "security",
    items: reversed,
  });

  assert.equal(first, second);
  assert.notEqual(
    first,
    runtime.getMaiYenAlarmDeliveryId({
      uid: "u1",
      incidentId: "i1",
      stage: "siren",
      flowType: "security",
      items,
    }),
  );

  const apns = runtime.buildMaiYenAlarmApnsConfig({
    uid: "u1",
    incidentId: "i1",
    homeId: "home/1",
    flowType: "emergency",
    stage: "fullscreen_siren",
    title: "Danger",
    body: "Smoke",
    playSound: true,
  });

  assert.equal(apns.headers["apns-priority"], "10");
  assert.equal(apns.payload.aps["interruption-level"], "critical");
  assert.equal(apns.payload.aps.sound.critical, true);
  assert.equal(apns.payload.aps.threadId, "safehome_alarm_home_1");
});

test("timer cleanup removes every slot and all retry counters for one incident", () => {
  const { runtime, state } = makeRuntime();
  const key = "u1_i1";
  state.alarmIncidentTimerMap[key] = {
    alarm: setTimeout(() => {}, 1000),
    expire: setTimeout(() => {}, 1000),
  };
  state.alarmIncidentStageRetryCountMap.set("u1_i1_alarm", 1);
  state.alarmIncidentStageRetryCountMap.set("u1_i1_siren", 2);
  state.alarmIncidentStageRetryCountMap.set("u2_i2_alarm", 1);

  runtime.clearAlarmIncidentTimers("u1", "i1");

  assert.equal(state.alarmIncidentTimerMap[key], undefined);
  assert.equal(state.alarmIncidentStageRetryCountMap.has("u1_i1_alarm"), false);
  assert.equal(state.alarmIncidentStageRetryCountMap.has("u1_i1_siren"), false);
  assert.equal(state.alarmIncidentStageRetryCountMap.has("u2_i2_alarm"), true);
});

test("incident start lock serializes the same target but releases after completion", async () => {
  const { runtime } = makeRuntime();
  const order = [];

  const first = runtime.withAlarmIncidentStartLock("target", async () => {
    order.push("first-start");
    await wait(15);
    order.push("first-end");
  });
  const second = runtime.withAlarmIncidentStartLock("target", async () => {
    order.push("second-start");
    order.push("second-end");
  });

  await Promise.all([first, second]);

  assert.deepEqual(order, [
    "first-start",
    "first-end",
    "second-start",
    "second-end",
  ]);
});

test("active incident lookup repairs stale target indexes and restores local state", async () => {
  const db = createMemoryDb({
    "accounts/u1/activeAlarmIncidentByTarget/t1": "i1",
    "accounts/u1/alarmIncidents/i1": {
      status: "active",
      homeId: "home",
      items: [],
    },
    "accounts/u1/activeAlarmIncidentByTarget/stale": "gone",
  });
  const { runtime, calls } = makeRuntime({ db });

  const active = await runtime.getActiveAlarmIncident("u1", "t1");
  const stale = await runtime.getActiveAlarmIncident("u1", "stale");

  assert.equal(active.incidentId, "i1");
  assert.equal(calls.localActive.length, 1);
  assert.equal(stale, null);
  assert.deepEqual(db.removals, [
    "accounts/u1/activeAlarmIncidentByTarget/stale",
  ]);
});

test("security incident advances through alarm and siren only after successful delivery", async () => {
  const incidentPath = "accounts/u1/alarmIncidents/i1";
  const db = createMemoryDb({
    [incidentPath]: {
      status: "active",
      flowType: "security",
      stage: "detected",
      homeId: "home",
      physicalSirenEnabled: true,
      fullscreenEnabled: true,
      items: [
        {
          homeId: "home",
          deviceId: "door",
          type: "door",
          reason: "Door open",
          notificationEnabled: true,
          fullscreenEnabled: true,
        },
      ],
    },
  });
  const { runtime, calls } = makeRuntime({ db });

  await runtime.advanceAlarmIncidentToStage("u1", "i1", "siren");

  const finalIncident = db.data.get(incidentPath);
  assert.equal(finalIncident.stage, "siren");
  assert.equal(calls.sent.length, 2);
  assert.equal(calls.sent[0][2].stage, "alarm");
  assert.equal(calls.sent[1][2].stage, "siren");
  assert.equal(calls.siren.length, 1);
});

test("stage retry is bounded and clears its timer slot after execution", async () => {
  const incidentPath = "accounts/u1/alarmIncidents/i1";
  const db = createMemoryDb({
    [incidentPath]: {
      status: "active",
      flowType: "security",
      stage: "detected",
      homeId: "home",
      items: [
        { homeId: "home", deviceId: "d", type: "door", reason: "Open" },
      ],
    },
  });
  let sends = 0;
  const { runtime, state } = makeRuntime({
    db,
    sendAlarmStageSummary: async () => {
      sends++;
      return sends > 1;
    },
  });

  await runtime.advanceAlarmIncidentToStage("u1", "i1", "alarm");
  assert.equal(state.alarmIncidentStageRetryCountMap.get("u1_i1_alarm"), 1);

  await wait(25);

  assert.equal(db.data.get(incidentPath).stage, "alarm");
  assert.equal(state.alarmIncidentStageRetryCountMap.has("u1_i1_alarm"), false);
  assert.equal(state.alarmIncidentTimerMap.u1_i1.retry_alarm, undefined);
});

test("stage scheduling preserves emergency and security timing contracts", async () => {
  const { runtime, state, calls } = makeRuntime();
  const now = Date.now();

  runtime.scheduleAlarmIncidentStages("u1", "security", {
    status: "active",
    flowType: "security",
    detectedAt: now,
    alarmDueAt: now + 1000,
    sirenDueAt: now + 1000,
    callDueAt: now + 1000,
    expireAt: now + 1000,
    fullscreenEnabled: true,
    physicalSirenEnabled: true,
  });
  assert.ok(state.alarmIncidentTimerMap.u1_security.alarm);
  assert.ok(state.alarmIncidentTimerMap.u1_security.siren);
  assert.ok(state.alarmIncidentTimerMap.u1_security.calling);
  assert.ok(state.alarmIncidentTimerMap.u1_security.expire);
  assert.equal(calls.repeats.length, 1);
  runtime.clearAlarmIncidentTimers("u1", "security");

  runtime.scheduleAlarmIncidentStages("u1", "emergency", {
    status: "active",
    flowType: "emergency",
    detectedAt: now,
    fullscreenDueAt: now + 1000,
    callDueAt: now + 1000,
    expireAt: now + 1000,
    fullscreenEnabled: true,
    physicalSirenEnabled: true,
  });
  assert.ok(state.alarmIncidentTimerMap.u1_emergency.fullscreenSiren);
  assert.ok(state.alarmIncidentTimerMap.u1_emergency.calling);
  assert.ok(state.alarmIncidentTimerMap.u1_emergency.expire);
  runtime.clearAlarmIncidentTimers("u1", "emergency");
});
