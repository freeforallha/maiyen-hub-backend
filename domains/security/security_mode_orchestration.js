"use strict";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function cleanText(value) {
  return String(value || "").trim();
}

function getSecurityModeHomeKey(ownerUid, homeId) {
  return `${cleanText(ownerUid)}|${cleanText(homeId)}`;
}

function createSecurityModeOrchestrationDomain(options = {}) {
  const {
    db,
    normalizeHomeSecurityMode,
    normalizeSecurityModeRepeatMinutes,
    getNextAlarmTimeText,
    isSecurityDeviceType,
    getUnsafeSecurityReason,
    getAlarmReceiverUidsForHome,
    getCachedAccountData,
    normalizeDeviceAlarmPolicy,
    resolveDeviceAlarmConfigurationForReceiver,
    sensorEventSeverity,
    sensorEventCategory,
    getAlarmIncidentTargetKey,
    getActiveAlarmIncident,
    clearAlarmIncidentTimers,
    removeLocalActiveAlarmIncident,
    startOrMergeAlarmIncidents,
    sendAlarmResolvedPush,
    resolveAlarmIncidentForReceiver,
    offlineAlarmDemandMap,
    clearOfflineAlarmDemand,
    setPhysicalSirenForHome,
    isEmergencyDeviceType,
    getCurrentEmergencyReason,
    getCachedHomeData,
    validateSecurityIncidentsForHome,
    clearScheduleAlarmRuntimeForHome,
    checkScheduledAlarms,
    getCachedAccountsObject,
    unprotectedTransientReplayWindowMs = 60 * 1000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = Date.now,
    log = (...args) => console.log(...args),
  } = options;

  const requiredFunctions = {
    normalizeHomeSecurityMode,
    normalizeSecurityModeRepeatMinutes,
    getNextAlarmTimeText,
    isSecurityDeviceType,
    getUnsafeSecurityReason,
    getAlarmReceiverUidsForHome,
    getCachedAccountData,
    normalizeDeviceAlarmPolicy,
    resolveDeviceAlarmConfigurationForReceiver,
    getAlarmIncidentTargetKey,
    getActiveAlarmIncident,
    clearAlarmIncidentTimers,
    removeLocalActiveAlarmIncident,
    startOrMergeAlarmIncidents,
    sendAlarmResolvedPush,
    resolveAlarmIncidentForReceiver,
    clearOfflineAlarmDemand,
    setPhysicalSirenForHome,
    isEmergencyDeviceType,
    getCurrentEmergencyReason,
    getCachedHomeData,
    validateSecurityIncidentsForHome,
    clearScheduleAlarmRuntimeForHome,
    checkScheduledAlarms,
    getCachedAccountsObject,
  };

  if (!db || typeof db.ref !== "function") {
    throw new TypeError("security_mode_orchestration_db_required");
  }

  for (const [name, dependency] of Object.entries(requiredFunctions)) {
    if (typeof dependency !== "function") {
      throw new TypeError(
        `security_mode_orchestration_dependency_required:${name}`,
      );
    }
  }

  if (!(offlineAlarmDemandMap instanceof Map)) {
    throw new TypeError(
      "security_mode_orchestration_offline_alarm_map_required",
    );
  }

  const homeListenerMap = new Map();
  const accountListenerMap = new Map();
  const lastValueMap = new Map();
  const transitionInProgress = new Set();
  const pendingTimers = new Set();

  let accountsRootListener = null;
  let started = false;

  function isHomeUnprotected(home) {
    return (
      normalizeHomeSecurityMode(home?.securityMode) === "unprotected"
    );
  }

  function getKnownMode(ownerUid, homeId) {
    return lastValueMap.get(
      getSecurityModeHomeKey(ownerUid, homeId),
    );
  }

  function scheduleTask(task, delayMs) {
    let timer = null;

    timer = setTimeoutFn(() => {
      pendingTimers.delete(timer);
      task();
    }, delayMs);

    pendingTimers.add(timer);
    timer?.unref?.();
    return timer;
  }

  function clearPendingTimers() {
    for (const timer of pendingTimers) {
      clearTimeoutFn(timer);
    }

    pendingTimers.clear();
  }

  function detachHomeListener(ownerUid, homeId) {
    const key = getSecurityModeHomeKey(ownerUid, homeId);
    const listener = homeListenerMap.get(key);

    if (listener) {
      listener.ref.off("value", listener.callback);
      homeListenerMap.delete(key);
    }

    lastValueMap.delete(key);
    transitionInProgress.delete(key);
  }

  async function supersedeSecurityIncidentForModeArming(
    receiverUid,
    ownerUid,
    homeId,
  ) {
    const targetKey = getAlarmIncidentTargetKey(
      receiverUid,
      ownerUid,
      homeId,
      "security",
    );
    const active = await getActiveAlarmIncident(
      receiverUid,
      targetKey,
    );

    if (
      !active ||
      active.incident?.status !== "active" ||
      active.incident?.flowType === "emergency"
    ) {
      return "";
    }

    const timestamp = now();

    clearAlarmIncidentTimers(
      receiverUid,
      active.incidentId,
    );

    await db.ref().update({
      [`accounts/${receiverUid}/alarmIncidents/${active.incidentId}/status`]:
        "superseded",
      [`accounts/${receiverUid}/alarmIncidents/${active.incidentId}/supersededAt`]:
        timestamp,
      [`accounts/${receiverUid}/alarmIncidents/${active.incidentId}/supersededReason`]:
        "security_mode_rearmed",
      [`accounts/${receiverUid}/alarmIncidents/${active.incidentId}/resolutionAction`]:
        "security_mode_rearmed",
      [`accounts/${receiverUid}/alarmIncidents/${active.incidentId}/resolutionType`]:
        "automatic",
      [`accounts/${receiverUid}/alarmIncidents/${active.incidentId}/updatedAt`]:
        timestamp,
      [`accounts/${receiverUid}/activeAlarmIncidentByTarget/${targetKey}`]:
        null,
    });

    removeLocalActiveAlarmIncident(
      receiverUid,
      targetKey,
    );

    log(
      "🔁 SECURITY INCIDENT REARMED:",
      receiverUid,
      active.incidentId,
      ownerUid,
      homeId,
    );

    return active.incidentId;
  }

  async function triggerAlarmForUnsafeStateOnArmed(
    ownerUid,
    homeId,
  ) {
    const transitionKey = getSecurityModeHomeKey(
      ownerUid,
      homeId,
    );

    if (transitionInProgress.has(transitionKey)) {
      return false;
    }

    transitionInProgress.add(transitionKey);

    try {
      const homeSnap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}`)
        .once("value");
      const home = homeSnap.val();

      if (
        !home ||
        normalizeHomeSecurityMode(home.securityMode) !== "armed"
      ) {
        return false;
      }

      const homeName = cleanText(home.name || homeId) || homeId;
      const devices = asObject(home.devices);
      const repeatMinutes = normalizeSecurityModeRepeatMinutes(
        home.securityModeRepeatMinutes,
      );
      const nextAlarm = getNextAlarmTimeText(repeatMinutes);
      const alarmItems = [];

      for (const [deviceId, rawDevice] of Object.entries(devices)) {
        const device = asObject(rawDevice);
        const deviceType = cleanText(device.type || "unknown");

        if (!isSecurityDeviceType(deviceType)) {
          continue;
        }

        const deviceName = cleanText(device.name || deviceId) || deviceId;
        const reason = getUnsafeSecurityReason(
          deviceName,
          deviceType,
          device,
        );

        if (!reason) {
          continue;
        }

        alarmItems.push({
          ownerUid,
          homeId,
          homeName,
          deviceId,
          deviceName,
          type: deviceType,
          reason,
          repeatMinutes,
          nextAlarm,
          alarmSource: "security_mode",
        });
      }

      if (alarmItems.length === 0) {
        log(
          "🛡️ SECURITY MODE ARMED, CURRENT STATE SAFE:",
          ownerUid,
          homeId,
        );
        return true;
      }

      const receiverUids = getAlarmReceiverUidsForHome(
        ownerUid,
        homeId,
      );
      let successfulReceivers = 0;

      for (const receiverUid of receiverUids) {
        try {
          const receiverAccount =
            getCachedAccountData(receiverUid) || {};
          const receiverItems = [];

          for (const item of alarmItems) {
            const device = asObject(devices[item.deviceId]);
            const policy = normalizeDeviceAlarmPolicy(
              device,
              item.type,
            );

            if (policy.enabled !== true) {
              continue;
            }

            const configuration =
              await resolveDeviceAlarmConfigurationForReceiver(
                receiverUid,
                homeId,
                item.deviceId,
                home,
                receiverAccount,
                ownerUid,
              );

            receiverItems.push({
              ...item,
              severity: sensorEventSeverity.ALARM,
              eventCategory: sensorEventCategory.SECURITY,
              alarmLevel: sensorEventSeverity.ALARM,
              notificationEnabled:
                policy.notificationEnabled,
              physicalSirenEnabled:
                policy.physicalSirenEnabled,
              fullscreenEnabled:
                configuration.fullscreenEnabled,
            });
          }

          if (receiverItems.length === 0) {
            continue;
          }

          const supersededIncidentId =
            await supersedeSecurityIncidentForModeArming(
              receiverUid,
              ownerUid,
              homeId,
            );

          await startOrMergeAlarmIncidents(
            receiverUid,
            receiverItems,
            { bypassEventControl: true },
          );

          if (supersededIncidentId) {
            await sendAlarmResolvedPush({
              uid: receiverUid,
              incidentId: supersededIncidentId,
              homeId,
              resolvedBy: "safehome_backend",
              action: "security_mode_rearmed",
              flowType: "security",
              status: "superseded",
              hasRemainingActiveIncidents: true,
            });
          }

          successfulReceivers += 1;
        } catch (error) {
          log(
            "SECURITY MODE RECEIVER ALARM ERROR:",
            receiverUid,
            ownerUid,
            homeId,
            error.message,
          );
        }
      }

      log(
        "🚨 SECURITY MODE ARMED WITH EXISTING UNSAFE STATE:",
        ownerUid,
        homeId,
        `items=${alarmItems.length}`,
        `receivers=${successfulReceivers}/${receiverUids.length}`,
      );

      return true;
    } catch (error) {
      log(
        "SECURITY MODE TRANSITION ALARM ERROR:",
        ownerUid,
        homeId,
        error.message,
      );
      return false;
    } finally {
      transitionInProgress.delete(transitionKey);
    }
  }

  async function resolveAllAlarmIncidentsForHome(
    ownerUid,
    homeId,
    action = "home_unprotected",
  ) {
    const receiverUids = getAlarmReceiverUidsForHome(ownerUid, homeId);
    let resolved = 0;

    for (const receiverUid of receiverUids) {
      try {
        const incidentsSnap = await db
          .ref(`accounts/${receiverUid}/alarmIncidents`)
          .once("value");
        const incidents = asObject(incidentsSnap.val());

        for (const [incidentId, incident] of Object.entries(incidents)) {
          if (
            incident?.status !== "active" ||
            cleanText(incident.ownerUid) !== cleanText(ownerUid) ||
            cleanText(incident.homeId) !== cleanText(homeId)
          ) {
            continue;
          }

          const didResolve = await resolveAlarmIncidentForReceiver({
            receiverUid,
            incidentId,
            ownerUid,
            homeId,
            resolvedBy: "safehome_backend",
            action,
          });

          if (didResolve) {
            resolved += 1;
          }
        }
      } catch (error) {
        log(
          "UNPROTECTED INCIDENT RESOLVE ERROR:",
          receiverUid,
          ownerUid,
          homeId,
          error.message,
        );
      }
    }

    for (const [key, demand] of Array.from(
      offlineAlarmDemandMap.entries(),
    )) {
      const item = demand?.item || {};

      if (
        cleanText(item.ownerUid) === cleanText(ownerUid) &&
        cleanText(item.homeId) === cleanText(homeId)
      ) {
        clearOfflineAlarmDemand(key);
      }
    }

    await setPhysicalSirenForHome(ownerUid, homeId, false, {
      force: true,
      reason: action,
    });

    log(
      "🛡️ HOME UNPROTECTED, ALARMS RESOLVED:",
      ownerUid,
      homeId,
      `incidents=${resolved}`,
    );

    return resolved;
  }

  async function triggerEmergencyForCurrentUnsafeState(
    ownerUid,
    homeId,
    { transientEventCutoffAt = 0 } = {},
  ) {
    try {
      const homeSnap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}`)
        .once("value");
      const home = homeSnap.val();

      if (!home || isHomeUnprotected(home)) {
        return false;
      }

      const homeName = cleanText(home.name || homeId) || homeId;
      const unsafeDevices = [];

      for (const [deviceId, rawDevice] of Object.entries(
        asObject(home.devices),
      )) {
        const device = asObject(rawDevice);
        const deviceType = cleanText(device.type || "unknown");

        if (!isEmergencyDeviceType(deviceType)) {
          continue;
        }

        const deviceName = cleanText(device.name || deviceId) || deviceId;
        const reason = getCurrentEmergencyReason(
          deviceName,
          deviceType,
          device,
          { transientEventCutoffAt },
        );

        if (!reason) {
          continue;
        }

        unsafeDevices.push({
          deviceId,
          deviceName,
          deviceType,
          reason,
          policy: normalizeDeviceAlarmPolicy(device, deviceType),
        });
      }

      if (unsafeDevices.length === 0) {
        return true;
      }

      for (const receiverUid of getAlarmReceiverUidsForHome(
        ownerUid,
        homeId,
      )) {
        const receiverAccount = getCachedAccountData(receiverUid);
        const receiverItems = [];

        for (const unsafeDevice of unsafeDevices) {
          const configuration =
            await resolveDeviceAlarmConfigurationForReceiver(
              receiverUid,
              homeId,
              unsafeDevice.deviceId,
              home,
              receiverAccount,
              ownerUid,
            );

          receiverItems.push({
            ownerUid,
            homeId,
            homeName,
            deviceId: unsafeDevice.deviceId,
            deviceName: unsafeDevice.deviceName,
            type: unsafeDevice.deviceType,
            reason: unsafeDevice.reason,
            severity: sensorEventSeverity.EMERGENCY,
            eventCategory: sensorEventCategory.EMERGENCY,
            alarmLevel: sensorEventSeverity.EMERGENCY,
            repeatMinutes: 0,
            nextAlarm: "ngay lập tức",
            alarmSource: "emergency_sensor",
            notificationEnabled:
              unsafeDevice.policy.notificationEnabled,
            physicalSirenEnabled:
              unsafeDevice.policy.physicalSirenEnabled,
            fullscreenEnabled:
              configuration.fullscreenEnabled,
          });
        }

        await startOrMergeAlarmIncidents(
          receiverUid,
          receiverItems,
          { bypassEventControl: true },
        );
      }

      return true;
    } catch (error) {
      log(
        "MODE CHANGE EMERGENCY RECHECK ERROR:",
        ownerUid,
        homeId,
        error.message,
      );
      return false;
    }
  }

  function handleInitialMode(ownerUid, homeId, nextMode) {
    if (nextMode === "armed") {
      scheduleTask(() => {
        void triggerAlarmForUnsafeStateOnArmed(ownerUid, homeId);
        void triggerEmergencyForCurrentUnsafeState(ownerUid, homeId);
      }, 1000);
      return;
    }

    if (nextMode === "unprotected") {
      clearScheduleAlarmRuntimeForHome(ownerUid, homeId);

      scheduleTask(() => {
        void resolveAllAlarmIncidentsForHome(
          ownerUid,
          homeId,
          "home_unprotected",
        );
      }, 200);
      return;
    }

    scheduleTask(() => {
      void triggerEmergencyForCurrentUnsafeState(ownerUid, homeId);
      void checkScheduledAlarms({
        ownerUidFilter: ownerUid,
        homeIdFilter: homeId,
        reason: "startup_normal_recheck",
      });
    }, 1000);
  }

  function handleModeValue(ownerUid, homeId, rawMode) {
    const key = getSecurityModeHomeKey(ownerUid, homeId);
    const nextMode = normalizeHomeSecurityMode(rawMode);

    if (!lastValueMap.has(key)) {
      lastValueMap.set(key, nextMode);
      handleInitialMode(ownerUid, homeId, nextMode);
      return { initial: true, previousMode: null, nextMode };
    }

    const previousMode = lastValueMap.get(key);
    lastValueMap.set(key, nextMode);

    if (nextMode === "unprotected") {
      clearScheduleAlarmRuntimeForHome(ownerUid, homeId);
      void resolveAllAlarmIncidentsForHome(
        ownerUid,
        homeId,
        "home_unprotected",
      );

      return { initial: false, previousMode, nextMode };
    }

    if (nextMode === "armed" && previousMode !== "armed") {
      void triggerAlarmForUnsafeStateOnArmed(ownerUid, homeId);
      void triggerEmergencyForCurrentUnsafeState(ownerUid, homeId);

      return { initial: false, previousMode, nextMode };
    }

    if (nextMode === "normal") {
      const cachedHome = getCachedHomeData(ownerUid, homeId) || {};

      void validateSecurityIncidentsForHome(
        ownerUid,
        homeId,
        "security_mode_normal",
        {
          homeOverride: {
            ...cachedHome,
            securityMode: "normal",
          },
        },
      );

      if (previousMode === "unprotected") {
        const transientEventCutoffAt =
          now() - unprotectedTransientReplayWindowMs;

        void triggerEmergencyForCurrentUnsafeState(
          ownerUid,
          homeId,
          { transientEventCutoffAt },
        );
        void checkScheduledAlarms({
          ownerUidFilter: ownerUid,
          homeIdFilter: homeId,
          reason: "leave_unprotected_recheck",
        });
      }
    }

    return { initial: false, previousMode, nextMode };
  }

  function attachHomeListener(ownerUid, homeId) {
    const key = getSecurityModeHomeKey(ownerUid, homeId);

    if (homeListenerMap.has(key)) {
      return false;
    }

    const modeRef = db.ref(
      `accounts/${ownerUid}/homes/${homeId}/securityMode`,
    );

    const callback = (snapshot) => {
      handleModeValue(ownerUid, homeId, snapshot.val());
    };

    modeRef.on(
      "value",
      callback,
      (error) => {
        log(
          "SECURITY MODE HOME LISTENER ERROR:",
          ownerUid,
          homeId,
          error.message,
        );
      },
    );

    homeListenerMap.set(key, {
      ref: modeRef,
      callback,
    });

    return true;
  }

  function detachAccountListener(ownerUid) {
    const listener = accountListenerMap.get(ownerUid);

    if (listener) {
      listener.ref.off("child_added", listener.onHomeAdded);
      listener.ref.off("child_removed", listener.onHomeRemoved);
      accountListenerMap.delete(ownerUid);
    }

    for (const key of Array.from(homeListenerMap.keys())) {
      if (!key.startsWith(`${ownerUid}|`)) {
        continue;
      }

      const homeId = key.slice(ownerUid.length + 1);
      detachHomeListener(ownerUid, homeId);
    }
  }

  function attachAccountListener(ownerUid) {
    if (accountListenerMap.has(ownerUid)) {
      return false;
    }

    const homesRef = db.ref(`accounts/${ownerUid}/homes`);

    const onHomeAdded = (homeSnapshot) => {
      const homeId = cleanText(homeSnapshot.key);

      if (homeId) {
        attachHomeListener(ownerUid, homeId);
      }
    };

    const onHomeRemoved = (homeSnapshot) => {
      const homeId = cleanText(homeSnapshot.key);

      if (homeId) {
        detachHomeListener(ownerUid, homeId);
      }
    };

    homesRef.on("child_added", onHomeAdded);
    homesRef.on("child_removed", onHomeRemoved);

    accountListenerMap.set(ownerUid, {
      ref: homesRef,
      onHomeAdded,
      onHomeRemoved,
    });

    return true;
  }

  async function startSecurityModeOrchestration() {
    if (started) {
      return false;
    }

    started = true;

    const accountsRef = db.ref("accounts");
    const accounts = asObject(getCachedAccountsObject());

    for (const [ownerUid, rawAccount] of Object.entries(accounts)) {
      const homes = asObject(rawAccount?.homes);

      for (const [homeId, rawHome] of Object.entries(homes)) {
        const key = getSecurityModeHomeKey(ownerUid, homeId);
        const home = asObject(rawHome);
        const currentMode = normalizeHomeSecurityMode(
          home.securityMode,
        );

        lastValueMap.set(key, currentMode);

        if (currentMode === "armed") {
          scheduleTask(() => {
            void triggerAlarmForUnsafeStateOnArmed(ownerUid, homeId);
            void triggerEmergencyForCurrentUnsafeState(ownerUid, homeId);
          }, 1000);
        } else if (currentMode === "unprotected") {
          scheduleTask(() => {
            void resolveAllAlarmIncidentsForHome(
              ownerUid,
              homeId,
              "home_unprotected",
            );
          }, 200);
        }
      }

      attachAccountListener(ownerUid);
    }

    const onAccountAdded = (accountSnapshot) => {
      const ownerUid = cleanText(accountSnapshot.key);

      if (ownerUid) {
        attachAccountListener(ownerUid);
      }
    };

    const onAccountRemoved = (accountSnapshot) => {
      const ownerUid = cleanText(accountSnapshot.key);

      if (ownerUid) {
        detachAccountListener(ownerUid);
      }
    };

    accountsRef.on("child_added", onAccountAdded);
    accountsRef.on("child_removed", onAccountRemoved);

    accountsRootListener = {
      ref: accountsRef,
      onAccountAdded,
      onAccountRemoved,
    };

    log(
      "🛡️ SECURITY MODE TRANSITION MONITOR STARTED:",
      `homes=${lastValueMap.size}`,
    );

    return true;
  }

  function stopSecurityModeOrchestration() {
    if (!started) {
      return false;
    }

    if (accountsRootListener) {
      accountsRootListener.ref.off(
        "child_added",
        accountsRootListener.onAccountAdded,
      );
      accountsRootListener.ref.off(
        "child_removed",
        accountsRootListener.onAccountRemoved,
      );
      accountsRootListener = null;
    }

    for (const ownerUid of Array.from(accountListenerMap.keys())) {
      detachAccountListener(ownerUid);
    }

    for (const key of Array.from(homeListenerMap.keys())) {
      const separatorIndex = key.indexOf("|");
      const ownerUid = key.slice(0, separatorIndex);
      const homeId = key.slice(separatorIndex + 1);
      detachHomeListener(ownerUid, homeId);
    }

    clearPendingTimers();
    lastValueMap.clear();
    transitionInProgress.clear();
    started = false;

    return true;
  }

  return {
    attachAccountListener,
    attachHomeListener,
    detachAccountListener,
    detachHomeListener,
    getKnownMode,
    getRuntimeState: () => ({
      started,
      accountListeners: accountListenerMap.size,
      homeListeners: homeListenerMap.size,
      knownHomes: lastValueMap.size,
      pendingTimers: pendingTimers.size,
      transitionsInProgress: transitionInProgress.size,
    }),
    handleModeValue,
    isHomeUnprotected,
    resolveAllAlarmIncidentsForHome,
    startSecurityModeOrchestration,
    stopSecurityModeOrchestration,
    supersedeSecurityIncidentForModeArming,
    triggerAlarmForUnsafeStateOnArmed,
    triggerEmergencyForCurrentUnsafeState,
  };
}

module.exports = {
  createSecurityModeOrchestrationDomain,
  getSecurityModeHomeKey,
};
