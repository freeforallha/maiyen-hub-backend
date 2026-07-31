"use strict";

const CACHE_LISTENER_KEYS = Object.freeze([
  "cache:accounts:child_added",
  "cache:accounts:child_changed",
  "cache:accounts:child_removed",
  "cache:shared_by_home:child_added",
  "cache:shared_by_home:child_changed",
  "cache:shared_by_home:child_removed",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function buildUserDirectoryData(rawUser) {
  const user = asObject(rawUser);
  const profile = asObject(user.profile);

  return {
    email: String(user.email || "").trim().toLowerCase(),
    name: String(profile.name || user.name || "").trim(),
    photoUrl: String(profile.photoUrl || user.photoUrl || "").trim(),
  };
}

function createBackendDataCacheDomain({
  db,
  accountCache,
  sharedByHomeCache,
  deviceMap,
  localActiveAlarmIncidentMap,
  getFirebaseRequestCoordinator,
  scheduleLocalRuntimeSnapshotSave,
  persistLocalRuntimeSnapshotNow,
  handleAlarmRelevantAccountChange,
  handleAlarmPauseAccountChanged,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("Backend Data Cache requires db.ref");
  }
  if (!(accountCache instanceof Map)) {
    throw new TypeError("Backend Data Cache requires accountCache Map");
  }
  if (!(sharedByHomeCache instanceof Map)) {
    throw new TypeError("Backend Data Cache requires sharedByHomeCache Map");
  }
  if (!deviceMap || typeof deviceMap !== "object") {
    throw new TypeError("Backend Data Cache requires deviceMap object");
  }
  if (!(localActiveAlarmIncidentMap instanceof Map)) {
    throw new TypeError(
      "Backend Data Cache requires localActiveAlarmIncidentMap Map",
    );
  }
  if (typeof getFirebaseRequestCoordinator !== "function") {
    throw new TypeError(
      "Backend Data Cache requires getFirebaseRequestCoordinator",
    );
  }

  const userDirectorySignatureMap = new Map();
  let started = false;

  function getCachedAccountsObject() {
    return Object.fromEntries(accountCache.entries());
  }

  function getCachedSharedByHomeObject() {
    return Object.fromEntries(sharedByHomeCache.entries());
  }

  function getCachedAccountData(uid) {
    return accountCache.get(String(uid || "").trim()) || null;
  }

  function getCachedHomeData(ownerUid, homeId) {
    const ownerAccount = getCachedAccountData(ownerUid);
    return ownerAccount?.homes?.[String(homeId || "").trim()] || null;
  }

  function getAlarmReceiverUidsForHome(ownerUid, homeId) {
    const cleanOwnerUid = String(ownerUid || "").trim();
    const cleanHomeId = String(homeId || "").trim();

    if (!cleanOwnerUid || !cleanHomeId) {
      return [];
    }

    const receiverUids = new Set([cleanOwnerUid]);
    const sharedMembers = sharedByHomeCache.get(cleanHomeId) || {};

    for (const sharedUid of Object.keys(asObject(sharedMembers))) {
      const cleanUid = String(sharedUid || "").trim();

      if (cleanUid && getCachedAccountData(cleanUid)) {
        receiverUids.add(cleanUid);
      }
    }

    return Array.from(receiverUids);
  }

  async function syncUserDirectoryEntry(uid, rawUser) {
    const cleanUid = String(uid || "").trim();

    if (!cleanUid) {
      return false;
    }

    const directoryData = buildUserDirectoryData(rawUser);
    const signature = JSON.stringify(directoryData);

    if (userDirectorySignatureMap.get(cleanUid) === signature) {
      return false;
    }

    userDirectorySignatureMap.set(cleanUid, signature);

    await db.ref(`userDirectory/${cleanUid}`).set({
      ...directoryData,
      updatedAt: Date.now(),
    });

    return true;
  }

  async function removeUserDirectoryEntry(uid) {
    const cleanUid = String(uid || "").trim();

    if (!cleanUid) {
      return false;
    }

    userDirectorySignatureMap.delete(cleanUid);
    await db.ref(`userDirectory/${cleanUid}`).remove();
    return true;
  }

  function scheduleSnapshotSave() {
    if (typeof scheduleLocalRuntimeSnapshotSave === "function") {
      scheduleLocalRuntimeSnapshotSave();
    }
  }

  function getCoordinator() {
    const coordinator = getFirebaseRequestCoordinator();

    if (
      !coordinator ||
      typeof coordinator.registerListener !== "function" ||
      typeof coordinator.unregisterListener !== "function"
    ) {
      throw new TypeError(
        "Backend Data Cache requires Firebase Request Coordinator",
      );
    }

    return coordinator;
  }

  function buildCacheListeners() {
    const upsertAccount = (snapshot) => {
      const uid = String(snapshot?.key || "").trim();

      if (!uid) {
        return;
      }

      const account = snapshot.val() || {};
      const previousAccount = accountCache.get(uid) || null;

      accountCache.set(uid, account);
      scheduleSnapshotSave();

      if (previousAccount) {
        if (typeof handleAlarmRelevantAccountChange === "function") {
          void Promise.resolve(
            handleAlarmRelevantAccountChange(uid, previousAccount, account),
          ).catch((error) => {
            log("ALARM ACCOUNT CACHE CHANGE ERROR:", uid, error.message);
          });
        }

        if (typeof handleAlarmPauseAccountChanged === "function") {
          void Promise.resolve(
            handleAlarmPauseAccountChanged(snapshot),
          ).catch((error) => {
            log("ALARM PAUSE CACHE CHANGE ERROR:", uid, error.message);
          });
        }
      }

      void syncUserDirectoryEntry(uid, account).catch((error) => {
        log("USER DIRECTORY SYNC ERROR:", uid, error.message);
      });
    };

    const removeAccount = (snapshot) => {
      const uid = String(snapshot?.key || "").trim();

      if (!uid) {
        return;
      }

      accountCache.delete(uid);
      scheduleSnapshotSave();

      for (const key of Array.from(localActiveAlarmIncidentMap.keys())) {
        if (key.startsWith(`${uid}|`)) {
          localActiveAlarmIncidentMap.delete(key);
        }
      }

      void removeUserDirectoryEntry(uid).catch((error) => {
        log("USER DIRECTORY REMOVE ERROR:", uid, error.message);
      });
    };

    const upsertSharedHome = (snapshot) => {
      const homeId = String(snapshot?.key || "").trim();

      if (!homeId) {
        return;
      }

      sharedByHomeCache.set(homeId, snapshot.val() || {});
      scheduleSnapshotSave();
    };

    const removeSharedHome = (snapshot) => {
      const homeId = String(snapshot?.key || "").trim();

      if (!homeId) {
        return;
      }

      sharedByHomeCache.delete(homeId);
      scheduleSnapshotSave();
    };

    return [
      {
        key: CACHE_LISTENER_KEYS[0],
        path: "accounts",
        event: "child_added",
        handler: upsertAccount,
      },
      {
        key: CACHE_LISTENER_KEYS[1],
        path: "accounts",
        event: "child_changed",
        handler: upsertAccount,
      },
      {
        key: CACHE_LISTENER_KEYS[2],
        path: "accounts",
        event: "child_removed",
        handler: removeAccount,
      },
      {
        key: CACHE_LISTENER_KEYS[3],
        path: "sharedByHome",
        event: "child_added",
        handler: upsertSharedHome,
      },
      {
        key: CACHE_LISTENER_KEYS[4],
        path: "sharedByHome",
        event: "child_changed",
        handler: upsertSharedHome,
      },
      {
        key: CACHE_LISTENER_KEYS[5],
        path: "sharedByHome",
        event: "child_removed",
        handler: removeSharedHome,
      },
    ];
  }

  async function startBackendDataCache() {
    if (started) {
      return false;
    }

    const coordinator = getCoordinator();

    for (const listener of buildCacheListeners()) {
      if (!coordinator.registerListener(listener)) {
        throw new Error(
          `Duplicate backend data cache listener: ${listener.key}`,
        );
      }
    }

    started = true;

    try {
      const [accountsSnapshot, sharedSnapshot, deviceIndexSnapshot] =
        await Promise.all([
          db.ref("accounts").once("value"),
          db.ref("sharedByHome").once("value"),
          db.ref("system/devices_by_ieee").once("value"),
        ]);

      const accounts = asObject(accountsSnapshot.val());
      const sharedByHome = asObject(sharedSnapshot.val());
      const deviceIndex = asObject(deviceIndexSnapshot.val());
      const directorySyncTasks = [];

      for (const [uid, rawAccount] of Object.entries(accounts)) {
        const account = asObject(rawAccount);
        accountCache.set(uid, account);
        directorySyncTasks.push(syncUserDirectoryEntry(uid, account));

        for (const [homeId, rawHome] of Object.entries(
          asObject(account.homes),
        )) {
          for (const deviceId of Object.keys(
            asObject(asObject(rawHome).devices),
          )) {
            if (!deviceMap[deviceId]) {
              deviceMap[deviceId] = { uid, homeId };
            }
          }
        }
      }

      for (const [homeId, members] of Object.entries(sharedByHome)) {
        sharedByHomeCache.set(homeId, asObject(members));
      }

      for (const [deviceId, rawEntry] of Object.entries(deviceIndex)) {
        const entry = asObject(rawEntry);
        const uid = String(entry.uid || "").trim();
        const homeId = String(entry.homeId || "").trim();

        if (uid && homeId) {
          deviceMap[deviceId] = { uid, homeId };
        }
      }

      await Promise.all(directorySyncTasks);

      if (typeof persistLocalRuntimeSnapshotNow === "function") {
        persistLocalRuntimeSnapshotNow();
      }

      log(
        "🗂️ BACKEND DATA CACHE READY:",
        `accounts=${accountCache.size}`,
        `homes=${sharedByHomeCache.size}`,
        `devices=${Object.keys(deviceMap).length}`,
      );

      return true;
    } catch (error) {
      stopBackendDataCache();
      throw error;
    }
  }

  function stopBackendDataCache() {
    const coordinator = getFirebaseRequestCoordinator();
    let removed = 0;

    if (coordinator && typeof coordinator.unregisterListener === "function") {
      for (const key of CACHE_LISTENER_KEYS) {
        if (coordinator.unregisterListener(key)) {
          removed += 1;
        }
      }
    }

    started = false;
    return removed > 0;
  }

  function getBackendDataCacheState() {
    return {
      started,
      accountCount: accountCache.size,
      sharedHomeCount: sharedByHomeCache.size,
      deviceCount: Object.keys(deviceMap).length,
      listenerKeys: [...CACHE_LISTENER_KEYS],
    };
  }

  return {
    getAlarmReceiverUidsForHome,
    getBackendDataCacheState,
    getCachedAccountData,
    getCachedAccountsObject,
    getCachedHomeData,
    getCachedSharedByHomeObject,
    startBackendDataCache,
    stopBackendDataCache,
    syncUserDirectoryEntry,
  };
}

module.exports = {
  CACHE_LISTENER_KEYS,
  buildUserDirectoryData,
  createBackendDataCacheDomain,
};
