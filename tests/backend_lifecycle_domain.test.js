"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createBackendLifecycleCoordinator,
  normalizeFailureMode,
  normalizeLifecycleKey,
} = require("../domains/runtime/backend_lifecycle");

test("lifecycle keys and failure modes normalize deterministically", () => {
  assert.equal(normalizeLifecycleKey(" cache "), "cache");
  assert.equal(normalizeFailureMode(" DEFER "), "defer");
  assert.equal(normalizeFailureMode(""), "critical");
  assert.throws(() => normalizeLifecycleKey(""), /key is required/);
  assert.throws(() => normalizeFailureMode("ignore"), /failure mode/);
});

test("registered components start once in declaration order", async () => {
  const order = [];
  const lifecycle = createBackendLifecycleCoordinator({ log() {} });

  lifecycle.registerComponent({
    key: "one",
    start() { order.push("start:one"); },
  });
  lifecycle.registerComponent({
    key: "two",
    start() { order.push("start:two"); },
  });

  assert.equal(await lifecycle.startBackendLifecycle(), true);
  assert.equal(await lifecycle.startBackendLifecycle(), true);
  assert.deepEqual(order, ["start:one", "start:two"]);
  assert.equal(lifecycle.getLifecycleState().state, "started");
});

test("duplicate component and finalizer keys are rejected", () => {
  const lifecycle = createBackendLifecycleCoordinator({ log() {} });

  assert.equal(
    lifecycle.registerComponent({ key: "one", start() {} }),
    true,
  );
  assert.equal(
    lifecycle.registerComponent({ key: "one", start() {} }),
    false,
  );
  assert.equal(
    lifecycle.registerFinalizer({ key: "one", handler() {} }),
    false,
  );
  assert.throws(
    () => lifecycle.registerComponent({ key: "bad" }),
    /start must be a function/,
  );
});

test("deferred startup failures are logged and later components continue", async () => {
  const order = [];
  const logs = [];
  const lifecycle = createBackendLifecycleCoordinator({
    log: (...args) => logs.push(args.join(" ")),
  });

  lifecycle.registerComponent({
    key: "cloud",
    label: "CLOUD CACHE",
    failureMode: "defer",
    start() { throw new Error("offline"); },
  });
  lifecycle.registerComponent({
    key: "local",
    start() { order.push("local"); },
  });

  assert.equal(await lifecycle.startBackendLifecycle(), true);
  assert.deepEqual(order, ["local"]);
  assert.equal(
    logs.some((line) => line.includes("CLOUD CACHE DEFERRED: offline")),
    true,
  );
  assert.deepEqual(
    lifecycle.getLifecycleState().startedComponents,
    ["local"],
  );
});

test("critical startup failure rolls back started components in reverse order", async () => {
  const order = [];
  const lifecycle = createBackendLifecycleCoordinator({ log() {} });

  lifecycle.registerComponent({
    key: "one",
    start() { order.push("start:one"); },
    stop(reason) { order.push(`stop:one:${reason}`); },
  });
  lifecycle.registerComponent({
    key: "two",
    start() { order.push("start:two"); },
    stop(reason) { order.push(`stop:two:${reason}`); },
  });
  lifecycle.registerComponent({
    key: "broken",
    start() { throw new Error("broken_start"); },
  });

  await assert.rejects(
    lifecycle.startBackendLifecycle(),
    /broken_start/,
  );
  assert.deepEqual(order, [
    "start:one",
    "start:two",
    "stop:two:startup_rollback",
    "stop:one:startup_rollback",
  ]);
  assert.equal(lifecycle.getLifecycleState().state, "failed");
});

test("shutdown stops components in reverse order and runs finalizers once", async () => {
  const order = [];
  const lifecycle = createBackendLifecycleCoordinator({ log() {} });

  lifecycle.registerComponent({
    key: "one",
    start() { order.push("start:one"); },
    stop(reason) { order.push(`stop:one:${reason}`); },
  });
  lifecycle.registerComponent({
    key: "two",
    start() { order.push("start:two"); },
    stop(reason) { order.push(`stop:two:${reason}`); },
  });
  lifecycle.registerFinalizer({
    key: "persist",
    handler(reason) { order.push(`persist:${reason}`); },
  });

  await lifecycle.startBackendLifecycle();
  assert.equal(await lifecycle.stopBackendLifecycle("SIGTERM"), true);
  assert.equal(await lifecycle.stopBackendLifecycle("SIGTERM"), true);
  assert.deepEqual(order, [
    "start:one",
    "start:two",
    "stop:two:SIGTERM",
    "stop:one:SIGTERM",
    "persist:SIGTERM",
  ]);
  assert.equal(lifecycle.getLifecycleState().state, "stopped");
});

test("concurrent startup calls share one in-flight sequence", async () => {
  let releases = 0;
  let resolveStart;
  const gate = new Promise((resolve) => { resolveStart = resolve; });
  const lifecycle = createBackendLifecycleCoordinator({ log() {} });

  lifecycle.registerComponent({
    key: "slow",
    async start() {
      releases++;
      await gate;
    },
  });

  const first = lifecycle.startBackendLifecycle();
  const second = lifecycle.startBackendLifecycle();
  assert.equal(first, second);
  resolveStart();
  assert.equal(await first, true);
  assert.equal(releases, 1);
});

test("installed signal handlers share one graceful shutdown and exit", async () => {
  const signalSource = new EventEmitter();
  const exits = [];
  const order = [];
  const lifecycle = createBackendLifecycleCoordinator({
    log() {},
    signalSource,
    exitProcess: (code) => exits.push(code),
  });

  lifecycle.registerComponent({
    key: "service",
    start() { order.push("start"); },
    stop(reason) { order.push(`stop:${reason}`); },
  });
  lifecycle.registerFinalizer({
    key: "persist",
    handler(reason) { order.push(`persist:${reason}`); },
  });

  lifecycle.installSignalHandlers();
  await lifecycle.startBackendLifecycle();
  signalSource.emit("SIGTERM");
  signalSource.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["start", "stop:SIGTERM", "persist:SIGTERM"]);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(lifecycle.getLifecycleState().installedSignals, []);
});
