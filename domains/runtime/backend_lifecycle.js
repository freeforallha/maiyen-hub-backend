"use strict";

function normalizeLifecycleKey(rawKey) {
  const key = String(rawKey || "").trim();

  if (!key) {
    throw new Error("Lifecycle component key is required");
  }

  return key;
}

function normalizeFailureMode(rawMode) {
  const mode = String(rawMode || "critical")
    .trim()
    .toLowerCase();

  if (mode === "critical" || mode === "defer") {
    return mode;
  }

  throw new Error(`Invalid lifecycle failure mode: ${rawMode}`);
}

function createBackendLifecycleCoordinator({
  log = (...args) => console.log(...args),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  signalSource = process,
  exitProcess = (code) => process.exit(code),
} = {}) {
  if (typeof log !== "function") {
    throw new Error("log must be a function");
  }
  if (typeof setTimeoutFn !== "function") {
    throw new Error("setTimeoutFn must be a function");
  }
  if (typeof clearTimeoutFn !== "function") {
    throw new Error("clearTimeoutFn must be a function");
  }

  const componentMap = new Map();
  const componentOrder = [];
  const finalizerMap = new Map();
  const finalizerOrder = [];
  const startedComponents = [];
  const signalHandlers = new Map();

  let lifecycleState = "idle";
  let startPromise = null;
  let stopPromise = null;
  let signalHandled = false;

  function runWithTimeout(handler, timeoutMs, label) {
    const durationMs = Math.max(0, Number(timeoutMs) || 0);
    const operation = Promise.resolve().then(handler);

    if (durationMs === 0) {
      return operation;
    }

    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        reject(new Error(`${label}_timeout`));
      }, durationMs);
    });

    return Promise.race([operation, timeout]).finally(() => {
      if (timer) {
        clearTimeoutFn(timer);
      }
    });
  }

  function registerComponent({
    key: rawKey,
    label: rawLabel,
    start,
    stop = null,
    startTimeoutMs = 0,
    stopTimeoutMs = 5000,
    failureMode = "critical",
  } = {}) {
    const key = normalizeLifecycleKey(rawKey);

    if (typeof start !== "function") {
      throw new Error(`Lifecycle component start must be a function: ${key}`);
    }
    if (stop != null && typeof stop !== "function") {
      throw new Error(`Lifecycle component stop must be a function: ${key}`);
    }
    if (componentMap.has(key) || finalizerMap.has(key)) {
      return false;
    }

    const component = {
      key,
      label: String(rawLabel || key).trim() || key,
      start,
      stop,
      startTimeoutMs: Math.max(0, Number(startTimeoutMs) || 0),
      stopTimeoutMs: Math.max(0, Number(stopTimeoutMs) || 0),
      failureMode: normalizeFailureMode(failureMode),
    };

    componentMap.set(key, component);
    componentOrder.push(component);
    return true;
  }

  function registerFinalizer({
    key: rawKey,
    label: rawLabel,
    handler,
    timeoutMs = 5000,
  } = {}) {
    const key = normalizeLifecycleKey(rawKey);

    if (typeof handler !== "function") {
      throw new Error(`Lifecycle finalizer must be a function: ${key}`);
    }
    if (componentMap.has(key) || finalizerMap.has(key)) {
      return false;
    }

    const finalizer = {
      key,
      label: String(rawLabel || key).trim() || key,
      handler,
      timeoutMs: Math.max(0, Number(timeoutMs) || 0),
    };

    finalizerMap.set(key, finalizer);
    finalizerOrder.push(finalizer);
    return true;
  }

  async function stopStartedComponents(reason) {
    while (startedComponents.length > 0) {
      const component = startedComponents.pop();

      if (typeof component.stop !== "function") {
        continue;
      }

      try {
        await runWithTimeout(
          () => component.stop(reason),
          component.stopTimeoutMs,
          `${component.key}_stop`,
        );
      } catch (error) {
        log(
          "BACKEND SHUTDOWN STEP ERROR:",
          component.label,
          error.message,
        );
      }
    }
  }

  async function runFinalizers(reason) {
    for (const finalizer of finalizerOrder) {
      try {
        await runWithTimeout(
          () => finalizer.handler(reason),
          finalizer.timeoutMs,
          `${finalizer.key}_finalizer`,
        );
      } catch (error) {
        log(
          "BACKEND SHUTDOWN FINALIZER ERROR:",
          finalizer.label,
          error.message,
        );
      }
    }
  }

  async function cleanupFailedComponent(component) {
    if (typeof component.stop !== "function") {
      return;
    }

    try {
      await runWithTimeout(
        () => component.stop("startup_failed"),
        component.stopTimeoutMs,
        `${component.key}_failed_start_cleanup`,
      );
    } catch (error) {
      log(
        "BACKEND STARTUP CLEANUP ERROR:",
        component.label,
        error.message,
      );
    }
  }

  async function rollbackStartup(error) {
    lifecycleState = "stopping";
    await stopStartedComponents("startup_rollback");
    await runFinalizers("startup_rollback");
    lifecycleState = "failed";
    throw error;
  }

  function startBackendLifecycle() {
    if (startPromise) {
      return startPromise;
    }
    if (lifecycleState === "started") {
      return Promise.resolve(false);
    }
    if (lifecycleState === "stopping" || lifecycleState === "stopped") {
      return Promise.reject(
        new Error(`Backend lifecycle cannot start from ${lifecycleState}`),
      );
    }

    lifecycleState = "starting";
    startPromise = (async () => {
      for (const component of componentOrder) {
        try {
          await runWithTimeout(
            component.start,
            component.startTimeoutMs,
            component.key,
          );
          startedComponents.push(component);
        } catch (error) {
          if (!String(error.message || "").endsWith("_timeout")) {
            await cleanupFailedComponent(component);
          }

          if (component.failureMode === "defer") {
            log(`${component.label} DEFERRED:`, error.message);
            continue;
          }

          log(
            "BACKEND STARTUP STEP ERROR:",
            component.label,
            error.message,
          );
          return rollbackStartup(error);
        }
      }

      lifecycleState = "started";
      log(
        "🚀 BACKEND LIFECYCLE STARTED:",
        `components=${startedComponents.length}`,
      );
      return true;
    })();

    return startPromise;
  }

  function stopBackendLifecycle(reason = "shutdown") {
    if (stopPromise) {
      return stopPromise;
    }
    if (lifecycleState === "stopped") {
      return Promise.resolve(false);
    }

    stopPromise = (async () => {
      lifecycleState = "stopping";
      await stopStartedComponents(reason);
      await runFinalizers(reason);
      uninstallSignalHandlers();
      lifecycleState = "stopped";
      log("🧹 BACKEND LIFECYCLE STOPPED:", reason);
      return true;
    })();

    return stopPromise;
  }

  function installSignalHandlers({
    signals = ["SIGTERM", "SIGINT"],
    exitCode = 0,
  } = {}) {
    if (
      !signalSource ||
      typeof signalSource.once !== "function" ||
      typeof signalSource.removeListener !== "function"
    ) {
      throw new Error("signalSource must support once/removeListener");
    }
    if (signalHandlers.size > 0) {
      return false;
    }

    for (const rawSignal of signals) {
      const signal = String(rawSignal || "").trim();

      if (!signal || signalHandlers.has(signal)) {
        continue;
      }

      const handler = () => {
        if (signalHandled) {
          return;
        }

        signalHandled = true;
        void stopBackendLifecycle(signal).finally(() => {
          exitProcess(exitCode);
        });
      };

      signalHandlers.set(signal, handler);
      signalSource.once(signal, handler);
    }

    return signalHandlers.size > 0;
  }

  function uninstallSignalHandlers() {
    if (
      !signalSource ||
      typeof signalSource.removeListener !== "function"
    ) {
      signalHandlers.clear();
      return false;
    }

    for (const [signal, handler] of signalHandlers.entries()) {
      signalSource.removeListener(signal, handler);
    }

    const removed = signalHandlers.size > 0;
    signalHandlers.clear();
    return removed;
  }

  function getLifecycleState() {
    return {
      state: lifecycleState,
      registeredComponents: componentOrder.map((item) => item.key),
      startedComponents: startedComponents.map((item) => item.key),
      registeredFinalizers: finalizerOrder.map((item) => item.key),
      installedSignals: [...signalHandlers.keys()],
    };
  }

  return {
    getLifecycleState,
    installSignalHandlers,
    registerComponent,
    registerFinalizer,
    startBackendLifecycle,
    stopBackendLifecycle,
    uninstallSignalHandlers,
  };
}

module.exports = {
  createBackendLifecycleCoordinator,
  normalizeFailureMode,
  normalizeLifecycleKey,
};
