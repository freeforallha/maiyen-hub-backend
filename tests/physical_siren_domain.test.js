"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPhysicalSirenDomain,
  HOME_SIREN_COMMAND_DURATION_SEC,
} = require("../domains/alarm/physical_siren");

function createHarness(overrides = {}) {
  const ownerUid = "owner";
  const homeId = "home";
  const home = overrides.home || { devices: {} };
  const accountCache = overrides.accountCache || new Map([
    [ownerUid, { homes: { [homeId]: home }, alarmIncidents: {} }],
  ]);
  const updates = [];
  const dbValues = new Map();
  const db = {
    ref(path = "") {
      return {
        async once() {
          return { val: () => dbValues.get(path) ?? null };
        },
        async update(value) {
          updates.push({ path, value });
          const current = dbValues.get(path) || {};
          dbValues.set(path, { ...current, ...value });
        },
        async set(value) {
          updates.push({ path, value });
          dbValues.set(path, value);
        },
        async remove() {
          updates.push({ path, value: null });
          dbValues.delete(path);
        },
      };
    },
  };
  const published = [];
  const client = overrides.client || {
    connected: true,
    publish(topic, payload, options, callback) {
      published.push({ topic, payload: JSON.parse(payload), options });
      callback(null);
    },
  };
  const intervalHandles = [];
  const clearedIntervals = [];
  const domain = createPhysicalSirenDomain({
    db,
    client,
    accountCache,
    getCachedHomeData(uid, id) {
      return accountCache.get(uid)?.homes?.[id] || null;
    },
    getAlarmReceiverUidsForHome: () => [ownerUid],
    incidentRequiresPhysicalSiren: (incident) =>
      incident?.physicalSirenEnabled !== false,
    isActiveSignal: (value) =>
      value === true || value === "ON" || value === "on",
    isSystemHealthExplicitlyOffline: (value) => value === "offline",
    isSystemHealthExplicitlyOnline: (value) => value === "online",
    parseSystemHealthTimestamp: (value) => {
      if (typeof value === "number") return value;
      const parsed = Date.parse(value || "");
      return Number.isFinite(parsed) ? parsed : 0;
    },
    getHeartbeatLimitMs: () => 6 * 60 * 60 * 1000,
    waitMs: async () => {},
    applyDeviceUpdateToLocalCache(uid, id, deviceId, value) {
      Object.assign(accountCache.get(uid).homes[id].devices[deviceId], value);
    },
    getFirebaseConnected: () => true,
    enqueueOfflineFirebaseUpdate: (path, value) => updates.push({ path, value }),
    log: () => {},
    setIntervalFn(callback, delay) {
      const handle = { callback, delay };
      intervalHandles.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      clearedIntervals.push(handle);
    },
  });

  return {
    ownerUid,
    homeId,
    home,
    accountCache,
    dbValues,
    updates,
    client,
    published,
    intervalHandles,
    clearedIntervals,
    domain,
  };
}

test("siren configuration and manual mute normalization stay bounded", () => {
  const { domain } = createHarness();

  assert.equal(domain.normalizeHomeSirenVolume("MEDIUM"), "medium");
  assert.equal(domain.normalizeHomeSirenVolume("loud"), "high");
  assert.equal(domain.normalizeHomeSirenMelody(18), "18");
  assert.equal(domain.normalizeHomeSirenMelody(99), "1");
  assert.equal(domain.normalizeHomeSirenDuration(30), 30);
  assert.equal(
    domain.normalizeHomeSirenDuration(5000),
    HOME_SIREN_COMMAND_DURATION_SEC,
  );
  assert.deepEqual(
    domain.normalizeHomeSirenManualMute({
      active: true,
      mutedAt: 10,
      mutedBy: " user ",
      mutedIncidentKeys: { valid: true, ignored: false },
    }),
    {
      active: true,
      mutedAt: 10,
      mutedBy: "user",
      mutedIncidentKeys: { valid: true },
    },
  );
  assert.match(
    domain.getHomeSirenIncidentMuteKey("receiver", "incident"),
    /^[a-f0-9]{24}$/,
  );
});

test("device selection and reachability use type, availability and last_seen", () => {
  const now = Date.now();
  const { domain } = createHarness({
    home: {
      devices: {
        online: { type: "siren", availability: "online", last_seen: now },
        stale: { type: "siren", availability: "online", last_seen: now - 9 * 60 * 60 * 1000 },
        door: { type: "door", availability: "online", last_seen: now },
      },
    },
  });

  const devices = domain.getHomeSirenDevicesFromHome({
    devices: {
      siren: { type: "siren" },
      door: { type: "door" },
    },
  });

  assert.deepEqual(devices.map((entry) => entry.deviceId), ["siren"]);
  assert.equal(
    domain.isHomeSirenDeviceReachable(
      { availability: "online", last_seen: now },
      now,
    ),
    true,
  );
  assert.equal(
    domain.isHomeSirenDeviceReachable(
      { availability: "online", last_seen: now - 9 * 60 * 60 * 1000 },
      now,
    ),
    false,
  );
});

