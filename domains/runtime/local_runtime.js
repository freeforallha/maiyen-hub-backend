"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_LOCAL_RUNTIME_SNAPSHOT_VERSION = 1;
const DEFAULT_OFFLINE_QUEUE_MAX_ITEMS = 1000;
const DEFAULT_OFFLINE_QUEUE_FLUSH_INTERVAL_MS = 15 * 1000;
const DEFAULT_LOCAL_RUNTIME_SNAPSHOT_SAVE_DELAY_MS = 10 * 1000;
const DEFAULT_OFFLINE_QUEUE_SAVE_DELAY_MS = 250;
const DEFAULT_OFFLINE_TRANSIENT_ALARM_TTL_MS = 5 * 60 * 1000;
const DEFAULT_EMERGENCY_MERGE_WINDOW_MS = 10 * 1000;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_FLUSH_BATCH_SIZE = 50;
const TRANSIENT_ALARM_TYPES = new Set([
  "sos",
  "vibration",
  "glass_break",
  "motion",
  "presence",
]);

function createLocalRuntimeDomain({
  db,
  accountCache,
  sharedByHomeCache,
  deviceMap,
  getFirebaseConnected = () => false,
  setFirebaseConnected = () => {},
  getAlarmIncidentItemIdentity = () => "",
  getCachedHomeData = () => null,
  isPersistentEmergencyIncidentItem = () => false,
  isEmergencyIncidentItemStillUnsafe = () => true,
  startOrMergeAlarmIncidents = async () => {},
  resumeOfflineAlarmDemandsFromSnapshot = async () => {},
  resumeActiveAlarmIncidents = async () => {},
  reconcileAllPhysicalSirens = async () => {},
  runtimeDir,
  snapshotVersion = DEFAULT_LOCAL_RUNTIME_SNAPSHOT_VERSION,
  offlineQueueMaxItems = DEFAULT_OFFLINE_QUEUE_MAX_ITEMS,
  offlineQueueFlushIntervalMs = DEFAULT_OFFLINE_QUEUE_FLUSH_INTERVAL_MS,
  snapshotSaveDelayMs = DEFAULT_LOCAL_RUNTIME_SNAPSHOT_SAVE_DELAY_MS,
  offlineQueueSaveDelayMs = DEFAULT_OFFLINE_QUEUE_SAVE_DELAY_MS,
  offlineTransientAlarmTtlMs = DEFAULT_OFFLINE_TRANSIENT_ALARM_TTL_MS,
  emergencyMergeWindowMs = DEFAULT_EMERGENCY_MERGE_WINDOW_MS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  flushBatchSize = DEFAULT_FLUSH_BATCH_SIZE,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("createLocalRuntimeDomain requires db.ref()");
  }
  if (!(accountCache instanceof Map)) {
    throw new TypeError("createLocalRuntimeDomain requires accountCache Map");
  }
  if (!(sharedByHomeCache instanceof Map)) {
    throw new TypeError("createLocalRuntimeDomain requires sharedByHomeCache Map");
  }
  if (!deviceMap || typeof deviceMap !== "object" || Array.isArray(deviceMap)) {
    throw new TypeError("createLocalRuntimeDomain requires deviceMap object");
  }

  const localRuntimeDir =
    runtimeDir ||
    process.env.MAIYEN_LOCAL_RUNTIME_DIR ||
    process.env.MAIYEN_RUNTIME_DIR ||
    process.env.SAFEHOME_RUNTIME_DIR ||
    path.join(__dirname, "..", "..", ".maiyen_runtime");
  const snapshotFile = path.join(
    localRuntimeDir,
    "firebase_snapshot.json",
  );
  const offlineQueueFile = path.join(
    localRuntimeDir,
    "offline_queue.json",
  );

  const offlineOperationQueue = [];
  let localRuntimeSnapshotSaveTimer = null;
  let offlineQueueSaveTimer = null;
  let offlineQueueFlushTimer = null;
  let offlineQueueFlushInProgress = false;
  let firebaseConnectionMonitorStarted = false;
  let firebaseConnectionRef = null;
  let firebaseConnectionListener = null;

  function ensureLocalRuntimeDirectory() {
    fs.mkdirSync(localRuntimeDir, {
      recursive: true,
      mode: 0o700,
    });

    try {
      fs.chmodSync(localRuntimeDir, 0o700);
    } catch (_) { }
  }

  function readLocalJsonFile(filePath, fallbackValue) {
    try {
      if (!fs.existsSync(filePath)) {
        return fallbackValue;
      }

      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      log(
        "LOCAL RUNTIME READ ERROR:",
        path.basename(filePath),
        error.message,
      );
      return fallbackValue;
    }
  }

  function writeLocalJsonFileAtomic(filePath, value) {
    ensureLocalRuntimeDirectory();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify(value),
      "utf8",
    );
    fs.renameSync(tempPath, filePath);

    try {
      fs.chmodSync(filePath, 0o600);
    } catch (_) { }
  }

  function buildLocalOfflineAccountSnapshot(rawAccount) {
    const account = rawAccount || {};
    const safeHomes = {};

    for (const [homeId, rawHome] of Object.entries(
      account.homes || {},
    )) {
      const home = rawHome || {};
      const safeDevices = {};

      for (const [deviceId, rawDevice] of Object.entries(
        home.devices || {},
      )) {
        const device = rawDevice || {};
        const {
          notifications: _ignoredNotifications,
          ...safeDevice
        } = device;

        safeDevices[deviceId] = safeDevice;
      }

      safeHomes[homeId] = {
        name: home.name || homeId,
        securityMode: home.securityMode || "normal",
        securityModeRepeatMinutes:
          home.securityModeRepeatMinutes ?? 0,
        alarmPauseToday: home.alarmPauseToday || null,
        devices: safeDevices,
      };
    }

    return {
      homes: safeHomes,
      alarmSettings: account.alarmSettings || {},
      customRules: account.customRules || {},
      sharedHomes: account.sharedHomes || {},
    };
  }

  function persistLocalRuntimeSnapshotNow() {
    try {
      writeLocalJsonFileAtomic(
        snapshotFile,
        {
          version: snapshotVersion,
          savedAt: now(),
          accounts: Object.fromEntries(
            Array.from(accountCache.entries()).map(
              ([uid, account]) => [
                uid,
                buildLocalOfflineAccountSnapshot(account),
              ],
            ),
          ),
          sharedByHome: Object.fromEntries(
            sharedByHomeCache.entries(),
          ),
          deviceMap,
        },
      );
    } catch (error) {
      log(
        "LOCAL SNAPSHOT SAVE ERROR:",
        error.message,
      );
    }
  }

  function scheduleLocalRuntimeSnapshotSave() {
    if (localRuntimeSnapshotSaveTimer) {
      return;
    }

    localRuntimeSnapshotSaveTimer = setTimeoutFn(() => {
      localRuntimeSnapshotSaveTimer = null;
      persistLocalRuntimeSnapshotNow();
    }, snapshotSaveDelayMs);
  }

  function persistOfflineQueueNow() {
    try {
      writeLocalJsonFileAtomic(
        offlineQueueFile,
        {
          version: 1,
          savedAt: now(),
          operations: offlineOperationQueue,
        },
      );
    } catch (error) {
      log(
        "OFFLINE QUEUE SAVE ERROR:",
        error.message,
      );
    }
  }

  function scheduleOfflineQueueSave() {
    if (offlineQueueSaveTimer) {
      return;
    }

    offlineQueueSaveTimer = setTimeoutFn(() => {
      offlineQueueSaveTimer = null;
      persistOfflineQueueNow();
    }, offlineQueueSaveDelayMs);
  }

  function loadLocalRuntimeState() {
    ensureLocalRuntimeDirectory();

    const snapshot = readLocalJsonFile(
      snapshotFile,
      null,
    );

    if (
      snapshot &&
      snapshot.version === snapshotVersion
    ) {
      for (const [uid, account] of Object.entries(
        snapshot.accounts || {},
      )) {
        accountCache.set(uid, account || {});
      }

      for (const [homeId, members] of Object.entries(
        snapshot.sharedByHome || {},
      )) {
        sharedByHomeCache.set(homeId, members || {});
      }

      for (const [deviceId, map] of Object.entries(
        snapshot.deviceMap || {},
      )) {
        if (map?.uid && map?.homeId) {
          deviceMap[deviceId] = {
            uid: String(map.uid),
            homeId: String(map.homeId),
          };
        }
      }

      log(
        "💾 LOCAL FIREBASE SNAPSHOT LOADED:",
        `accounts=${accountCache.size}`,
        `homes=${sharedByHomeCache.size}`,
        `devices=${Object.keys(deviceMap).length}`,
        `savedAt=${Number(snapshot.savedAt || 0)}`,
      );
    }

    const queueData = readLocalJsonFile(
      offlineQueueFile,
      null,
    );
    const storedOperations = Array.isArray(
      queueData?.operations,
    )
      ? queueData.operations
      : [];

    offlineOperationQueue.splice(
      0,
      offlineOperationQueue.length,
      ...storedOperations.slice(-offlineQueueMaxItems),
    );

    if (offlineOperationQueue.length > 0) {
      log(
        "📥 OFFLINE QUEUE LOADED:",
        offlineOperationQueue.length,
      );
    }

    return {
      accounts: accountCache.size,
      homes: sharedByHomeCache.size,
      devices: Object.keys(deviceMap).length,
      queuedOperations: offlineOperationQueue.length,
    };
  }

  function applyDeviceUpdateToLocalCache(
    ownerUid,
    homeId,
    deviceId,
    updateData,
  ) {
    const cleanOwnerUid = String(ownerUid || "").trim();
    const cleanHomeId = String(homeId || "").trim();
    const cleanDeviceId = String(deviceId || "").trim();

    if (!cleanOwnerUid || !cleanHomeId || !cleanDeviceId) {
      return null;
    }

    const account = accountCache.get(cleanOwnerUid) || {};
    const homes = account.homes || {};
    const home = homes[cleanHomeId] || {};
    const devices = home.devices || {};
    const nextDevice = {
      ...(devices[cleanDeviceId] || {}),
      ...(updateData || {}),
    };
    const nextHome = {
      ...home,
      devices: {
        ...devices,
        [cleanDeviceId]: nextDevice,
      },
    };

    accountCache.set(cleanOwnerUid, {
      ...account,
      homes: {
        ...homes,
        [cleanHomeId]: nextHome,
      },
    });

    scheduleLocalRuntimeSnapshotSave();
    return nextHome;
  }

  function getOfflineOperationIdentity(operation) {
    if (operation?.type === "firebase_update") {
      return `firebase_update|${String(operation.path || "")}`;
    }

    if (operation?.type === "alarm_item") {
      const itemType = String(
        operation.item?.type || "",
      ).trim();
      const timeBucket = TRANSIENT_ALARM_TYPES.has(itemType)
        ? Math.floor(
            Number(operation.queuedAt || 0) /
            emergencyMergeWindowMs,
          )
        : 0;

      return [
        "alarm_item",
        String(operation.receiverUid || ""),
        getAlarmIncidentItemIdentity(operation.item || {}),
        String(timeBucket),
      ].join("|");
    }

    return String(operation?.id || "");
  }

  function enqueueOfflineOperation(operation) {
    if (!operation || !operation.type) {
      return;
    }

    const normalized = {
      ...operation,
      id: operation.id || (
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : crypto.randomBytes(16).toString("hex")
      ),
      queuedAt: Number(operation.queuedAt || now()),
    };
    const identity = getOfflineOperationIdentity(normalized);
    const existingIndex = offlineOperationQueue.findIndex(
      (item) => getOfflineOperationIdentity(item) === identity,
    );

    if (
      normalized.type === "firebase_update" &&
      existingIndex >= 0
    ) {
      const existing = offlineOperationQueue[existingIndex];
      offlineOperationQueue[existingIndex] = {
        ...existing,
        ...normalized,
        data: {
          ...(existing.data || {}),
          ...(normalized.data || {}),
        },
        queuedAt: existing.queuedAt || normalized.queuedAt,
      };
    } else if (existingIndex < 0) {
      offlineOperationQueue.push(normalized);
    }

    if (offlineOperationQueue.length > offlineQueueMaxItems) {
      offlineOperationQueue.splice(
        0,
        offlineOperationQueue.length - offlineQueueMaxItems,
      );
    }

    scheduleOfflineQueueSave();
  }

  function enqueueOfflineFirebaseUpdate(refPath, data) {
    enqueueOfflineOperation({
      type: "firebase_update",
      path: String(refPath || "").trim(),
      data: data || {},
    });
  }

  function enqueueOfflineAlarmItem(receiverUid, item) {
    enqueueOfflineOperation({
      type: "alarm_item",
      receiverUid: String(receiverUid || "").trim(),
      item,
    });
  }

  function isQueuedAlarmOperationStillRelevant(operation) {
    const item = operation?.item || {};
    const ownerUid = String(item.ownerUid || "").trim();
    const homeId = String(item.homeId || "").trim();
    const home = getCachedHomeData(ownerUid, homeId);
    const queuedAt = Number(operation?.queuedAt || 0);
    const type = String(item.type || "").trim();

    if (!home) {
      return true;
    }

    if (isPersistentEmergencyIncidentItem(item)) {
      return isEmergencyIncidentItemStillUnsafe(home, item);
    }

    if (TRANSIENT_ALARM_TYPES.has(type)) {
      return (
        queuedAt > 0 &&
        now() - queuedAt <= offlineTransientAlarmTtlMs
      );
    }

    return true;
  }

  async function flushOfflineOperationQueue() {
    if (
      getFirebaseConnected() !== true ||
      offlineQueueFlushInProgress ||
      offlineOperationQueue.length === 0
    ) {
      return { completed: 0, remaining: offlineOperationQueue.length };
    }

    offlineQueueFlushInProgress = true;
    let completed = 0;

    try {
      while (
        getFirebaseConnected() === true &&
        offlineOperationQueue.length > 0
      ) {
        const alarmIndex = offlineOperationQueue.findIndex(
          (item) => item?.type === "alarm_item",
        );
        const operationIndex = alarmIndex >= 0
          ? alarmIndex
          : 0;
        const operation = offlineOperationQueue[operationIndex];

        if (operation.type === "firebase_update") {
          if (!operation.path) {
            offlineOperationQueue.splice(operationIndex, 1);
            continue;
          }

          await db
            .ref(operation.path)
            .update(operation.data || {});
        } else if (operation.type === "alarm_item") {
          if (
            !operation.receiverUid ||
            !operation.item ||
            !isQueuedAlarmOperationStillRelevant(operation)
          ) {
            offlineOperationQueue.splice(operationIndex, 1);
            continue;
          }

          await startOrMergeAlarmIncidents(
            operation.receiverUid,
            [operation.item],
          );
        }

        offlineOperationQueue.splice(operationIndex, 1);
        completed++;

        if (completed >= flushBatchSize) {
          break;
        }
      }
    } catch (error) {
      log(
        "OFFLINE QUEUE FLUSH PAUSED:",
        error.message,
      );
    } finally {
      offlineQueueFlushInProgress = false;
      persistOfflineQueueNow();
    }

    if (completed > 0) {
      log(
        "📤 OFFLINE QUEUE FLUSHED:",
        completed,
        `remaining=${offlineOperationQueue.length}`,
      );
    }

    return { completed, remaining: offlineOperationQueue.length };
  }

  function startOfflineQueueFlushTimer() {
    if (offlineQueueFlushTimer) {
      return false;
    }

    offlineQueueFlushTimer = setIntervalFn(() => {
      void flushOfflineOperationQueue();
    }, offlineQueueFlushIntervalMs);
    return true;
  }

  function startFirebaseConnectionMonitor() {
    if (firebaseConnectionMonitorStarted) {
      return false;
    }

    firebaseConnectionMonitorStarted = true;
    firebaseConnectionRef = db.ref(".info/connected");
    firebaseConnectionListener = (snapshot) => {
      const nextConnected = snapshot.val() === true;
      const changed = getFirebaseConnected() !== nextConnected;
      setFirebaseConnected(nextConnected);

      if (changed) {
        log(
          nextConnected
            ? "☁️ FIREBASE CONNECTED"
            : "📴 FIREBASE OFFLINE - LOCAL ALARM MODE",
        );
      }

      if (!nextConnected) {
        void resumeOfflineAlarmDemandsFromSnapshot().catch((error) => {
          log(
            "OFFLINE ALARM RESUME ERROR:",
            error.message,
          );
        });
        return;
      }

      scheduleLocalRuntimeSnapshotSave();

      setTimeoutFn(() => {
        void (async () => {
          await flushOfflineOperationQueue();

          try {
            await resumeActiveAlarmIncidents();
          } catch (error) {
            log(
              "ALARM RESUME AFTER RECONNECT ERROR:",
              error.message,
            );
          }

          await reconcileAllPhysicalSirens({
            force: true,
            reason: "firebase_reconnected",
          });
        })();
      }, reconnectDelayMs);
    };

    firebaseConnectionRef.on(
      "value",
      firebaseConnectionListener,
    );
    return true;
  }

  function persistRuntimeBeforeExit(signal) {
    try {
      if (localRuntimeSnapshotSaveTimer) {
        clearTimeoutFn(localRuntimeSnapshotSaveTimer);
        localRuntimeSnapshotSaveTimer = null;
      }

      if (offlineQueueSaveTimer) {
        clearTimeoutFn(offlineQueueSaveTimer);
        offlineQueueSaveTimer = null;
      }

      persistLocalRuntimeSnapshotNow();
      persistOfflineQueueNow();
    } finally {
      log("💾 LOCAL RUNTIME SAVED:", signal);
    }
  }

  function stop() {
    if (localRuntimeSnapshotSaveTimer) {
      clearTimeoutFn(localRuntimeSnapshotSaveTimer);
      localRuntimeSnapshotSaveTimer = null;
    }
    if (offlineQueueSaveTimer) {
      clearTimeoutFn(offlineQueueSaveTimer);
      offlineQueueSaveTimer = null;
    }
    if (offlineQueueFlushTimer) {
      clearIntervalFn(offlineQueueFlushTimer);
      offlineQueueFlushTimer = null;
    }
    if (
      firebaseConnectionRef &&
      firebaseConnectionListener &&
      typeof firebaseConnectionRef.off === "function"
    ) {
      firebaseConnectionRef.off(
        "value",
        firebaseConnectionListener,
      );
    }
    firebaseConnectionRef = null;
    firebaseConnectionListener = null;
    firebaseConnectionMonitorStarted = false;
  }

  return {
    applyDeviceUpdateToLocalCache,
    buildLocalOfflineAccountSnapshot,
    enqueueOfflineAlarmItem,
    enqueueOfflineFirebaseUpdate,
    flushOfflineOperationQueue,
    getOfflineOperationIdentity,
    getOfflineQueueSnapshot: () => structuredClone(offlineOperationQueue),
    getRuntimePaths: () => ({
      localRuntimeDir,
      snapshotFile,
      offlineQueueFile,
    }),
    isQueuedAlarmOperationStillRelevant,
    loadLocalRuntimeState,
    persistLocalRuntimeSnapshotNow,
    persistOfflineQueueNow,
    persistRuntimeBeforeExit,
    scheduleLocalRuntimeSnapshotSave,
    startFirebaseConnectionMonitor,
    startOfflineQueueFlushTimer,
    stop,
  };
}

module.exports = {
  createLocalRuntimeDomain,
};
