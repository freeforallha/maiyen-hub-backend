"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFirebaseRequestCoordinator,
  normalizeListenerKey,
} = require("../domains/runtime/firebase_request_coordinator");

function createFakeDb() {
  const refs = new Map();

  function getRef(path) {
    if (!refs.has(path)) {
      const listeners = new Map();

      refs.set(path, {
        path,
        listeners,
        on(event, handler) {
          if (!listeners.has(event)) {
            listeners.set(event, new Set());
          }

          listeners.get(event).add(handler);
        },
        off(event, handler) {
          listeners.get(event)?.delete(handler);
        },
        emit(event, snapshot) {
          for (const handler of listeners.get(event) || []) {
            handler(snapshot);
          }
        },
        listenerCount(event) {
          return listeners.get(event)?.size || 0;
        },
      });
    }

    return refs.get(path);
  }

  return {
    db: { ref: getRef },
    getRef,
  };
}

test("listener identity uses explicit keys and deterministic fallback", () => {
  assert.equal(
    normalizeListenerKey(" account-change ", "accounts", "child_changed"),
    "account-change",
  );
  assert.equal(
    normalizeListenerKey("", "accounts", "child_changed"),
    "accounts|child_changed",
  );
});

test("registered listeners attach once when the coordinator starts", () => {
  const { db, getRef } = createFakeDb();
  const coordinator = createFirebaseRequestCoordinator({ db, log() {} });

  assert.equal(
    coordinator.registerListener({
      key: "request:pause",
      path: "alarm_pause_requests",
      event: "child_added",
      handler() {},
    }),
    true,
  );

  assert.equal(getRef("alarm_pause_requests").listenerCount("child_added"), 0);
  assert.equal(coordinator.startFirebaseRequestCoordinator(), true);
  assert.equal(getRef("alarm_pause_requests").listenerCount("child_added"), 1);
  assert.equal(coordinator.startFirebaseRequestCoordinator(), false);
  assert.equal(getRef("alarm_pause_requests").listenerCount("child_added"), 1);
});

test("duplicate listener keys are rejected before Firebase registration", () => {
  const { db, getRef } = createFakeDb();
  const coordinator = createFirebaseRequestCoordinator({ db, log() {} });

  assert.equal(
    coordinator.registerListener({
      key: "cache:accounts:changed",
      path: "accounts",
      event: "child_changed",
      handler() {},
    }),
    true,
  );
  assert.equal(
    coordinator.registerListener({
      key: "cache:accounts:changed",
      path: "accounts",
      event: "child_changed",
      handler() {},
    }),
    false,
  );

  coordinator.startFirebaseRequestCoordinator();
  assert.equal(getRef("accounts").listenerCount("child_changed"), 1);
});

test("listeners registered after startup attach immediately", () => {
  const { db, getRef } = createFakeDb();
  const coordinator = createFirebaseRequestCoordinator({ db, log() {} });

  coordinator.startFirebaseRequestCoordinator();

  assert.equal(
    coordinator.registerListener({
      key: "cache:shared:removed",
      path: "sharedByHome",
      event: "child_removed",
      handler() {},
    }),
    true,
  );
  assert.equal(getRef("sharedByHome").listenerCount("child_removed"), 1);
});

test("synchronous and asynchronous handler failures are isolated and logged", async () => {
  const { db, getRef } = createFakeDb();
  const logs = [];
  const coordinator = createFirebaseRequestCoordinator({
    db,
    log: (...args) => logs.push(args.join(" ")),
  });

  coordinator.registerListener({
    key: "sync-error",
    path: "requests",
    event: "child_added",
    handler() {
      throw new Error("sync_failure");
    },
  });
  coordinator.registerListener({
    key: "async-error",
    path: "requests",
    event: "child_changed",
    async handler() {
      throw new Error("async_failure");
    },
  });

  coordinator.startFirebaseRequestCoordinator();
  getRef("requests").emit("child_added", {});
  getRef("requests").emit("child_changed", {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logs.some((line) => line.includes("sync_failure")), true);
  assert.equal(logs.some((line) => line.includes("async_failure")), true);
});

test("unregister detaches only the selected listener", () => {
  const { db, getRef } = createFakeDb();
  const coordinator = createFirebaseRequestCoordinator({ db, log() {} });

  coordinator.registerListener({
    key: "one",
    path: "requests",
    event: "child_added",
    handler() {},
  });
  coordinator.registerListener({
    key: "two",
    path: "requests",
    event: "child_changed",
    handler() {},
  });
  coordinator.startFirebaseRequestCoordinator();

  assert.equal(coordinator.unregisterListener("one"), true);
  assert.equal(getRef("requests").listenerCount("child_added"), 0);
  assert.equal(getRef("requests").listenerCount("child_changed"), 1);
  assert.equal(coordinator.unregisterListener("one"), false);
});

test("stop detaches every listener and supports a clean restart", () => {
  const { db, getRef } = createFakeDb();
  const coordinator = createFirebaseRequestCoordinator({ db, log() {} });

  coordinator.registerListener({
    key: "one",
    path: "one",
    event: "value",
    handler() {},
  });
  coordinator.registerListener({
    key: "two",
    path: "two",
    event: "child_added",
    handler() {},
  });
  coordinator.startFirebaseRequestCoordinator();

  assert.equal(coordinator.stopFirebaseRequestCoordinator(), true);
  assert.equal(getRef("one").listenerCount("value"), 0);
  assert.equal(getRef("two").listenerCount("child_added"), 0);
  assert.equal(coordinator.startFirebaseRequestCoordinator(), true);
  assert.equal(getRef("one").listenerCount("value"), 1);
  assert.equal(getRef("two").listenerCount("child_added"), 1);
});

test("invalid listener definitions fail before touching Firebase", () => {
  const { db } = createFakeDb();
  const coordinator = createFirebaseRequestCoordinator({ db, log() {} });

  assert.throws(
    () => coordinator.registerListener({ event: "value", handler() {} }),
    /path is required/,
  );
  assert.throws(
    () => coordinator.registerListener({ path: "accounts", handler() {} }),
    /event is required/,
  );
  assert.throws(
    () => coordinator.registerListener({ path: "accounts", event: "value" }),
    /handler must be a function/,
  );
});
