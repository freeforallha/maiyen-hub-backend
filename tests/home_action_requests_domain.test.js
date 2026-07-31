"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAlarmPauseMirrorUpdates,
  createHomeActionRequestDomain,
  normalizeAlarmIncidentActionRequest,
  normalizeAlarmPauseRequest,
  normalizeHomeSirenActionRequest,
} = require("../domains/home/home_action_requests");

function createSnapshot(path, value) {
  return {
    key: String(path).split("/").filter(Boolean).at(-1) || null,
    exists() {
      return value != null;
    },
    val() {
      return value;
    },
  };
}

function createFakeDb(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  const rootUpdates = [];
  const pathUpdates = [];
  const removals = [];

  function ref(path = "") {
    const cleanPath = String(path || "");

    return {
      async once() {
        return createSnapshot(cleanPath, values.get(cleanPath));
      },
      async update(value) {
        if (!cleanPath) {
          rootUpdates.push(value);
          for (const [key, entry] of Object.entries(value)) {
            if (entry == null) values.delete(key);
            else values.set(key, entry);
          }
          return;
        }

        pathUpdates.push({ path: cleanPath, value });
        const current = values.get(cleanPath);
        values.set(cleanPath, {
          ...(current && typeof current === "object" ? current : {}),
          ...value,
        });
      },
      async remove() {
        removals.push(cleanPath);
        values.delete(cleanPath);
      },
    };
  }

  return {
    db: { ref },
    pathUpdates,
    removals,
    rootUpdates,
    values,
  };
}

function createRequestSnapshot(requestId, request) {
  const updates = [];
  let removed = 0;

  return {
    key: requestId,
    val() {
      return request;
    },
    ref: {
      async update(value) {
        updates.push(value);
      },
      async remove() {
        removed += 1;
      },
    },
    get updates() {
      return updates;
    },
    get removed() {
      return removed;
    },
  };
}

function createDomain({
  values = {},
  nowValue = 1_000_000,
  cachedAccounts = {},
  cachedHomes = {},
  participant = true,
  sirenResult = {
    status: "stopped",
    deviceCount: 1,
    successCount: 1,
    confirmedCount: 1,
  },
} = {}) {
  const fake = createFakeDb(values);
  const calls = {
    pauseCancel: [],
    pauseSchedule: [],
    homeNotifications: [],
    homeRecipientNotifications: [],
    pausePushes: [],
    siren: [],
    acknowledged: [],
    resolvedPushes: [],
    groupResolves: [],
    clearedTimers: [],
  };
  const timers = [];

  const domain = createHomeActionRequestDomain({
    db: fake.db,
    deviceId: "hub-1",
    lastNotificationMap: {},
    getCachedAccountData(uid) {
      return cachedAccounts[uid] || null;
    },
    getCachedHomeData(ownerUid, homeId) {
      return cachedHomes[`${ownerUid}|${homeId}`] || null;
    },
    async verifyHomeParticipant() {
      return participant;
    },
    isCachedHomeParticipant() {
      return participant;
    },
    normalizeTimestamp(value) {
      return Number(value) || 0;
    },
    getDateKeyFromTimestamp() {
      return "2026-07-31";
    },
    isValidHHMM(value) {
      return /^\d{2}:\d{2}$/.test(String(value));
    },
    doesPauseOverlapEnabledAlarm() {
      return true;
    },
    cancelAlarmPauseExpiryTimer(...args) {
      calls.pauseCancel.push(args);
    },
    scheduleAlarmPauseExpiry(...args) {
      calls.pauseSchedule.push(args);
    },
    async addHomeNotificationFromBackend(payload) {
      calls.homeNotifications.push(payload);
    },
    async addHomeNotificationToHomeRecipients(payload) {
      calls.homeRecipientNotifications.push(payload);
    },
    async sendAlarmPauseNotification(...args) {
      calls.pausePushes.push(args);
    },
    getCachedUserDisplayName(uid) {
      return `User ${uid}`;
    },
    async mutePhysicalSirenForHome(...args) {
      calls.siren.push(args);
      return sirenResult;
    },
    async acknowledgeAlarmIncidentForReceiver(payload) {
      calls.acknowledged.push(payload);
      return true;
    },
    async sendAlarmResolvedPush(payload) {
      calls.resolvedPushes.push(payload);
    },
    hasLocalActiveAlarmIncidentForReceiver() {
      return false;
    },
    async resolveAlarmIncidentGroupForHome(payload) {
      calls.groupResolves.push(payload);
    },
    now: () => nowValue,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      calls.clearedTimers.push(timer);
    },
    log() {},
  });

  return { ...fake, calls, domain, timers };
}

