"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  buildNewDeviceRecord,
  createDeviceManagementDomain,
  getDefaultDeviceName,
  isPairRequestFresh,
  normalizePairRequest,
} = require("../domains/devices/device_management");

function keyFromPath(path) {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean);

  return parts.at(-1) || null;
}

function createSnapshot(db, path, value) {
  return {
    key: keyFromPath(path),
    ref: db.ref(path),
    val: () => value,
    exists: () => value !== undefined && value !== null,
  };
}

function createFakeDb(initial = {}) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  const operations = [];

  function listenerKey(path, eventName) {
    return `${path}|${eventName}`;
  }

  function ref(rawPath = "") {
    const path = String(rawPath || "").replace(/^\/+|\/+$/g, "");

    return {
      path,
      on(eventName, handler) {
        const key = listenerKey(path, eventName);
        const handlers = listeners.get(key) || new Set();
        handlers.add(handler);
        listeners.set(key, handlers);
      },
      off(eventName, handler) {
        const key = listenerKey(path, eventName);
        const handlers = listeners.get(key);

        if (!handlers) {
          return;
        }

        handlers.delete(handler);
      },
      async once() {
        return createSnapshot(db, path, values.get(path));
      },
      async set(value) {
        operations.push({ type: "set", path, value });
        values.set(path, value);
      },
      async update(updateValue) {
        operations.push({ type: "update", path, value: updateValue });

        if (path === "") {
          for (const [childPath, childValue] of Object.entries(updateValue)) {
            if (childValue === null) {
              values.delete(childPath);
            } else {
              values.set(childPath, childValue);
            }
          }
          return;
        }

        const previous = values.get(path) || {};
        values.set(path, { ...previous, ...updateValue });
      },
      async remove() {
        operations.push({ type: "remove", path });
        values.delete(path);
      },
    };
  }

  const db = {
    ref,
    async emit(path, eventName, childKey, value) {
      const handlers = Array.from(
        listeners.get(listenerKey(path, eventName)) || [],
      );
      const childPath = [path, childKey].filter(Boolean).join("/");
      const snapshot = createSnapshot(db, childPath, value);
      await Promise.all(handlers.map((handler) => handler(snapshot)));
    },
    listenerCount(path, eventName) {
      return (
        listeners.get(listenerKey(path, eventName))?.size || 0
      );
    },
    operations,
    values,
  };

  return db;
}

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.published = [];
  }

  publish(topic, payload, callback) {
    this.published.push({
      topic,
      payload: JSON.parse(payload),
    });
    callback?.(null);
  }
}

