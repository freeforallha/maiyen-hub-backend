"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAutoAwayDomain,
} = require("../domains/auto_away/auto_away");

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function applyPathUpdate(root, path, value) {
  const parts = String(path || "").split("/").filter(Boolean);
  let cursor = root;

  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index];
    cursor[key] = asObject(cursor[key]);
    cursor = cursor[key];
  }

  const leaf = parts[parts.length - 1];

  if (value === null) {
    delete cursor[leaf];
  } else {
    cursor[leaf] = value;
  }
}

function createRuntime({ accounts = {}, sharedByHome = {}, startAt = 1_000_000 } = {}) {
  let currentTime = startAt;
  const writes = [];
  const notifications = [];
  const pushes = [];
  let intervalCallback = null;
  let intervalCount = 0;
  let clearCount = 0;

  const domain = createAutoAwayDomain({
    db: {
      ref(path = "") {
        assert.equal(path, "");
        return {
          async update(updates) {
            writes.push(structuredClone(updates));

            for (const [updatePath, value] of Object.entries(updates)) {
              applyPathUpdate({ accounts }, updatePath, value);
            }
          },
        };
      },
    },
    getCachedAccountsObject: () => accounts,
    getCachedSharedByHomeObject: () => sharedByHome,
    sendPushToUser: async (uid, message) => {
      pushes.push({ uid, message });
      return { sent: 1, failed: 0, targets: 1 };
    },
    addHomeNotificationToHomeRecipients: async (payload) => {
      notifications.push(payload);
    },
    isSecurityDeviceType: (type) =>
      ["door", "window", "gate", "door_lock", "lock"].includes(
        String(type || "").trim(),
      ),
    normalizeHomeSecurityMode: (value) => {
      const mode = String(value || "").trim().toLowerCase();
      return mode === "armed" || mode === "unprotected"
        ? mode
        : "normal";
    },
    now: () => currentTime,
    setIntervalFn: (callback) => {
      intervalCount++;
      intervalCallback = callback;
      return { intervalCount };
    },
    clearIntervalFn: () => {
      clearCount++;
    },
    log: () => {},
  });

  return {
    domain,
    writes,
    notifications,
    pushes,
    accounts,
    setCurrentTime(value) {
      currentTime = value;
    },
    getCurrentTime() {
      return currentTime;
    },
    getIntervalCallback() {
      return intervalCallback;
    },
    getIntervalCount() {
      return intervalCount;
    },
    getClearCount() {
      return clearCount;
    },
  };
}

function createOwnerAccount(now, state = "outside") {
  return {
    sessions: {
      androidA: {
        signedIn: true,
        connected: true,
        platform: "android",
        lastSeenAt: now,
      },
    },
    homePresence: {
      homeA: {
        ownerUid: "ownerA",
        homeId: "homeA",
        state,
        event: state === "inside" ? "enter" : "exit",
        locationAlwaysGranted: true,
        monitoringEligible: true,
        monitoringAvailable: true,
        lastConfirmedAt: now,
        lastEventOccurredAt: now,
        updatedAt: now,
      },
    },
    homes: {
      homeA: {
        name: "Nhà A",
        autoAway: { enabled: true },
        securityMode: "normal",
        devices: {
          doorA: { type: "door", name: "Cửa chính" },
        },
      },
    },
  };
}

test("participant selection removes invalid members and falls back to Owner", () => {
  const runtime = createRuntime();
  const result = runtime.domain.resolveAutoAwayParticipantSelection(
    { participantUids: { removedMember: true, ownerA: false } },
    new Set(["ownerA", "memberA"]),
    "ownerA",
  );

  assert.deepEqual(result.participantUids, ["ownerA"]);
  assert.deepEqual(result.normalizedMap, { ownerA: true });
  assert.equal(result.needsNormalization, true);
});

