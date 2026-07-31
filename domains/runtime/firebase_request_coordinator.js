"use strict";

function normalizeListenerKey(rawKey, path, event) {
  const key = String(rawKey || "").trim();

  if (key) {
    return key;
  }

  return `${String(path || "").trim()}|${String(event || "").trim()}`;
}

function createFirebaseRequestCoordinator({
  db,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("Firebase Request Coordinator requires db.ref");
  }

  const listenerMap = new Map();
  let started = false;

  function reportListenerError(listener, error) {
    log(
      "FIREBASE REQUEST LISTENER ERROR:",
      listener.key,
      String(error?.message || error || "unknown_error"),
    );
  }

  function createWrappedHandler(listener) {
    return (snapshot) => {
      try {
        const result = listener.handler(snapshot);

        if (result && typeof result.then === "function") {
          void result.catch((error) => {
            reportListenerError(listener, error);
          });
        }
      } catch (error) {
        reportListenerError(listener, error);
      }
    };
  }

  function attachListener(listener) {
    if (listener.attached) {
      return false;
    }

    listener.ref = db.ref(listener.path);
    listener.wrappedHandler = createWrappedHandler(listener);
    listener.ref.on(listener.event, listener.wrappedHandler);
    listener.attached = true;
    return true;
  }

  function detachListener(listener) {
    if (!listener.attached) {
      return false;
    }

    if (typeof listener.ref?.off === "function") {
      listener.ref.off(listener.event, listener.wrappedHandler);
    }

    listener.ref = null;
    listener.wrappedHandler = null;
    listener.attached = false;
    return true;
  }

  function registerListener({
    key: rawKey,
    path: rawPath,
    event: rawEvent,
    handler,
  } = {}) {
    const path = String(rawPath || "").trim();
    const event = String(rawEvent || "").trim();
    const key = normalizeListenerKey(rawKey, path, event);

    if (!path) {
      throw new TypeError("Firebase listener path is required");
    }

    if (!event) {
      throw new TypeError("Firebase listener event is required");
    }

    if (typeof handler !== "function") {
      throw new TypeError("Firebase listener handler must be a function");
    }

    if (listenerMap.has(key)) {
      return false;
    }

    const listener = {
      key,
      path,
      event,
      handler,
      ref: null,
      wrappedHandler: null,
      attached: false,
    };

    listenerMap.set(key, listener);

    if (started) {
      attachListener(listener);
    }

    return true;
  }

  function unregisterListener(rawKey) {
    const key = String(rawKey || "").trim();
    const listener = listenerMap.get(key);

    if (!listener) {
      return false;
    }

    detachListener(listener);
    listenerMap.delete(key);
    return true;
  }

  function startFirebaseRequestCoordinator() {
    if (started) {
      return false;
    }

    started = true;

    for (const listener of listenerMap.values()) {
      attachListener(listener);
    }

    log(
      "🔥 FIREBASE REQUEST COORDINATOR STARTED:",
      `listeners=${listenerMap.size}`,
    );

    return true;
  }

  function stopFirebaseRequestCoordinator() {
    if (!started && listenerMap.size === 0) {
      return false;
    }

    let detachedCount = 0;

    for (const listener of listenerMap.values()) {
      if (detachListener(listener)) {
        detachedCount += 1;
      }
    }

    started = false;

    log(
      "🔥 FIREBASE REQUEST COORDINATOR STOPPED:",
      `listeners=${detachedCount}`,
    );

    return detachedCount > 0;
  }

  function getFirebaseRequestCoordinatorState() {
    let attachedCount = 0;

    for (const listener of listenerMap.values()) {
      if (listener.attached) {
        attachedCount += 1;
      }
    }

    return {
      started,
      listenerCount: listenerMap.size,
      attachedCount,
      keys: Array.from(listenerMap.keys()).sort(),
    };
  }

  return {
    getFirebaseRequestCoordinatorState,
    registerListener,
    startFirebaseRequestCoordinator,
    stopFirebaseRequestCoordinator,
    unregisterListener,
  };
}

module.exports = {
  createFirebaseRequestCoordinator,
  normalizeListenerKey,
};
