"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CACHE_LISTENER_KEYS,
  buildUserDirectoryData,
  createBackendDataCacheDomain,
} = require("../domains/runtime/backend_data_cache");

function snapshot(key, value) {
  return { key, val: () => value };
}

function createHarness(overrides = {}) {
  const accountCache = new Map();
  const sharedByHomeCache = new Map();
  const deviceMap = {};
  const localActiveAlarmIncidentMap = new Map();
  const registered = new Map();
  const unregistered = [];
  const sets = [];
  const removes = [];
  const values = {
    accounts: {},
    sharedByHome: {},
    "system/devices_by_ieee": {},
    ...(overrides.values || {}),
  };
  let snapshotSaves = 0;
  let persisted = 0;

  const db = {
    ref(path = "") {
      return {
        async once() {
          return snapshot(path.split("/").pop(), values[path]);
        },
        async set(value) {
          sets.push({ path, value });
        },
        async remove() {
          removes.push(path);
        },
      };
    },
  };

  const coordinator = {
    registerListener(listener) {
      if (registered.has(listener.key)) return false;
      registered.set(listener.key, listener);
      return true;
    },
    unregisterListener(key) {
      unregistered.push(key);
      return registered.delete(key);
    },
  };

  const alarmChanges = [];
  const pauseChanges = [];

  const domain = createBackendDataCacheDomain({
    db,
    accountCache,
    sharedByHomeCache,
    deviceMap,
    localActiveAlarmIncidentMap,
    getFirebaseRequestCoordinator: () => coordinator,
    scheduleLocalRuntimeSnapshotSave: () => {
      snapshotSaves += 1;
    },
    persistLocalRuntimeSnapshotNow: () => {
      persisted += 1;
    },
    handleAlarmRelevantAccountChange: (...args) => {
      alarmChanges.push(args);
    },
    handleAlarmPauseAccountChanged: (...args) => {
      pauseChanges.push(args);
    },
    log: () => {},
  });

  return {
    accountCache,
    alarmChanges,
    coordinator,
    deviceMap,
    domain,
    get persisted() {
      return persisted;
    },
    localActiveAlarmIncidentMap,
    pauseChanges,
    registered,
    removes,
    sets,
    sharedByHomeCache,
    get snapshotSaves() {
      return snapshotSaves;
    },
    unregistered,
  };
}

test("userDirectory normalization is deterministic", () => {
  assert.deepEqual(
    buildUserDirectoryData({
      email: " USER@Example.COM ",
      name: "fallback",
      profile: { name: " Mai Yến ", photoUrl: " photo " },
    }),
    {
      email: "user@example.com",
      name: "Mai Yến",
      photoUrl: "photo",
    },
  );
});

test("cached Home access and Alarm receivers exclude deleted accounts", () => {
  const harness = createHarness();
  harness.accountCache.set("owner", { homes: { h1: { name: "Home" } } });
  harness.accountCache.set("member", {});
  harness.sharedByHomeCache.set("h1", {
    member: { role: "member" },
    deleted: { role: "member" },
  });

  assert.equal(harness.domain.getCachedHomeData("owner", "h1").name, "Home");
  assert.deepEqual(
    harness.domain.getAlarmReceiverUidsForHome("owner", "h1"),
    ["owner", "member"],
  );
});

test("bootstrap registers six listeners and restores all canonical indexes", async () => {
  const harness = createHarness({
    values: {
      accounts: {
        owner: {
          email: "owner@example.com",
          homes: { h1: { devices: { d1: {} } } },
        },
      },
      sharedByHome: { h1: { member: { role: "member" } } },
      "system/devices_by_ieee": { d2: { uid: "owner", homeId: "h1" } },
    },
  });

  assert.equal(await harness.domain.startBackendDataCache(), true);
  assert.deepEqual([...harness.registered.keys()], CACHE_LISTENER_KEYS);
  assert.equal(harness.accountCache.has("owner"), true);
  assert.equal(harness.sharedByHomeCache.has("h1"), true);
  assert.deepEqual(harness.deviceMap.d1, { uid: "owner", homeId: "h1" });
  assert.deepEqual(harness.deviceMap.d2, { uid: "owner", homeId: "h1" });
  assert.equal(harness.sets[0].path, "userDirectory/owner");
  assert.equal(harness.persisted, 1);
});

test("repeated start is idempotent", async () => {
  const harness = createHarness();
  assert.equal(await harness.domain.startBackendDataCache(), true);
  assert.equal(await harness.domain.startBackendDataCache(), false);
  assert.equal(harness.registered.size, 6);
});

test("account change updates cache, callbacks and userDirectory once", async () => {
  const harness = createHarness();
  await harness.domain.startBackendDataCache();
  const added = harness.registered.get("cache:accounts:child_added").handler;
  const changed = harness.registered.get("cache:accounts:child_changed").handler;

  added(snapshot("u1", { email: "u@example.com" }));
  await new Promise((resolve) => setImmediate(resolve));
  changed(snapshot("u1", { email: "u@example.com" }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.accountCache.get("u1").email, "u@example.com");
  assert.equal(harness.alarmChanges.length, 1);
  assert.equal(harness.pauseChanges.length, 1);
  assert.equal(
    harness.sets.filter((item) => item.path === "userDirectory/u1").length,
    1,
  );
  assert.equal(harness.snapshotSaves, 2);
});

test("account removal clears cache, incident indexes and directory", async () => {
  const harness = createHarness();
  await harness.domain.startBackendDataCache();
  harness.accountCache.set("u1", {});
  harness.localActiveAlarmIncidentMap.set("u1|h1|i1", {});
  harness.localActiveAlarmIncidentMap.set("u2|h1|i2", {});

  harness.registered
    .get("cache:accounts:child_removed")
    .handler(snapshot("u1", null));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.accountCache.has("u1"), false);
  assert.equal(harness.localActiveAlarmIncidentMap.has("u1|h1|i1"), false);
  assert.equal(harness.localActiveAlarmIncidentMap.has("u2|h1|i2"), true);
  assert.deepEqual(harness.removes, ["userDirectory/u1"]);
});

test("shared Home listeners update and remove cache entries", async () => {
  const harness = createHarness();
  await harness.domain.startBackendDataCache();

  harness.registered
    .get("cache:shared_by_home:child_added")
    .handler(snapshot("h1", { u1: {} }));
  assert.equal(harness.sharedByHomeCache.has("h1"), true);

  harness.registered
    .get("cache:shared_by_home:child_removed")
    .handler(snapshot("h1", null));
  assert.equal(harness.sharedByHomeCache.has("h1"), false);
});

test("stop unregisters all listener keys and allows a clean restart", async () => {
  const harness = createHarness();
  await harness.domain.startBackendDataCache();
  assert.equal(harness.domain.stopBackendDataCache(), true);
  assert.deepEqual(harness.unregistered, CACHE_LISTENER_KEYS);
  assert.equal(harness.domain.getBackendDataCacheState().started, false);
  assert.equal(await harness.domain.startBackendDataCache(), true);
});