test("Home action request normalizers reject stale or unsupported requests", () => {
  const now = 1_000_000;

  assert.equal(
    normalizeAlarmPauseRequest(
      {
        status: "pending",
        ownerUid: "owner",
        homeId: "h1",
        createdByUid: "member",
        action: "create",
        createdAt: now,
      },
      "pause_member",
      now,
    ).valid,
    true,
  );
  assert.equal(
    normalizeHomeSirenActionRequest(
      {
        status: "pending",
        homeId: "h1",
        hubId: "hub-1",
        requestedBy: "member",
        action: "mute",
        createdAt: now - 10 * 60 * 1000,
      },
      "r1",
      now,
    ).valid,
    false,
  );
  assert.equal(
    normalizeAlarmIncidentActionRequest(
      {
        status: "pending",
        receiverUid: "member",
        incidentId: "i1",
        requestedBy: "member",
        action: "delete",
        createdAt: now,
      },
      "r2",
      now,
    ).valid,
    false,
  );
});

test("Alarm Pause mirror updates include Owner, members and request cleanup", () => {
  const pause = { start: "20:00", end: "21:00" };
  const updates = buildAlarmPauseMirrorUpdates({
    ownerUid: "owner",
    homeId: "h1",
    requestId: "r1",
    sharedUsers: {
      owner: { role: "owner" },
      member: { role: "member" },
    },
    pauseData: pause,
  });

  assert.equal(
    updates["accounts/owner/homes/h1/alarmPauseToday"],
    pause,
  );
  assert.equal(
    updates["accounts/member/sharedHomes/h1/alarmPauseToday"],
    pause,
  );
  assert.equal(updates["alarm_pause_requests/r1"], null);
});

test("valid Alarm Pause request is mirrored and schedules its expiry", async () => {
  const now = 1_000_000;
  const { domain, rootUpdates, calls } = createDomain({
    nowValue: now,
    values: {
      "accounts/owner/homes/h1": { name: "Nhà", schedules: {} },
      "accounts/member": { profile: { name: "Member" } },
      "sharedByHome/h1": { member: { role: "member" } },
    },
  });
  const snap = createRequestSnapshot("pause_member", {
    status: "pending",
    ownerUid: "owner",
    homeId: "h1",
    createdByUid: "member",
    action: "create",
    createdAt: now,
    date: "2026-07-31",
    start: "20:00",
    end: "21:00",
    startAt: now,
    endAt: now + 60 * 60 * 1000,
    reason: "Test",
  });

  await domain.handleAlarmPauseRequest(snap);

  assert.equal(rootUpdates.length, 1);
  assert.equal(
    rootUpdates[0]["accounts/member/sharedHomes/h1/alarmPauseToday"]
      .createdByName,
    "Member",
  );
  assert.equal(calls.pauseSchedule.length, 1);
  assert.equal(snap.removed, 0);
});

test("Alarm Pause removal clears every mirror and emits one Home activity", async () => {
  const now = 1_000_000;
  const { domain, rootUpdates, calls } = createDomain({
    nowValue: now,
    values: {
      "accounts/owner/homes/h1": { name: "Nhà" },
      "accounts/member": { name: "Member" },
      "sharedByHome/h1": { member: { role: "member" } },
    },
  });
  const snap = createRequestSnapshot("remove_member", {
    status: "pending",
    ownerUid: "owner",
    homeId: "h1",
    createdByUid: "member",
    action: "remove",
    createdAt: now,
  });

  await domain.handleAlarmPauseRequest(snap);

  assert.equal(calls.pauseCancel.length, 1);
  assert.equal(
    rootUpdates[0]["accounts/member/sharedHomes/h1/alarmPauseToday"],
    null,
  );
  assert.equal(calls.homeRecipientNotifications.length, 1);
});

test("Alarm Pause account change broadcasts once and skips push to actor", async () => {
  const now = 1_000_000;
  const { domain, calls } = createDomain({
    nowValue: now,
    values: {
      "sharedByHome/h1": { member: {}, actor: {} },
    },
  });
  const accountSnap = {
    key: "owner",
    val() {
      return {
        homes: {
          h1: {
            name: "Nhà",
            alarmPauseToday: {
              start: "20:00",
              end: "21:00",
              createdAt: 123,
              createdByUid: "actor",
              createdByName: "Actor",
            },
          },
        },
      };
    },
  };

  await domain.handleAlarmPauseAccountChanged(accountSnap);
  await domain.handleAlarmPauseAccountChanged(accountSnap);

  assert.equal(calls.homeNotifications.length, 3);
  assert.deepEqual(
    calls.pausePushes.map((entry) => entry[0]).sort(),
    ["member", "owner"],
  );
});

test("Home siren request for another Hub remains pending and untouched", async () => {
  const now = 1_000_000;
  const { domain, calls } = createDomain({
    nowValue: now,
    cachedAccounts: {
      owner: { homes: { h1: { hubId: "hub-2" } } },
    },
    cachedHomes: {
      "owner|h1": { name: "Nhà", hubId: "hub-2" },
    },
  });
  const snap = createRequestSnapshot("siren-1", {
    status: "pending",
    homeId: "h1",
    hubId: "hub-1",
    requestedBy: "owner",
    action: "mute",
    createdAt: now,
  });

  await domain.handleHomeSirenActionRequest(snap);

  assert.equal(snap.updates.length, 0);
  assert.equal(snap.removed, 0);
  assert.equal(calls.siren.length, 0);
});

