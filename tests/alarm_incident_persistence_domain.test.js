"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAlarmIncidentPersistence,
} = require("../domains/alarm/alarm_incident_persistence");

function createMemoryDb(initial = {}) {
  const data = new Map(Object.entries(initial));
  const updates = [];
  let nextId = 1;

  return {
    data,
    updates,
    ref(path = "") {
      return {
        push() {
          return { key: `incident-${nextId++}` };
        },
        async once() {
          return {
            val() {
              return data.get(path) ?? null;
            },
          };
        },
        async update(value) {
          updates.push({ path, value });

          if (path === "") {
            for (const [childPath, childValue] of Object.entries(value)) {
              if (childValue === null) {
                data.delete(childPath);
              } else {
                data.set(childPath, childValue);
              }
            }
            return;
          }

          const current = data.get(path);
          data.set(path, {
            ...(current && typeof current === "object" ? current : {}),
            ...value,
          });
        },
      };
    },
  };
}

function normalizeItems(items) {
  return Array.isArray(items)
    ? items.filter((item) => item && item.homeId && item.reason)
    : [];
}

function itemIdentity(item) {
  return [
    item.ownerUid,
    item.homeId,
    item.deviceId,
    item.type,
    item.reason,
    item.alarmSource,
  ].join("|");
}