test("presence keeps recent iOS geofence state but expires stale Android session", () => {
  const now = 10_000_000;
  const runtime = createRuntime({ startAt: now });
  const accounts = {
    iosUser: {
      homePresence: {
        homeA: {
          ownerUid: "ownerA",
          homeId: "homeA",
          state: "inside",
          event: "enter",
          locationAlwaysGranted: true,
          updatedAt: now - 60_000,
          lastConfirmedAt: now - 60_000,
        },
      },
    },
    androidUser: {
      homePresence: {
        homeA: {
          ownerUid: "ownerA",
          homeId: "homeA",
          state: "outside",
          event: "exit",
          locationAlwaysGranted: true,
          updatedAt: now - 60_000,
          lastConfirmedAt: now - 60_000,
        },
      },
    },
  };

  const ios = runtime.domain.getMemberPresenceStatus(
    accounts,
    "iosUser",
    "ownerA",
    "homeA",
    {
      active: false,
      platform: "ios",
      signedInSessionCount: 1,
      freshestSeenAt: now - 60_000,
      reason: "session_stale",
    },
    now,
  );
  const android = runtime.domain.getMemberPresenceStatus(
    accounts,
    "androidUser",
    "ownerA",
    "homeA",
    {
      active: false,
      platform: "android",
      signedInSessionCount: 1,
      freshestSeenAt: now - 60_000,
      reason: "session_stale",
    },
    now,
  );

  assert.equal(ios.state, "inside");
  assert.equal(ios.staleIosPresenceAllowed, true);
  assert.equal(android.state, "unknown");
  assert.equal(android.needsSessionCleanup, true);
});

test("all selected members outside arms the home after the confirmation delay", async () => {
  const startAt = 20_000_000;
  const accounts = { ownerA: createOwnerAccount(startAt) };
  const runtime = createRuntime({ accounts, startAt });

  await runtime.domain.checkAutoAwayHomes();

  assert.equal(accounts.ownerA.homes.homeA.securityMode, "normal");
  assert.equal(
    accounts.ownerA.homes.homeA.autoAwayRuntime.status,
    "countdown",
  );
  assert.equal(
    accounts.ownerA.homes.homeA.autoAwayRuntime.allOutsideSince,
    startAt,
  );

  const armedAt = startAt + 60_001;
  runtime.setCurrentTime(armedAt);
  accounts.ownerA.sessions.androidA.lastSeenAt = armedAt;

  await runtime.domain.checkAutoAwayHomes();

  assert.equal(accounts.ownerA.homes.homeA.securityMode, "armed");
  assert.equal(
    accounts.ownerA.homes.homeA.securityModeSource,
    "auto_away",
  );
  assert.equal(
    accounts.ownerA.homes.homeA.autoAwayRuntime.status,
    "armed",
  );
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0].type, "auto_away_armed");
});

test("confirmed member return changes an Auto Away home back to normal", async () => {
  const startAt = 30_000_000;
  const accounts = { ownerA: createOwnerAccount(startAt) };
  const runtime = createRuntime({ accounts, startAt });

  await runtime.domain.checkAutoAwayHomes();
  runtime.setCurrentTime(startAt + 60_001);
  accounts.ownerA.sessions.androidA.lastSeenAt = runtime.getCurrentTime();
  await runtime.domain.checkAutoAwayHomes();

  const returnedAt = startAt + 70_000;
  runtime.setCurrentTime(returnedAt);
  accounts.ownerA.sessions.androidA.lastSeenAt = returnedAt;
  Object.assign(accounts.ownerA.homePresence.homeA, {
    state: "inside",
    event: "enter",
    lastConfirmedAt: returnedAt,
    lastEventOccurredAt: returnedAt,
    updatedAt: returnedAt,
  });

  await runtime.domain.checkAutoAwayHomes();
  assert.equal(
    accounts.ownerA.homes.homeA.autoAwayRuntime.status,
    "confirming_inside",
  );

  runtime.setCurrentTime(returnedAt + 30_001);
  accounts.ownerA.sessions.androidA.lastSeenAt = runtime.getCurrentTime();
  await runtime.domain.checkAutoAwayHomes();

  assert.equal(accounts.ownerA.homes.homeA.securityMode, "normal");
  assert.equal(accounts.ownerA.homes.homeA.securityModeSource, undefined);
  assert.equal(
    accounts.ownerA.homes.homeA.autoAwayRuntime.status,
    "inside",
  );
  assert.ok(
    accounts.ownerA.homes.homeA.autoAwayRuntime.rearmBlockedUntil >
      runtime.getCurrentTime(),
  );
  assert.equal(runtime.notifications.at(-1).type, "auto_away_normal");
});

test("Auto Away monitor starts once and can be stopped", async () => {
  const runtime = createRuntime();

  runtime.domain.startAutoAwayMonitor();
  runtime.domain.startAutoAwayMonitor();

  assert.equal(runtime.getIntervalCount(), 1);
  assert.equal(typeof runtime.getIntervalCallback(), "function");

  runtime.domain.stopAutoAwayMonitor();
  runtime.domain.stopAutoAwayMonitor();

  assert.equal(runtime.getClearCount(), 1);
});
