"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createHomeStatusAggregation,
  runtimeSignature,
  buildAutoAwayRuntime,
  presenceSummarySignature,
  buildPresenceSummary,
} = require("../domains/home/home_status_aggregation");

function createAggregation({
  currentTime = 2_000_000,
  startedAt = 0,
} = {}) {
  let nowValue = currentTime;

  const aggregation = createHomeStatusAggregation({
    normalizeLockState: (device) =>
      String(device?.state || device?.lock_state || "unknown")
        .trim()
        .toLowerCase(),
    isActiveSignal: (value) => value === true || value === "active",
    isSecurityDeviceType: (type) =>
      ["door", "window", "gate", "door_lock", "lock"].includes(type),
    isEmergencyDeviceType: (type) =>
      [
        "smoke",
        "sos",
        "carbon_monoxide",
        "gas",
        "water_leak",
        "flood",
      ].includes(type),
    now: () => nowValue,
    startedAt,
  });

  return {
    aggregation,
    setCurrentTime: (value) => {
      nowValue = value;
    },
  };
}

test("system timestamps and availability values normalize deterministically", () => {
  const { aggregation } = createAggregation();
  const iso = "2026-07-31T12:00:00.000Z";

  assert.equal(
    aggregation.parseSystemHealthTimestamp(1234),
    1234,
  );
  assert.equal(
    aggregation.parseSystemHealthTimestamp(iso),
    new Date(iso).getTime(),
  );
  assert.equal(
    aggregation.isSystemHealthExplicitlyOffline({ state: "OFFLINE" }),
    true,
  );
  assert.equal(
    aggregation.isSystemHealthExplicitlyOnline({ status: "connected" }),
    true,
  );
});

test("fresh last_seen wins over early Zigbee offline availability", () => {
  const now = new Date("2026-07-31T12:00:00.000Z").getTime();
  const { aggregation } = createAggregation({ currentTime: now });

  const freshIssues = aggregation.evaluateDeviceSystemHealth(
    "smoke-a",
    {
      type: "smoke",
      availability: "offline",
      last_seen: now - 2 * 60 * 60 * 1000,
    },
    now,
  );
  const staleIssues = aggregation.evaluateDeviceSystemHealth(
    "smoke-a",
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

test("device health reports bounded low-battery metadata", () => {
  const { aggregation } = createAggregation();
  const issues = aggregation.evaluateDeviceSystemHealth(
    "door-a",
    {
      type: "door",
      name: "Cửa chính",
      availability: "online",
      last_seen: 2_000_000,
      battery: 20,
    },
    2_000_000,
  );

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["device_low_battery"],
  );
  assert.equal(issues[0].battery, 20);
  assert.equal(issues[0].protectionRelevant, true);
});

test("home health separates Hub and device warnings with a stable signature", () => {
  const now = 4_000_000;
  const { aggregation } = createAggregation({ currentTime: now });
  const health = aggregation.evaluateHomeSystemHealth(
    {
      hubId: "hub-a",
      hubStatus: {
        lastHeartbeatAt: now - 10_000,
        mqttConnected: false,
      },
      devices: {
        smokeA: {
          type: "smoke",
          name: "Báo khói",
          availability: "online",
          last_seen: now,
          battery_low: true,
        },
      },
    },
    now,
  );

  assert.equal(health.status, "warning");
  assert.equal(health.protectionComplete, false);
  assert.deepEqual(
    health.issues.map((issue) => issue.code),
    ["device_low_battery", "mqtt_offline"],
  );
  assert.equal(
    health.issueSignature,
    "device_low_battery:smokeA|mqtt_offline:hub-a",
  );
});

test("home safety keeps danger issues separate from system warnings", () => {
  const now = 5_000_000;
  const { aggregation } = createAggregation({ currentTime: now });
  const safety = aggregation.getHomeNotificationSafety({
    hubId: "hub-a",
    hubStatus: {
      lastHeartbeatAt: now,
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

  assert.deepEqual(safety.dangerIssues, ["Cửa chính: đang mở"]);
  assert.deepEqual(safety.systemWarnings, ["Báo khói: pin yếu"]);
  assert.deepEqual(safety.unsafeDevices, [
    "Cửa chính: đang mở",
    "Báo khói: pin yếu",
  ]);
  assert.equal(safety.safe, false);
  assert.equal(safety.protectionComplete, false);
});

test("recent SOS is unsafe but expires from the Home summary", () => {
  const now = 6_000_000;
  const { aggregation, setCurrentTime } = createAggregation({
    currentTime: now,
  });
  const home = {
    devices: {
      sosA: {
        type: "sos",
        name: "Nút SOS",
        last_triggered: now - 30_000,
        availability: "online",
        last_seen: now,
      },
    },
  };

  assert.deepEqual(
    aggregation.getHomeNotificationSafety(home).dangerIssues,
    ["Nút SOS: đã kích hoạt SOS"],
  );

  setCurrentTime(now + 61_000);
  assert.deepEqual(
    aggregation.getHomeNotificationSafety(home).dangerIssues,
    [],
  );
});

test("Auto Away runtime keeps display counts separate from arming counts", () => {
  const runtime = buildAutoAwayRuntime({
    status: "monitoring",
    totalMemberCount: 5,
    participantCount: 3,
    memberCount: 5,
    eligibleMemberCount: 2,
    excludedCount: 1,
    insideCount: 2,
    outsideCount: 2,
    unknownCount: 1,
    armingInsideCount: 1,
    armingOutsideCount: 1,
    allOutsideSince: 0,
    cycleArmed: false,
    now: 7_000_000,
  });

  assert.equal(runtime.memberCount, 5);
  assert.equal(runtime.eligibleMemberCount, 2);
  assert.equal(runtime.unknownCount, 1);
  assert.equal(runtime.armingUnknownCount, 0);
  assert.equal(runtime.allOutsideSince, null);
});

test("Presence summary signatures ignore timestamps and detect count changes", () => {
  const first = buildPresenceSummary({
    totalMemberCount: 5,
    participantCount: 3,
    participantInsideCount: 1,
    participantOutsideCount: 1,
    participantUnknownCount: 1,
    signedInCount: 4,
    onlineCount: 2,
    connectedCount: 2,
    memberCount: 5,
    eligibleMemberCount: 2,
    excludedCount: 1,
    insideCount: 2,
    outsideCount: 2,
    unknownCount: 1,
    knownLocationCount: 4,
    armingInsideCount: 1,
    armingOutsideCount: 1,
    armingUnknownCount: 0,
    unavailableCount: 1,
    now: 8_000_000,
  });
  const timestampOnly = { ...first, updatedAt: 9_000_000 };
  const changed = { ...timestampOnly, unknownCount: 2 };

  assert.equal(
    presenceSummarySignature(first),
    presenceSummarySignature(timestampOnly),
  );
  assert.notEqual(
    presenceSummarySignature(first),
    presenceSummarySignature(changed),
  );
  assert.equal(
    runtimeSignature({ status: "idle", memberCount: 5 }),
    runtimeSignature({ status: "idle", memberCount: 5 }),
  );
});