function makeRuntime(overrides = {}) {
  const db = overrides.db || createMemoryDb();
  const activeByTarget = new Map();
  const calls = {
    triggered: [],
    acknowledged: [],
    localSet: [],
    localRemove: [],
    delivered: [],
    summaries: [],
    scheduled: [],
    expireTimers: [],
    reconciled: [],
    notifications: [],
    resolvedPushes: [],
    clearedTimers: [],
    retries: [],
    advanced: [],
    logs: [],
  };

  const dependencies = {
    db,
    normalizeAlarmIncidentItems: normalizeItems,
    getAlarmIncidentFlowType: (items) =>
      normalizeItems(items).some((item) =>
        ["smoke", "sos", "gas", "co", "water"].includes(item.type),
      )
        ? "emergency"
        : "security",
    getAlarmIncidentTargetKey: (uid, ownerUid, homeId, flowType) =>
      `${uid}|${ownerUid}|${homeId}|${flowType}`,
    withAlarmIncidentStartLock: async (_key, task) => task(),
    normalizePreferredSecurityIncidentItems: normalizeItems,
    evaluateSecurityIncident: async (_uid, incident) => ({
      active: true,
      items: normalizeItems(incident.items),
      reason: "active",
    }),
    isAlarmItemAllowedByCurrentHomeMode: async () => true,
    isScheduledAlarmSource: (source) =>
      String(source || "").includes("schedule"),
    canReceiveAlarm: async () => true,
    getActiveAlarmIncident: async (_uid, targetKey) =>
      activeByTarget.get(targetKey) || null,
    getAlarmIncidentItemIdentity: itemIdentity,
    normalizeRepeatMinutes: (value) => Math.max(0, Number(value) || 0),
    buildStandardIncidentFields: (flowType, statusReason) => ({
      schemaVersion: 3,
      eventCategory: flowType,
      alarmLevel: flowType === "emergency" ? "danger" : "warning",
      severity: flowType === "emergency" ? "danger" : "warning",
      statusReason,
    }),
    markAlarmItemsTriggered: async (...args) => calls.triggered.push(args),
    ensureSecurityModeRepeatForIncident: async (_uid, _id, incident) => incident,
    deliverSecurityAlarmChannelsImmediately: async (...args) =>
      calls.delivered.push(args),
    isPersistentEmergencyIncidentItem: (item) => item.type !== "sos",
    getAlarmIncidentExpireDelayMs: (flowType, items) =>
      flowType === "emergency" && normalizeItems(items).every((i) => i.type === "sos")
        ? 300000
        : 1800000,
    rescheduleAlarmIncidentExpireTimer: (...args) => calls.expireTimers.push(args),
    sendAlarmStageSummary: async (...args) => {
      calls.summaries.push(args);
      return true;
    },
    scheduleInitialAlarmIncidentPushRetry: (...args) => calls.retries.push(args),
    reconcilePhysicalSirenForHome: async (...args) => calls.reconciled.push(args),
    clearAlarmIncidentTimers: (...args) => calls.clearedTimers.push(args),
    removeLocalActiveAlarmIncident: (...args) => calls.localRemove.push(args),
    filterNewAlarmItemsByEventControl: (_uid, items) => normalizeItems(items),
    setLocalActiveAlarmIncident: (uid, incidentId, incident) => {
      calls.localSet.push([uid, incidentId, incident]);
      if (incident && incident.targetKey) {
        activeByTarget.set(incident.targetKey, { incidentId, incident });
      }
    },
    getSecurityModeItems: () => [],
    getCachedHomeData: () => ({ name: "Test Home", securityMode: "normal" }),
    normalizeSecurityModeRepeatMinutes: (value) => Math.max(0, Number(value) || 0),
    applySecurityModeRepeatToItems: (items, repeatMinutes) =>
      normalizeItems(items).map((item) => ({ ...item, repeatMinutes })),
    getLegacyIncidentSeverity: (flowType) =>
      flowType === "emergency" ? "danger" : "warning",
    getStandardIncidentEventCategory: (flowType) => flowType,
    getStandardIncidentAlarmLevel: (flowType) =>
      flowType === "emergency" ? "danger" : "warning",
    getEmergencyIncidentTitle: () => "Emergency",
    addHomeNotificationFromBackend: async (payload) =>
      calls.notifications.push(payload),
    resetAlarmStageRetry: (...args) => calls.retries.push(["reset", ...args]),
    advanceAlarmIncidentToStage: async (...args) => calls.advanced.push(args),
    scheduleAlarmIncidentStages: (...args) => calls.scheduled.push(args),
    getCachedAccountsObject: () => ({}),
    isHomeUnprotected: () => false,
    validateAndResolveSecurityIncident: async (_uid, _id, incident) => ({
      active: true,
      items: normalizeItems(incident.items),
    }),
    getIncidentResolutionType: (resolvedBy) =>
      resolvedBy === "u1" || resolvedBy === "u2" ? "manual" : "automatic",
    markAlarmItemsAcknowledged: async (...args) => calls.acknowledged.push(args),
    hasLocalActiveAlarmIncidentForReceiver: () => false,
    sendAlarmResolvedPush: async (payload) => calls.resolvedPushes.push(payload),
    getAlarmReceiverUidsForHome: () => ["u1"],
    getCachedAccountData: () => null,
    alarmIncidentSchemaVersion: 3,
    emergencyMergeWindowMs: 10000,
    alarmIncidentCallDelayMs: 60000,
    emergencyCallDelayMs: 35000,
    log: (...args) => calls.logs.push(args),
    ...overrides,
  };

  const runtime = createAlarmIncidentPersistence(dependencies);

  return { runtime, calls, db, activeByTarget, dependencies };
}

function makeItem(overrides = {}) {
  return {
    ownerUid: "owner",
    homeId: "home",
    homeName: "Test Home",
    deviceId: "device",
    deviceName: "Device",
    type: "smoke",
    reason: "Smoke detected",
    alarmSource: "device_event",
    notificationEnabled: true,
    physicalSirenEnabled: true,
    fullscreenEnabled: true,
    ...overrides,
  };
}

test("new emergency incident is persisted atomically and delivery starts immediately", async () => {
  const { runtime, db, calls } = makeRuntime();

  await runtime.startOrMergeAlarmIncidents(
    "u1",
    [makeItem()],
    { bypassEventControl: true },
  );

  const rootUpdate = db.updates.find((entry) => entry.path === "");
  assert.ok(rootUpdate);
  const incidentPath = Object.keys(rootUpdate.value).find((path) =>
    path.includes("/alarmIncidents/incident-1"),
  );
  const targetPath = Object.keys(rootUpdate.value).find((path) =>
    path.includes("/activeAlarmIncidentByTarget/"),
  );
  assert.ok(incidentPath);
  assert.ok(targetPath);
  assert.equal(rootUpdate.value[incidentPath].status, "active");
  assert.equal(rootUpdate.value[incidentPath].stage, "notification");
  assert.equal(calls.triggered.length, 1);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.summaries.length, 1);
  assert.deepEqual(calls.advanced[0], ["u1", "incident-1", "fullscreen_siren"]);
  assert.equal(calls.scheduled.length, 1);
});