function createHarness(overrides = {}) {
  const nowValue = overrides.nowValue || 1000000;
  const db = overrides.db || createFakeDb(overrides.initial || {});
  const client = overrides.client || new FakeMqttClient();
  const deviceMap = overrides.deviceMap || {};
  const notifications = [];
  const forgotten = [];
  const timers = [];
  const logs = [];
  let snapshotSaves = 0;

  const domain = createDeviceManagementDomain({
    client,
    db,
    deviceMap,
    deviceId: "hub-1",
    getDeviceTypeFromModel:
      overrides.getDeviceTypeFromModel || (() => "door"),
    isSecurityDeviceType:
      overrides.isSecurityDeviceType ||
      ((type) => ["door", "smoke", "sos"].includes(type)),
    getCachedHomeData:
      overrides.getCachedHomeData ||
      ((uid, homeId) => ({ name: `${uid}-${homeId}` })),
    getSharedMembersForHome:
      overrides.getSharedMembersForHome || (() => ({})),
    addHomeNotificationToHomeRecipients: async (payload) => {
      notifications.push(payload);
    },
    scheduleLocalRuntimeSnapshotSave: () => {
      snapshotSaves += 1;
    },
    forgetDeviceRuntime: (deviceId) => {
      forgotten.push(deviceId);
      return true;
    },
    now: () => nowValue,
    wait: async () => {},
    setTimeoutFn: (handler, delay) => {
      const timer = {
        handler,
        delay,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    deviceRemoveDelayMs: 0,
    log: (...args) => logs.push(args),
  });

  return {
    client,
    db,
    deviceMap,
    domain,
    forgotten,
    getSnapshotSaves: () => snapshotSaves,
    logs,
    notifications,
    nowValue,
    timers,
  };
}

function pairRequest(nowValue, overrides = {}) {
  return {
    active: true,
    requestedBy: "owner",
    ownerUid: "owner",
    homeId: "h1",
    hubId: "hub-1",
    roomId: "room-1",
    duration: 60,
    time: nowValue,
    ...overrides,
  };
}

test("pair request normalization and default device naming stay deterministic", () => {
  assert.equal(isPairRequestFresh(999000, 1000000), true);
  assert.equal(isPairRequestFresh(600000, 1000000), false);

  const normalized = normalizePairRequest(
    pairRequest(1000000),
    1000000,
  );
  assert.equal(normalized.valid, true);
  assert.equal(normalized.roomId, "room-1");

  assert.equal(getDefaultDeviceName("door", {}), "Cửa Nhà");
  assert.equal(
    getDefaultDeviceName("door", {
      a: { type: "door", name: "Cửa Nhà" },
      b: { type: "door", name: "Cửa Nhà 3" },
    }),
    "Cửa Nhà 4",
  );

  const record = buildNewDeviceRecord({
    ieee: "d1",
    deviceType: "door",
    roomId: "r1",
    timestamp: 10,
    isSecurityDeviceType: () => true,
  });
  assert.equal(record.alarmPolicy.enabled, true);
  assert.equal(record.alarmSchedules.default.start, "23:00");
  assert.equal(record.availability, "unknown");
});

test("device management listeners start once and stop cleanly", async () => {
  const harness = createHarness();

  assert.equal(harness.domain.startDeviceManagement(), true);
  assert.equal(harness.domain.startDeviceManagement(), false);
  assert.equal(
    harness.db.listenerCount("system/devices_by_ieee", "child_added"),
    1,
  );
  assert.equal(
    harness.db.listenerCount("pair_requests", "child_added"),
    1,
  );
  assert.equal(
    harness.db.listenerCount("device_delete_requests", "child_added"),
    1,
  );
  assert.equal(harness.client.listenerCount("message"), 1);

  assert.equal(await harness.domain.stopDeviceManagement(), true);
  assert.equal(await harness.domain.stopDeviceManagement(), false);
  assert.equal(harness.client.listenerCount("message"), 0);
  assert.equal(
    harness.db.listenerCount("pair_requests", "child_added"),
    0,
  );
});

test("canonical device index updates and forgets local runtime safely", () => {
  const harness = createHarness();

  harness.domain.upsertDeviceIndex(
    createSnapshot(harness.db, "system/devices_by_ieee/d1", {
      uid: "u1",
      homeId: "h1",
    }),
  );
  assert.deepEqual(harness.deviceMap.d1, { uid: "u1", homeId: "h1" });

  harness.domain.removeDeviceIndex(
    createSnapshot(harness.db, "system/devices_by_ieee/d1", null),
  );
  assert.equal(harness.deviceMap.d1, undefined);
  assert.deepEqual(harness.forgotten, ["d1"]);
  assert.equal(harness.getSnapshotSaves(), 2);
});

test("stale pair request is rejected before permit-join", async () => {
  const harness = createHarness();
  const path = "pair_requests/r1";
  const request = pairRequest(harness.nowValue, {
    time: harness.nowValue - 10 * 60 * 1000,
  });
  harness.db.values.set(path, request);

  await harness.domain.handlePairRequest(
    createSnapshot(harness.db, path, request),
  );

  assert.equal(harness.client.published.length, 0);
  assert.equal(harness.db.values.has(path), false);
  assert.equal(harness.domain.getRuntimeState().pairingActive, false);
});

test("home admin can start pairing and request removal closes permit-join", async () => {
  const initial = {
    "accounts/owner/homes/h1": {
      name: "Nhà chính",
      rooms: { "room-1": { name: "Khách" } },
    },
    "accounts/admin/sharedHomes/h1": {
      ownerUid: "owner",
      role: "admin",
    },
  };
  const harness = createHarness({ initial });
  const path = "pair_requests/r1";
  const request = pairRequest(harness.nowValue, {
    requestedBy: "admin",
  });

  await harness.domain.handlePairRequest(
    createSnapshot(harness.db, path, request),
  );

  assert.equal(harness.domain.getRuntimeState().pairingActive, true);
  assert.deepEqual(harness.client.published[0], {
    topic: "zigbee2mqtt/bridge/request/permit_join",
    payload: { value: true, time: 60 },
  });

  await harness.domain.handlePairRequestRemoved(
    createSnapshot(harness.db, path, request),
  );

  assert.equal(harness.domain.getRuntimeState().pairingActive, false);
  assert.equal(harness.client.published.at(-1).payload.value, false);
});

test("member without Admin role cannot start pairing", async () => {
  const initial = {
    "accounts/owner/homes/h1": {
      rooms: { "room-1": {} },
    },
    "accounts/member/sharedHomes/h1": {
      ownerUid: "owner",
      role: "member",
    },
  };
  const harness = createHarness({ initial });
  const path = "pair_requests/r2";
  const request = pairRequest(harness.nowValue, {
    requestedBy: "member",
  });
  harness.db.values.set(path, request);

  await harness.domain.handlePairRequest(
    createSnapshot(harness.db, path, request),
  );

  assert.equal(harness.client.published.length, 0);
  assert.equal(harness.db.values.has(path), false);
});

test("announce without a definition waits for the interview result", async () => {
  const initial = {
    "accounts/owner/homes/h1": {
      rooms: { "room-1": {} },
    },
    "accounts/owner/homes/h1/devices": {},
  };
  const harness = createHarness({ initial });
  const request = pairRequest(harness.nowValue);

  await harness.domain.handlePairRequest(
    createSnapshot(harness.db, "pair_requests/wait", request),
  );
  await harness.domain.handleMqttPairingMessage(
    "zigbee2mqtt/bridge/event",
    Buffer.from(
      JSON.stringify({
        type: "device_announce",
        data: { ieee_address: "0xwait" },
      }),
    ),
  );

  assert.equal(
    harness.db.values.has(
      "accounts/owner/homes/h1/devices/0xwait",
    ),
    false,
  );
  assert.equal(harness.notifications.length, 0);
});

test("Zigbee interview persists one canonical device and deduplicates repeated events", async () => {
  const initial = {
    "accounts/owner/homes/h1": {
      name: "Nhà chính",
      rooms: { "room-1": {} },
    },
    "accounts/owner/homes/h1/devices": {
      old: { name: "Cửa Nhà", type: "door" },
    },
  };
  const harness = createHarness({ initial });
  const pairPath = "pair_requests/r3";
  const request = pairRequest(harness.nowValue);

  await harness.domain.handlePairRequest(
    createSnapshot(harness.db, pairPath, request),
  );

  const message = Buffer.from(
    JSON.stringify({
      type: "device_interview",
      data: {
        ieee_address: "0xabc",
        definition: {
          model: "SNZB-04P",
          description: "Door sensor",
        },
      },
    }),
  );

  await harness.domain.handleMqttPairingMessage(
    "zigbee2mqtt/bridge/event",
    message,
  );
  await harness.domain.handleMqttPairingMessage(
    "zigbee2mqtt/bridge/event",
    message,
  );

  const stored = harness.db.values.get(
    "accounts/owner/homes/h1/devices/0xabc",
  );
  assert.equal(stored.name, "Cửa Nhà 2");
  assert.equal(stored.type, "door");
  assert.equal(stored.roomId, "room-1");
  assert.equal(stored.alarmPolicy.enabled, true);
  assert.deepEqual(harness.deviceMap["0xabc"], {
    uid: "owner",
    homeId: "h1",
  });
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].actorUid, "owner");
  assert.equal(
    harness.domain.getRuntimeState().pairedDeviceCount,
    1,
  );
});