test("owned Home siren request is processed and publishes bounded result", async () => {
  const now = 1_000_000;
  const { domain, calls, timers } = createDomain({
    nowValue: now,
    cachedAccounts: {
      owner: { homes: { h1: { hubId: "hub-1" } } },
    },
    cachedHomes: {
      "owner|h1": { name: "Nhà", hubId: "hub-1" },
    },
  });
  const snap = createRequestSnapshot("siren-1", {
    status: "pending",
    homeId: "h1",
    hubId: "hub-1",
    requestedBy: "owner",
    action: "mute",
    createdAt: now,
  });

  await domain.handleHomeSirenActionRequest(snap);

  assert.equal(calls.siren.length, 1);
  assert.equal(snap.updates[0].status, "processing");
  assert.equal(snap.updates[1].status, "succeeded");
  assert.equal(calls.homeRecipientNotifications.length, 1);
  assert.equal(timers.length, 1);
});

test("check_home acknowledges only the receiver incident", async () => {
  const now = 1_000_000;
  const { domain, calls } = createDomain({
    nowValue: now,
    values: {
      "accounts/member/alarmIncidents/i1": {
        status: "active",
        ownerUid: "owner",
        homeId: "h1",
      },
    },
  });
  const snap = createRequestSnapshot("incident-1", {
    status: "pending",
    receiverUid: "member",
    incidentId: "i1",
    requestedBy: "member",
    action: "check_home",
    createdAt: now,
  });

  await domain.handleAlarmIncidentActionRequest(snap);

  assert.equal(calls.acknowledged.length, 1);
  assert.equal(calls.groupResolves.length, 0);
  assert.equal(snap.removed, 1);
});

test("mute_siren preserves active incident and records manual mute", async () => {
  const now = 1_000_000;
  const { domain, calls, pathUpdates } = createDomain({
    nowValue: now,
    values: {
      "accounts/member/alarmIncidents/i1": {
        status: "active",
        ownerUid: "owner",
        homeId: "h1",
      },
    },
    cachedHomes: {
      "owner|h1": { name: "Nhà" },
    },
  });
  const snap = createRequestSnapshot("incident-2", {
    status: "pending",
    receiverUid: "member",
    incidentId: "i1",
    requestedBy: "member",
    action: "mute_siren",
    createdAt: now,
  });

  await domain.handleAlarmIncidentActionRequest(snap);

  assert.equal(calls.siren.length, 1);
  assert.equal(calls.groupResolves.length, 0);
  assert.equal(pathUpdates[0].value.homeSirenStatus, "manual_muted");
  assert.equal(calls.homeRecipientNotifications.length, 1);
});

test("stop action mutes the siren then resolves every Home incident copy", async () => {
  const now = 1_000_000;
  const { domain, calls } = createDomain({
    nowValue: now,
    values: {
      "accounts/member/alarmIncidents/i1": {
        status: "active",
        ownerUid: "owner",
        homeId: "h1",
        flowType: "emergency",
      },
    },
  });
  const snap = createRequestSnapshot("incident-3", {
    status: "pending",
    receiverUid: "member",
    incidentId: "i1",
    requestedBy: "member",
    action: "stop",
    createdAt: now,
  });

  await domain.handleAlarmIncidentActionRequest(snap);

  assert.equal(calls.siren.length, 1);
  assert.deepEqual(calls.groupResolves[0], {
    ownerUid: "owner",
    homeId: "h1",
    flowType: "emergency",
    resolvedBy: "member",
    action: "stop",
  });
  assert.equal(snap.removed, 1);
});

test("runtime cleanup clears siren result timers and in-progress state", async () => {
  const now = 1_000_000;
  const { domain, calls } = createDomain({
    nowValue: now,
    cachedAccounts: {
      owner: { homes: { h1: { hubId: "hub-1" } } },
    },
    cachedHomes: {
      "owner|h1": { hubId: "hub-1" },
    },
  });
  const snap = createRequestSnapshot("siren-1", {
    status: "succeeded",
    homeId: "h1",
    hubId: "hub-1",
    requestedBy: "owner",
    action: "mute",
    createdAt: now,
  });

  await domain.handleHomeSirenActionRequest(snap);
  assert.equal(
    domain.getHomeActionRequestRuntimeState().cleanupTimers,
    1,
  );
  assert.equal(domain.stopHomeActionRequestRuntime(), true);
  assert.equal(calls.clearedTimers.length, 1);
  assert.deepEqual(domain.getHomeActionRequestRuntimeState(), {
    homeSirenRequests: 0,
    alarmIncidentRequests: 0,
    cleanupTimers: 0,
  });
});