test("active emergency incident merges a new sensor and extends expiry", async () => {
  const now = Date.now();
  const existing = {
    incidentId: "i1",
    targetKey: "u1|owner|home|emergency",
    receiverUid: "u1",
    ownerUid: "owner",
    homeId: "home",
    flowType: "emergency",
    status: "active",
    stage: "fullscreen_siren",
    detectedAt: now - 1000,
    items: [makeItem()],
  };
  const { runtime, db, calls, activeByTarget } = makeRuntime();
  activeByTarget.set(existing.targetKey, { incidentId: "i1", incident: existing });

  await runtime.startOrMergeAlarmIncidents(
    "u1",
    [makeItem({ deviceId: "gas", type: "gas", reason: "Gas detected" })],
    { bypassEventControl: true },
  );

  const update = db.updates.find((entry) =>
    entry.path === "accounts/u1/alarmIncidents/i1",
  );
  assert.ok(update);
  assert.equal(update.value.items.length, 2);
  assert.ok(update.value.expireAt > now);
  assert.equal(calls.triggered.length, 1);
  assert.equal(calls.expireTimers.length, 1);
  assert.equal(calls.summaries.length, 1);
  assert.equal(calls.reconciled.length, 1);
});

test("resume repairs schema and schedules one active incident", async () => {
  const incident = {
    incidentId: "i1",
    receiverUid: "u1",
    ownerUid: "owner",
    homeId: "home",
    flowType: "security",
    status: "active",
    stage: "detected",
    schemaVersion: 1,
    eventCategory: "legacy",
    alarmLevel: "legacy",
    items: [makeItem({ type: "door", reason: "Door open" })],
  };
  const db = createMemoryDb({
    "accounts/u1/alarmIncidents/i1": incident,
  });
  const { runtime, calls } = makeRuntime({
    db,
    getCachedAccountsObject: () => ({
      u1: { alarmIncidents: { i1: incident } },
    }),
  });

  await runtime.resumeActiveAlarmIncidents();

  assert.ok(db.updates.some((entry) =>
    entry.path === "accounts/u1/alarmIncidents/i1",
  ));
  assert.equal(calls.localSet.length, 1);
  assert.equal(calls.scheduled.length, 1);
  assert.equal(
    calls.logs.filter((entry) => entry[0] === "🚨 ACTIVE ALARM INCIDENTS RESUMED:").length,
    1,
  );
});

test("manual resolve persists canonical fields and clears the target index", async () => {
  const incident = {
    incidentId: "i1",
    targetKey: "target",
    receiverUid: "u1",
    ownerUid: "owner",
    homeId: "home",
    homeName: "Test Home",
    flowType: "security",
    status: "active",
    items: [makeItem({ type: "door", reason: "Door open" })],
  };
  const db = createMemoryDb({
    "accounts/u1/alarmIncidents/i1": incident,
  });
  const { runtime, calls } = makeRuntime({ db });

  const resolved = await runtime.resolveAlarmIncidentForReceiver({
    receiverUid: "u1",
    incidentId: "i1",
    ownerUid: "owner",
    homeId: "home",
    resolvedBy: "u1",
    action: "user_resolved",
  });

  assert.equal(resolved, true);
  const rootUpdate = db.updates.find((entry) => entry.path === "");
  assert.equal(
    rootUpdate.value["accounts/u1/alarmIncidents/i1/status"],
    "resolved",
  );
  assert.equal(
    rootUpdate.value["accounts/u1/activeAlarmIncidentByTarget/target"],
    null,
  );
  assert.equal(calls.acknowledged.length, 1);
  assert.equal(calls.reconciled.length, 1);
  assert.equal(calls.clearedTimers.length, 1);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.resolvedPushes.length, 1);
});

