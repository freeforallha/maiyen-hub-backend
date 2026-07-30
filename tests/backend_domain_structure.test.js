"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const { createHubHeartbeat } = require("../domains/hub/hub_heartbeat");
const { createOrderedListCleanup } = require(
  "../domains/shared/ordered_list_cleanup",
);

test("composition root uses extracted Hub, health and cleanup domains", () => {
  const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

  assert.match(source, /createHubIdentity/);
  assert.match(source, /createHubHeartbeat/);
  assert.match(source, /createOrderedListCleanup/);
  assert.match(source, /createSystemHealthDomain/);
  assert.doesNotMatch(source, /function readConnectedWifiInfo\(/);
  assert.doesNotMatch(source, /async function getHomesLinkedToThisHub\(/);
  assert.doesNotMatch(source, /async function trimOrderedListByTime\(/);
  assert.doesNotMatch(source, /function evaluateHomeSystemHealth\(/);

  const deploySource = fs.readFileSync(
    path.join(ROOT, "scripts", "deploy_backend_production.sh"),
    "utf8",
  );
  assert.match(
    deploySource,
    /domains\/system_health\/system_health\.js/,
  );
});

test("Hub heartbeat writes only linked homes and keeps one global heartbeat", async () => {
  const writes = [];
  const index = {
    a: { deviceId: "dev_test", uid: "ownerA", homeId: "homeA" },
    b: { deviceId: "dev_other", uid: "ownerB", homeId: "homeB" },
    c: { deviceId: "dev_test", uid: "ownerA", homeId: "homeA" },
  };
  const db = {
    ref(pathValue = "") {
      if (pathValue === "system/devices_by_ieee") {
        return { once: async () => ({ val: () => index }) };
      }
      assert.equal(pathValue, "");
      return { update: async (value) => writes.push(value) };
    },
  };
  const runtime = createHubHeartbeat({
    db,
    deviceId: "dev_test",
    hubName: "MaiYen Hub",
    hubModel: "Pi",
    startedAt: 1,
    intervalMs: 60000,
    readConnectedWifiInfo: () => ({
      connected: true,
      ssid: "Home",
      interfaceName: "wlan0",
    }),
    getMqttConnected: () => true,
    getSystemVersionHeartbeatFields: () => ({ backendVersion: "1.2.11" }),
    getHubUpdateHeartbeatFields: () => ({ updateAvailable: false }),
    processId: 123,
    log: () => {},
  });

  await runtime.writeHubHeartbeat();

  assert.equal(writes.length, 1);
  assert.ok(writes[0]["system/hubs/dev_test"]);
  assert.equal(
    writes[0]["accounts/ownerA/homes/homeA/hubId"],
    "dev_test",
  );
  assert.equal(
    writes[0]["accounts/ownerB/homes/homeB/hubId"],
    undefined,
  );
});

test("ordered timeline cleanup removes only the oldest overflow", async () => {
  const updates = [];
  const children = ["a", "b", "c", "d", "e"];
  const listRef = {
    orderByChild() { return this; },
    limitToFirst() { return this; },
    async once() {
      return {
        forEach(callback) {
          for (const key of children) callback({ key });
        },
      };
    },
    async update(value) {
      updates.push(value);
      children.splice(0, Object.keys(value).length);
    },
  };
  const cleanup = createOrderedListCleanup({ batchSize: 2, maxPasses: 2 });

  await cleanup.trimOrderedListByTime(listRef, 3);

  assert.deepEqual(updates, [{ a: null, b: null }]);
});