test("start command is confirmed only after the siren reports alarm on", async () => {
  const now = Date.now();
  const home = {
    devices: {
      siren1: {
        type: "siren",
        availability: "online",
        last_seen: now,
        alarm: false,
        last_siren_report_at: 0,
      },
    },
  };
  const harness = createHarness({ home });
  harness.client.publish = (topic, payload, options, callback) => {
    harness.published.push({ topic, payload: JSON.parse(payload), options });
    home.devices.siren1.alarm = true;
    home.devices.siren1.last_siren_report_at = Date.now() + 1;
    callback(null);
  };

  const result = await harness.domain.setPhysicalSirenForHome(
    harness.ownerUid,
    harness.homeId,
    true,
  );

  assert.equal(result.status, "active");
  assert.equal(result.confirmedCount, 1);
  assert.deepEqual(harness.published[0].payload, {
    alarm: true,
    volume: "high",
    melody: "1",
    duration: 1800,
  });
  assert.equal(
    harness.domain.getHomeSirenRuntime(
      harness.ownerUid,
      harness.homeId,
    ).desiredOn,
    true,
  );
});

test("stop command persists alarm off only after a confirmed report", async () => {
  const now = Date.now();
  const home = {
    devices: {
      siren1: {
        type: "siren",
        availability: "online",
        last_seen: now,
        alarm: true,
        last_siren_report_at: 0,
      },
    },
  };
  const harness = createHarness({ home });
  harness.client.publish = (topic, payload, options, callback) => {
    harness.published.push({ topic, payload: JSON.parse(payload), options });
    home.devices.siren1.alarm = false;
    home.devices.siren1.last_siren_report_at = Date.now() + 1;
    callback(null);
  };

  const result = await harness.domain.setPhysicalSirenForHome(
    harness.ownerUid,
    harness.homeId,
    false,
    { force: true },
  );

  assert.equal(result.status, "stopped");
  assert.equal(result.confirmedCount, 1);
  assert.deepEqual(harness.published[0].payload, { alarm: false });
  assert.equal(home.devices.siren1.alarm, false);
  assert.equal(home.devices.siren1.siren_command_status, "off_confirmed");
});

test("active incident demand keys are scoped by receiver and policy", () => {
  const accountCache = new Map([
    ["owner", {
      homes: { home: { devices: {} } },
      alarmIncidents: {
        first: { ownerUid: "owner", homeId: "home", status: "active", physicalSirenEnabled: true },
        disabled: { ownerUid: "owner", homeId: "home", status: "active", physicalSirenEnabled: false },
      },
    }],
    ["member", {
      homes: {},
      alarmIncidents: {
        second: { ownerUid: "owner", homeId: "home", status: "active", physicalSirenEnabled: true },
      },
    }],
  ]);
  const { domain } = createHarness({ accountCache });

  assert.equal(domain.collectHomeIncidentKeysInCache("owner", "home").size, 3);
  assert.equal(domain.collectPhysicalSirenDemandKeysInCache("owner", "home").size, 2);
});

test("physical siren monitor starts once and can be stopped", () => {
  const harness = createHarness();

  harness.domain.startPhysicalSirenMonitor();
  harness.domain.startPhysicalSirenMonitor();

  assert.equal(harness.intervalHandles.length, 1);
  assert.equal(harness.intervalHandles[0].delay, 15000);

  harness.domain.stopPhysicalSirenMonitor();
  assert.equal(harness.clearedIntervals.length, 1);
});


test("periodic result logging is throttled until state changes or interval expires", () => {
  const harness = createHarness();
  const originalNow = Date.now;
  let now = 1000;

  Date.now = () => now;
  try {
    const input = {
      shouldTurnOn: false,
      status: "stopped_unconfirmed",
      successCount: 1,
      deviceCount: 1,
      confirmedCount: 0,
      reason: "periodic_reconcile",
    };

    assert.equal(
      harness.domain.shouldLogHomeSirenResult("owner|home", input),
      true,
    );
    assert.equal(
      harness.domain.shouldLogHomeSirenResult("owner|home", input),
      false,
    );

    now += 5 * 60 * 1000;
    assert.equal(
      harness.domain.shouldLogHomeSirenResult("owner|home", input),
      true,
    );
    assert.equal(
      harness.domain.shouldLogHomeSirenResult("owner|home", {
        ...input,
        status: "stopped",
        confirmedCount: 1,
      }),
      true,
    );
  } finally {
    Date.now = originalNow;
  }
});