test("home group resolve finds active copies and resolves each receiver", async () => {
  const base = {
    incidentId: "i1",
    targetKey: "target",
    ownerUid: "owner",
    homeId: "home",
    flowType: "security",
    status: "active",
    items: [makeItem({ type: "door", reason: "Door open" })],
  };
  const db = createMemoryDb({
    "accounts/u1/alarmIncidents/i1": { ...base, receiverUid: "u1" },
    "accounts/u2/alarmIncidents/i2": {
      ...base,
      incidentId: "i2",
      targetKey: "target-2",
      receiverUid: "u2",
    },
  });
  const accounts = {
    u1: { alarmIncidents: { i1: { ...base, receiverUid: "u1" } } },
    u2: {
      alarmIncidents: {
        i2: {
          ...base,
          incidentId: "i2",
          targetKey: "target-2",
          receiverUid: "u2",
        },
      },
    },
  };
  const { runtime, calls } = makeRuntime({
    db,
    getAlarmReceiverUidsForHome: () => ["u1", "u2"],
    getCachedAccountData: (uid) => accounts[uid],
    getIncidentResolutionType: () => "automatic",
  });

  const count = await runtime.resolveAlarmIncidentGroupForHome({
    ownerUid: "owner",
    homeId: "home",
    flowType: "security",
    resolvedBy: "backend",
    action: "condition_cleared",
  });

  assert.equal(count, 2);
  assert.equal(calls.resolvedPushes.length, 2);
});

test("new security incident persists detected stage and delegates immediate channels", async () => {
  const { runtime, db, calls } = makeRuntime();

  await runtime.startOrMergeAlarmIncidents(
    "u1",
    [makeItem({ type: "door", reason: "Door open" })],
    { bypassEventControl: true },
  );

  const rootUpdate = db.updates.find((entry) => entry.path === "");
  const incidentPath = Object.keys(rootUpdate.value).find((path) =>
    path.includes("/alarmIncidents/incident-1"),
  );
  const incident = rootUpdate.value[incidentPath];

  assert.equal(incident.flowType, "security");
  assert.equal(incident.stage, "detected");
  assert.ok(incident.alarmDueAt > 0);
  assert.ok(incident.sirenDueAt > 0);
  assert.ok(incident.callDueAt > incident.detectedAt);
  assert.equal(calls.delivered.length, 1);
  assert.equal(calls.scheduled.length, 1);
});

test("old transient emergency is superseded before a fresh incident is created", async () => {
  const oldDetectedAt = Date.now() - 60000;
  const existing = {
    incidentId: "old",
    targetKey: "u1|owner|home|emergency",
    receiverUid: "u1",
    ownerUid: "owner",
    homeId: "home",
    flowType: "emergency",
    status: "active",
    stage: "calling",
    callStatus: "started",
    detectedAt: oldDetectedAt,
    items: [makeItem({ type: "sos", reason: "SOS" })],
  };
  const { runtime, db, calls, activeByTarget } = makeRuntime();
  activeByTarget.set(existing.targetKey, {
    incidentId: "old",
    incident: existing,
  });

  await runtime.startOrMergeAlarmIncidents(
    "u1",
    [makeItem({ type: "sos", reason: "SOS" })],
    { bypassEventControl: true },
  );

  const supersedeUpdate = db.updates.find((entry) =>
    entry.path === "accounts/u1/alarmIncidents/old",
  );
  assert.equal(supersedeUpdate.value.status, "superseded");
  assert.equal(supersedeUpdate.value.supersededReason, "new_emergency_trigger");
  assert.equal(calls.clearedTimers.length, 1);
  assert.equal(calls.localRemove.length, 1);
  assert.ok(db.updates.some((entry) =>
    entry.path === "" &&
    Object.keys(entry.value).some((path) => path.includes("incident-1")),
  ));
});
