"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createLocalRuntimeDomain,
} = require("../domains/runtime/local_runtime");

function createRuntime({
  connected = false,
  startAt = 1_000_000,
  home = { devices: {} },
} = {}) {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "maiyen-local-runtime-"),
  );
  const accountCache = new Map();
  const sharedByHomeCache = new Map();
  const deviceMap = {};
  const writes = [];
  const alarmCalls = [];
  const resumeCalls = [];
  const reconcileCalls = [];
  const offlineResumeCalls = [];
  const logs = [];
  const timeouts = [];
  const intervals = [];
  let currentTime = startAt;
  let firebaseConnected = connected;
  let connectionListener = null;
  let connectionOnCount = 0;
  let connectionOffCount = 0;

  const connectionRef = {
    on(event, callback) {
      assert.equal(event, "value");
      connectionOnCount++;
      connectionListener = callback;
    },
    off(event, callback) {
      assert.equal(event, "value");
      assert.equal(callback, connectionListener);
      connectionOffCount++;
    },
  };

  const db = {
    ref(refPath) {
      if (refPath === ".info/connected") {
        return connectionRef;
      }
      return {
        async update(data) {
          writes.push({ path: refPath, data: structuredClone(data) });
        },
      };
    },
  };

  const domain = createLocalRuntimeDomain({
    db,
    accountCache,
    sharedByHomeCache,
    deviceMap,
    runtimeDir,
    getFirebaseConnected: () => firebaseConnected,
    setFirebaseConnected: (value) => {
      firebaseConnected = value === true;
    },
    getAlarmIncidentItemIdentity: (item) =>
      `${item.type || ""}|${item.deviceId || ""}`,
    getCachedHomeData: () => home,
    isPersistentEmergencyIncidentItem: (item) =>
      item.type === "smoke",
    isEmergencyIncidentItemStillUnsafe: () => true,
    startOrMergeAlarmIncidents: async (uid, items) => {
      alarmCalls.push({ uid, items: structuredClone(items) });
    },
    resumeOfflineAlarmDemandsFromSnapshot: async () => {
      offlineResumeCalls.push(true);
    },
    resumeActiveAlarmIncidents: async () => {
      resumeCalls.push(true);
    },
    reconcileAllPhysicalSirens: async (options) => {
      reconcileCalls.push(structuredClone(options));
    },
    now: () => currentTime,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, type: "timeout" };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, type: "interval" };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => {
      timer.cleared = true;
    },
    log: (...args) => logs.push(args),
  });

  return {
    domain,
    runtimeDir,
    accountCache,
    sharedByHomeCache,
    deviceMap,
    writes,
    alarmCalls,
    resumeCalls,
    reconcileCalls,
    offlineResumeCalls,
    logs,
    timeouts,
    intervals,
    setCurrentTime(value) {
      currentTime = value;
    },
    getFirebaseConnected() {
      return firebaseConnected;
    },
    getConnectionListener() {
      return connectionListener;
    },
    getConnectionOnCount() {
      return connectionOnCount;
    },
    getConnectionOffCount() {
      return connectionOffCount;
    },
    cleanup() {
      domain.stop();
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

test("snapshot persists safe home data and restores all runtime indexes", () => {
  const runtime = createRuntime();

  try {
    runtime.accountCache.set("ownerA", {
      homes: {
        homeA: {
          name: "Nhà A",
          securityMode: "armed",
          devices: {
            doorA: {
              type: "door",
              open: true,
              notifications: { old: { body: "large timeline" } },
            },
          },
        },
      },
      alarmSettings: { homeA: { enabled: true } },
    });
    runtime.sharedByHomeCache.set("homeA", { memberA: true });
    runtime.deviceMap.doorA = { uid: "ownerA", homeId: "homeA" };

    runtime.domain.persistLocalRuntimeSnapshotNow();

    const { snapshotFile } = runtime.domain.getRuntimePaths();
    const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.accounts.ownerA.homes.homeA.securityMode, "armed");
    assert.equal(
      saved.accounts.ownerA.homes.homeA.devices.doorA.notifications,
      undefined,
    );

    runtime.accountCache.clear();
    runtime.sharedByHomeCache.clear();
    delete runtime.deviceMap.doorA;

    const result = runtime.domain.loadLocalRuntimeState();
    assert.deepEqual(result, {
      accounts: 1,
      homes: 1,
      devices: 1,
      queuedOperations: 0,
    });
    assert.equal(
      runtime.accountCache.get("ownerA").homes.homeA.devices.doorA.open,
      true,
    );
    assert.deepEqual(
      runtime.sharedByHomeCache.get("homeA"),
      { memberA: true },
    );
    assert.deepEqual(
      runtime.deviceMap.doorA,
      { uid: "ownerA", homeId: "homeA" },
    );
  } finally {
    runtime.cleanup();
  }
});

test("offline Firebase updates merge by path and survive a reload", () => {
  const runtime = createRuntime();

  try {
    runtime.domain.enqueueOfflineFirebaseUpdate(
      "accounts/ownerA/homeA/deviceA",
      { open: true, linkquality: 50 },
    );
    runtime.domain.enqueueOfflineFirebaseUpdate(
      "accounts/ownerA/homeA/deviceA",
      { open: false, battery: 90 },
    );

    assert.equal(runtime.domain.getOfflineQueueSnapshot().length, 1);
    assert.deepEqual(
      runtime.domain.getOfflineQueueSnapshot()[0].data,
      { open: false, linkquality: 50, battery: 90 },
    );

    runtime.domain.persistOfflineQueueNow();

    const restored = createRuntime();
    try {
      const sourceQueue = runtime.domain.getRuntimePaths().offlineQueueFile;
      const targetQueue = restored.domain.getRuntimePaths().offlineQueueFile;
      fs.copyFileSync(sourceQueue, targetQueue);

      const result = restored.domain.loadLocalRuntimeState();
      assert.equal(result.queuedOperations, 1);
      assert.deepEqual(
        restored.domain.getOfflineQueueSnapshot()[0].data,
        { open: false, linkquality: 50, battery: 90 },
      );
    } finally {
      restored.cleanup();
    }
  } finally {
    runtime.cleanup();
  }
});

test("flush prioritizes alarm items and drops expired transient alarms", async () => {
  const runtime = createRuntime({
    connected: true,
    startAt: 10_000,
    home: { devices: { motionA: { motion: false } } },
  });

  try {
    runtime.domain.enqueueOfflineFirebaseUpdate(
      "accounts/ownerA/value",
      { value: 1 },
    );
    runtime.domain.enqueueOfflineAlarmItem("receiverA", {
      type: "motion",
      deviceId: "motionA",
      ownerUid: "ownerA",
      homeId: "homeA",
    });
    runtime.setCurrentTime(10_000 + 6 * 60 * 1000);

    const result = await runtime.domain.flushOfflineOperationQueue();

    assert.deepEqual(result, { completed: 1, remaining: 0 });
    assert.equal(runtime.alarmCalls.length, 0);
    assert.deepEqual(runtime.writes, [{
      path: "accounts/ownerA/value",
      data: { value: 1 },
    }]);
  } finally {
    runtime.cleanup();
  }
});

test("Firebase monitor starts once and updates the shared connection state", () => {
  const runtime = createRuntime();

  try {
    assert.equal(runtime.domain.startFirebaseConnectionMonitor(), true);
    assert.equal(runtime.domain.startFirebaseConnectionMonitor(), false);
    assert.equal(runtime.getConnectionOnCount(), 1);

    runtime.getConnectionListener()({ val: () => true });
    assert.equal(runtime.getFirebaseConnected(), true);
    assert.equal(runtime.timeouts.length, 2);

    runtime.domain.startOfflineQueueFlushTimer();
    runtime.domain.startOfflineQueueFlushTimer();
    assert.equal(runtime.intervals.length, 1);

    runtime.domain.stop();
    assert.equal(runtime.getConnectionOffCount(), 1);
    assert.equal(runtime.intervals[0].cleared, true);
  } finally {
    runtime.cleanup();
  }
});


test("initial Firebase false -> true is not reconnect; real reconnect resumes once", async () => {
  const runtime = createRuntime();

  try {
    assert.equal(runtime.domain.startFirebaseConnectionMonitor(), true);

    // Firebase commonly emits false while its first connection is pending.
    runtime.getConnectionListener()({ val: () => false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.offlineResumeCalls.length, 1);

    runtime.getConnectionListener()({ val: () => true });

    const initialConnectTimer = runtime.timeouts.find(
      (timer) => timer.delay === 1000,
    );
    assert.ok(initialConnectTimer);
    initialConnectTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runtime.resumeCalls.length, 0);
    assert.equal(runtime.reconcileCalls.length, 0);

    // Only a disconnect observed after a real connection can arm reconnect.
    runtime.getConnectionListener()({ val: () => false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.offlineResumeCalls.length, 2);

    runtime.getConnectionListener()({ val: () => true });

    const reconnectTimers = runtime.timeouts.filter(
      (timer) => timer.delay === 1000,
    );
    assert.equal(reconnectTimers.length, 2);
    reconnectTimers[1].callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runtime.resumeCalls.length, 1);
    assert.deepEqual(runtime.reconcileCalls, [{
      force: true,
      reason: "firebase_reconnected",
    }]);
  } finally {
    runtime.cleanup();
  }
});