test("device deletion requires Owner or Admin permission", async () => {
  const initial = {
    "accounts/member/sharedHomes/h1": {
      ownerUid: "owner",
      role: "member",
    },
    "accounts/owner/homes/h1/devices/d1": {
      name: "Cửa",
      type: "door",
    },
  };
  const harness = createHarness({ initial });
  const requestPath = "device_delete_requests/x1";
  const request = {
    status: "pending",
    ownerUid: "owner",
    homeId: "h1",
    deviceId: "d1",
    requestedBy: "member",
  };
  harness.db.values.set(requestPath, request);

  await harness.domain.handleDeviceDeleteRequest(
    createSnapshot(harness.db, requestPath, request),
  );

  assert.equal(
    harness.client.published.some((entry) =>
      entry.topic.includes("device/remove"),
    ),
    false,
  );
  assert.equal(harness.db.values.has(requestPath), false);
});

test("authorized deletion removes Zigbee device, Firebase index and personal rules", async () => {
  const initial = {
    "accounts/owner/homes/h1/devices/d1": {
      name: "Cửa chính",
      type: "door",
    },
    "system/devices_by_ieee/d1": {
      uid: "owner",
      homeId: "h1",
    },
  };
  const harness = createHarness({
    initial,
    deviceMap: { d1: { uid: "owner", homeId: "h1" } },
    getSharedMembersForHome: () => ({ member: { role: "member" } }),
  });
  const requestPath = "device_delete_requests/x2";
  const request = {
    status: "pending",
    ownerUid: "owner",
    homeId: "h1",
    deviceId: "d1",
    requestedBy: "owner",
  };

  await harness.domain.handleDeviceDeleteRequest(
    createSnapshot(harness.db, requestPath, request),
  );

  const removePublish = harness.client.published.find((entry) => {
    return entry.topic === "zigbee2mqtt/bridge/request/device/remove";
  });
  assert.deepEqual(removePublish.payload, { id: "d1", force: true });

  const rootUpdate = harness.db.operations.find((operation) => {
    return operation.type === "update" && operation.path === "";
  });
  assert.equal(
    rootUpdate.value["accounts/owner/homes/h1/devices/d1"],
    null,
  );
  assert.equal(rootUpdate.value["system/devices_by_ieee/d1"], null);
  assert.equal(
    rootUpdate.value[
      "accounts/owner/customRules/h1/devices/d1"
    ],
    null,
  );
  assert.equal(
    rootUpdate.value[
      "accounts/member/customRules/h1/devices/d1"
    ],
    null,
  );
  assert.equal(harness.deviceMap.d1, undefined);
  assert.deepEqual(harness.forgotten, ["d1"]);
  assert.equal(harness.notifications[0].type, "device_delete_succeeded");
});

test("foreign device index blocks destructive deletion", async () => {
  const initial = {
    "accounts/owner/homes/h1/devices/d1": {
      name: "Cửa chính",
      type: "door",
    },
    "system/devices_by_ieee/d1": {
      uid: "other-owner",
      homeId: "other-home",
    },
  };
  const harness = createHarness({ initial });
  const requestPath = "device_delete_requests/x3";
  const request = {
    status: "pending",
    ownerUid: "owner",
    homeId: "h1",
    deviceId: "d1",
    requestedBy: "owner",
  };

  await harness.domain.handleDeviceDeleteRequest(
    createSnapshot(harness.db, requestPath, request),
  );

  assert.equal(
    harness.client.published.some((entry) =>
      entry.topic.includes("device/remove"),
    ),
    false,
  );
  assert.equal(harness.notifications[0].type, "device_delete_failed");
});
