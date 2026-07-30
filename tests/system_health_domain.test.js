"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSystemHealthDomain,
} = require("../domains/system_health/system_health");

function createDomain(overrides = {}) {
  const writes = [];
  const notifications = [];
  const accounts = overrides.accounts || new Map();
  let currentTime = overrides.currentTime ?? 2_000_000;
  let connected = overrides.connected ?? true;
  let intervalCallback = null;
  let intervalCount = 0;
  let clearCount = 0;

  const domain = createSystemHealthDomain({
    db: {
      ref: () => ({
        update: async (updates) => {
          writes.push(updates);
        },
      }),
    },
    getFirebaseConnected: () => connected,
    getAccountsEntries: () => accounts.entries(),
    addHomeNotificationToHomeRecipients: async (payload) => {
      notifications.push(payload);
    },
    normalizeLockState: (device) =>
      String(device?.state || device?.lock_state || "unknown")
        .trim()
        .toLowerCase(),
    isActiveSignal: (value) => value === true || value === "active",
    isSecurityDeviceType: (type) =>
      ["door", "window", "gate", "door_lock", "lock"].includes(type),
    isEmergencyDeviceType: (type) =>
      ["smoke", "sos", "carbon_monoxide", "gas", "water_leak"].includes(
        type,
      ),
    now: () => currentTime,
    startedAt: overrides.startedAt ?? 0,
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
    setCurrentTime: (value) => {
      currentTime = value;
    },
    setConnected: (value) => {
      connected = value;
    },
    getIntervalCallback: () => intervalCallback,
    getIntervalCount: () => intervalCount,
    getClearCount: () => clearCount,
  };
}

test("fresh last_seen wins over early Zigbee offline availability", () => {
  const now = new Date("2026-07-23T00:00:00.000Z").getTime();
  const { domain } = createDomain({ currentTime: now });

  const freshIssues = domain.evaluateDeviceSystemHealth(
    "smokeA",
    {
      type: "smoke",
      availability: "offline",
      last_seen: now - 2 * 60 * 60 * 1000,
    },
    now,
  );
  const staleIssues = domain.evaluateDeviceSystemHealth(
    "smokeA",
    {
      type: "smoke",
      availability: "online",
      last_seen: now - 32 * 60 * 60 * 1000,
    },
    now,
  );

  assert.equal(
    freshIssues.some((issue) => issue.code === "device_offline"),
    false,
  );
  assert.equal(
    staleIssues.some((issue) => issue.code === "device_offline"),
    true,
  );
});

test("home safety keeps danger issues separate from system warnings", () => {
  const now = 3_000_000;
  const { domain } = createDomain({ currentTime: now });
  const result = domain.getHomeNotificationSafety({
    hubId: "hub-a",
    hubStatus: {
      lastHeartbeatAt: now - 10_000,
      mqttConnected: true,
    },
    devices: {
      doorA: {
        type: "door",
        name: "Cửa chính",
        contact: false,
        availability: "online",
        last_seen: now,
      },
      smokeA: {
        type: "smoke",
        name: "Báo khói",
        availability: "online",
        last_seen: now,
        battery: 18,
      },
    },
  });

  assert.deepEqual(result.dangerIssues, ["Cửa chính: đang mở"]);
  assert.deepEqual(result.systemWarnings, ["Báo khói: pin yếu"]);
  assert.equal(result.safe, false);
  assert.equal(result.protectionComplete, false);
});

test("health check writes one transition and suppresses duplicate runtime writes", async () => {
  const now = 4_000_000;
  const accounts = new Map([
    [
      "owner-a",
      {
        homes: {
          "home-a": {
            name: "Nhà A",
            systemHealth: {
              status: "ok",
              protectionComplete: true,
              issueSignature: "",
              issues: [],
              evaluatedAt: now - 60_000,
            },
            devices: {
              smokeA: {
                type: "smoke",
                name: "Báo khói",
                availability: "online",
                last_seen: now,
                battery: 10,
              },
            },
          },
        },
      },
    ],
  ]);
  const { domain, writes, notifications } = createDomain({
    accounts,
    currentTime: now,
  });

  await domain.checkSystemHealth();
  await domain.checkSystemHealth();

  assert.equal(writes.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "system_device_low_battery");
  assert.equal(
    writes[0]["accounts/owner-a/homes/home-a/systemHealth"].status,
    "warning",
  );
});


test("health check clears expired emergency hold fields", async () => {
  const now = 5_000_000;
  const accounts = new Map([
    [
      "owner-a",
      {
        homes: {
          "home-a": {
            systemHealth: {
              status: "ok",
              protectionComplete: true,
              issueSignature: "",
              issues: [],
              evaluatedAt: now - 60_000,
            },
            devices: {
              sosA: {
                type: "sos",
                availability: "online",
                last_seen: now,
                emergency_active_until: now - 1,
                sos_active_until: now - 1,
              },
            },
          },
        },
      },
    ],
  ]);
  const { domain, writes } = createDomain({ accounts, currentTime: now });

  await domain.checkSystemHealth();

  assert.equal(writes.length, 1);
  assert.equal(
    writes[0][
      "accounts/owner-a/homes/home-a/devices/sosA/emergency_active_until"
    ],
    null,
  );
  assert.equal(
    writes[0][
      "accounts/owner-a/homes/home-a/devices/sosA/sos_active_until"
    ],
    null,
  );
});

test("system health monitor starts once and can be stopped", () => {
  const runtime = createDomain({ connected: false });

  runtime.domain.startSystemHealthMonitor();
  runtime.domain.startSystemHealthMonitor();

  assert.equal(runtime.getIntervalCount(), 1);
  assert.equal(typeof runtime.getIntervalCallback(), "function");

  runtime.domain.stopSystemHealthMonitor();
  assert.equal(runtime.getClearCount(), 1);
});
