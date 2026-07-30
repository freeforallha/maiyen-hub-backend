"use strict";

const crypto = require("node:crypto");

const HOME_SIREN_DEFAULT_VOLUME = "high";
const HOME_SIREN_DEFAULT_MELODY = "1";
const HOME_SIREN_COMMAND_DURATION_SEC = 30 * 60;
const HOME_SIREN_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const HOME_SIREN_RECONCILE_INTERVAL_MS = 15 * 1000;
const HOME_SIREN_STOP_MAX_ATTEMPTS = 3;
const HOME_SIREN_ON_CONFIRM_WAIT_MS = 2500;
const HOME_SIREN_STOP_CONFIRM_WAIT_MS = 1200;
const HOME_SIREN_STOP_RETRY_DELAY_MS = 350;
const HOME_SIREN_PERIODIC_LOG_INTERVAL_MS = 5 * 60 * 1000;

function createPhysicalSirenDomain(options = {}) {
  const {
    db,
    client,
    accountCache = new Map(),
    getCachedHomeData,
    getAlarmReceiverUidsForHome,
    incidentRequiresPhysicalSiren,
    isActiveSignal,
    isSystemHealthExplicitlyOffline,
    isSystemHealthExplicitlyOnline,
    parseSystemHealthTimestamp,
    getHeartbeatLimitMs,
    waitMs,
    applyDeviceUpdateToLocalCache,
    getFirebaseConnected = () => false,
    enqueueOfflineFirebaseUpdate,
    log = (...args) => console.log(...args),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  for (const [name, value] of Object.entries({
    db,
    client,
    getCachedHomeData,
    getAlarmReceiverUidsForHome,
    incidentRequiresPhysicalSiren,
    isActiveSignal,
    isSystemHealthExplicitlyOffline,
    isSystemHealthExplicitlyOnline,
    parseSystemHealthTimestamp,
    getHeartbeatLimitMs,
    waitMs,
    applyDeviceUpdateToLocalCache,
    enqueueOfflineFirebaseUpdate,
  })) {
    if (!value || (name !== "db" && name !== "client" && typeof value !== "function")) {
      throw new TypeError(`Missing physical siren dependency: ${name}`);
    }
  }

  const homeSirenRuntimeMap = new Map();
  const homeSirenLastLogMap = new Map();
  const homeSirenManualMuteRuntimeMap = new Map();
  let homeSirenReconcileTimer = null;

  const console = { log };

function getHomeSirenRuntimeKey(ownerUid, homeId) {
  return `${String(ownerUid || "").trim()}|${String(homeId || "").trim()}`;
}

function getHomeSirenIncidentMuteKey(receiverUid, incidentId) {
  return crypto
    .createHash("sha256")
    .update(
      `${String(receiverUid || "").trim()}|${String(incidentId || "").trim()}`,
    )
    .digest("hex")
    .slice(0, 24);
}

function normalizeHomeSirenManualMute(value) {
  if (!value || value.active !== true) {
    return null;
  }

  const mutedIncidentKeys = {};

  for (const [key, enabled] of Object.entries(
    value.mutedIncidentKeys || {},
  )) {
    const cleanKey = String(key || "").trim();

    if (cleanKey && enabled === true) {
      mutedIncidentKeys[cleanKey] = true;
    }
  }

  if (Object.keys(mutedIncidentKeys).length === 0) {
    return null;
  }

  return {
    active: true,
    mutedAt: Number(value.mutedAt || 0),
    mutedBy: String(value.mutedBy || "").trim(),
    mutedIncidentKeys,
  };
}

async function getHomeSirenManualMute(
  ownerUid,
  homeId,
  { useDatabase = false } = {},
) {
  const runtimeKey = getHomeSirenRuntimeKey(ownerUid, homeId);

  if (homeSirenManualMuteRuntimeMap.has(runtimeKey)) {
    return homeSirenManualMuteRuntimeMap.get(runtimeKey);
  }

  let rawValue = null;
  const cachedHome = getCachedHomeData(ownerUid, homeId);

  if (useDatabase || !cachedHome) {
    const snap = await db
      .ref(
        `accounts/${ownerUid}/homes/${homeId}/sirenManualMute`,
      )
      .once("value");
    rawValue = snap.val();
  } else {
    rawValue = cachedHome.sirenManualMute;
  }

  const normalized = normalizeHomeSirenManualMute(rawValue);
  homeSirenManualMuteRuntimeMap.set(runtimeKey, normalized);
  return normalized;
}

async function clearHomeSirenManualMute(ownerUid, homeId) {
  const runtimeKey = getHomeSirenRuntimeKey(ownerUid, homeId);
  homeSirenManualMuteRuntimeMap.set(runtimeKey, null);

  await db
    .ref(
      `accounts/${ownerUid}/homes/${homeId}/sirenManualMute`,
    )
    .remove();
}

function normalizeHomeSirenVolume(value) {
  const normalized = String(value || "").trim().toLowerCase();

  return ["low", "medium", "high"].includes(normalized)
    ? normalized
    : HOME_SIREN_DEFAULT_VOLUME;
}

function normalizeHomeSirenMelody(value) {
  const melody = Number.parseInt(value, 10);

  return Number.isFinite(melody) && melody >= 1 && melody <= 18
    ? String(melody)
    : HOME_SIREN_DEFAULT_MELODY;
}

function normalizeHomeSirenDuration(value) {
  const duration = Number.parseInt(value, 10);

  return Number.isFinite(duration) && duration >= 1 && duration <= 1800
    ? duration
    : HOME_SIREN_COMMAND_DURATION_SEC;
}

function getHomeSirenDevicesFromHome(home) {
  const devices = home?.devices || {};

  return Object.entries(devices)
    .filter(([, device]) => {
      return String(device?.type || "").trim() === "siren";
    })
    .map(([deviceId, device]) => ({
      deviceId,
      device: device || {},
    }));
}

function isHomeSirenDeviceReachable(device, now = Date.now()) {
  const availability = device?.availability;

  if (isSystemHealthExplicitlyOffline(availability)) {
    return false;
  }

  const lastSeen = parseSystemHealthTimestamp(device?.last_seen);

  if (
    lastSeen > 0 &&
    now - lastSeen > getHeartbeatLimitMs("siren") * 1.3
  ) {
    return false;
  }

  return isSystemHealthExplicitlyOnline(availability) || lastSeen > 0;
}

async function getHomeSirenDevices(ownerUid, homeId) {
  let home = getCachedHomeData(ownerUid, homeId);

  if (!home) {
    try {
      const snap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}`)
        .once("value");
      home = snap.val() || null;
    } catch (error) {
      console.log(
        "HOME SIREN LOAD HOME ERROR:",
        ownerUid,
        homeId,
        error.message,
      );
    }
  }

  return getHomeSirenDevicesFromHome(home);
}

function publishHomeSirenMqtt(deviceId, payload) {
  return new Promise((resolve) => {
    if (!client.connected) {
      resolve({
        ok: false,
        error: "mqtt_offline",
      });
      return;
    }

    client.publish(
      `zigbee2mqtt/${deviceId}/set`,
      JSON.stringify(payload),
      {
        qos: 1,
        retain: false,
      },
      (error) => {
        resolve({
          ok: !error,
          error: error?.message || "",
        });
      },
    );
  });
}

function getCachedHomeSirenReport(
  ownerUid,
  homeId,
  deviceId,
) {
  const home = getCachedHomeData(ownerUid, homeId);
  const device = home?.devices?.[deviceId];

  if (!device || device.alarm === undefined) {
    return null;
  }

  return {
    alarmOn: isActiveSignal(device.alarm),
    reportedAt: Number(device.last_siren_report_at || 0),
  };
}

async function waitForHomeSirenReportedOn(
  ownerUid,
  homeId,
  deviceId,
  commandStartedAt,
  timeoutMs = HOME_SIREN_ON_CONFIRM_WAIT_MS,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const report = getCachedHomeSirenReport(
      ownerUid,
      homeId,
      deviceId,
    );

    if (
      report &&
      report.alarmOn === true &&
      report.reportedAt >= commandStartedAt
    ) {
      return true;
    }

    await waitMs(120);
  }

  try {
    const snap = await db
      .ref(
        `accounts/${ownerUid}/homes/${homeId}/devices/${deviceId}`,
      )
      .once("value");
    const device = snap.val() || {};

    return (
      device.alarm !== undefined &&
      isActiveSignal(device.alarm) &&
      Number(device.last_siren_report_at || 0) >= commandStartedAt
    );
  } catch (_) {
    return false;
  }
}

async function waitForHomeSirenReportedOff(
  ownerUid,
  homeId,
  deviceId,
  commandStartedAt,
  timeoutMs = HOME_SIREN_STOP_CONFIRM_WAIT_MS,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const report = getCachedHomeSirenReport(
      ownerUid,
      homeId,
      deviceId,
    );

    if (
      report &&
      report.alarmOn === false &&
      report.reportedAt >= commandStartedAt
    ) {
      return true;
    }

    await waitMs(120);
  }

  try {
    const snap = await db
      .ref(
        `accounts/${ownerUid}/homes/${homeId}/devices/${deviceId}`,
      )
      .once("value");
    const device = snap.val() || {};

    return (
      device.alarm !== undefined &&
      !isActiveSignal(device.alarm) &&
      Number(device.last_siren_report_at || 0) >= commandStartedAt
    );
  } catch (_) {
    return false;
  }
}

async function persistHomeSirenUiState(
  ownerUid,
  homeId,
  deviceId,
  {
    alarmOn = null,
    commandStatus = "",
    commandedAt = Date.now(),
  } = {},
) {
  const updateData = {
    last_siren_command_at: commandedAt,
    siren_command_status: String(commandStatus || ""),
    updated_at: commandedAt,
  };

  if (typeof alarmOn === "boolean") {
    updateData.alarm = alarmOn;
  }

  applyDeviceUpdateToLocalCache(
    ownerUid,
    homeId,
    deviceId,
    updateData,
  );

  const devicePath =
    `accounts/${ownerUid}/homes/${homeId}/devices/${deviceId}`;

  if (getFirebaseConnected()) {
    try {
      await db.ref(devicePath).update(updateData);
      return;
    } catch (error) {
      console.log(
        "HOME SIREN UI STATE QUEUED:",
        deviceId,
        error.message,
      );
    }
  }

  enqueueOfflineFirebaseUpdate(devicePath, updateData);
}

function shouldLogHomeSirenResult(
  runtimeKey,
  { shouldTurnOn, status, successCount, deviceCount, confirmedCount, reason },
) {
  const now = Date.now();
  const signature = [
    shouldTurnOn ? "on" : "off",
    String(status || ""),
    `${successCount}/${deviceCount}`,
    `${confirmedCount}/${deviceCount}`,
  ].join("|");
  const previous = homeSirenLastLogMap.get(runtimeKey);
  const isPeriodic = reason === "periodic_reconcile";
  const shouldLog =
    !isPeriodic ||
    !previous ||
    previous.signature !== signature ||
    now - Number(previous.loggedAt || 0) >=
      HOME_SIREN_PERIODIC_LOG_INTERVAL_MS;

  if (shouldLog) {
    homeSirenLastLogMap.set(runtimeKey, {
      signature,
      loggedAt: now,
    });
  }

  return shouldLog;
}

async function setPhysicalSirenForHome(
  ownerUid,
  homeId,
  shouldTurnOn,
  {
    force = false,
    reason = "alarm_incident",
  } = {},
) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();

  if (!cleanOwnerUid || !cleanHomeId) {
    return {
      status: "invalid_home",
      deviceCount: 0,
      reachableCount: 0,
      offlineCount: 0,
      successCount: 0,
      confirmedCount: 0,
    };
  }

  const devices = await getHomeSirenDevices(
    cleanOwnerUid,
    cleanHomeId,
  );
  const now = Date.now();
  const reachableDevices = devices.filter(({ device }) => {
    return isHomeSirenDeviceReachable(device, now);
  });
  const offlineCount = devices.length - reachableDevices.length;
  const reachableIds = new Set(
    reachableDevices.map(({ deviceId }) => deviceId),
  );
  const deviceSignature = devices
    .map(({ deviceId }) => {
      return `${deviceId}:${reachableIds.has(deviceId) ? "online" : "offline"}`;
    })
    .sort()
    .join(",");
  const runtimeKey = getHomeSirenRuntimeKey(
    cleanOwnerUid,
    cleanHomeId,
  );
  const previous = homeSirenRuntimeMap.get(runtimeKey) || {};
  const needsRefresh =
    shouldTurnOn &&
    now - Number(previous.lastCommandAt || 0) >=
      HOME_SIREN_REFRESH_INTERVAL_MS;
  const stableStatus = shouldTurnOn
    ? previous.status === "active" ||
      previous.status === "active_partial"
    : previous.status === "stopped";

  if (
    !force &&
    previous.desiredOn === shouldTurnOn &&
    previous.deviceSignature === deviceSignature &&
    stableStatus &&
    !needsRefresh
  ) {
    return {
      status: previous.status,
      deviceCount: devices.length,
      reachableCount: reachableDevices.length,
      offlineCount,
      successCount: reachableDevices.length,
      confirmedCount: Number(
        previous.confirmedCount ?? reachableDevices.length,
      ),
      skipped: true,
    };
  }

  // Đổi desiredOn trước khi publish OFF để packet phản hồi `alarm:false`
  // không bị nhánh tự bật lại coi là còi tự tắt khi incident vẫn active.
  homeSirenRuntimeMap.set(runtimeKey, {
    ...previous,
    desiredOn: shouldTurnOn,
    deviceSignature,
    reason,
    updatedAt: now,
  });

  if (devices.length === 0) {
    homeSirenRuntimeMap.set(runtimeKey, {
      desiredOn: shouldTurnOn,
      deviceSignature,
      status: "no_devices",
      lastCommandAt: 0,
      confirmedCount: 0,
      reason,
      updatedAt: now,
    });

    console.log(
      "📢 HOME SIREN NO DEVICE:",
      cleanOwnerUid,
      cleanHomeId,
      shouldTurnOn ? "ON" : "OFF",
      reason,
    );

    return {
      status: "no_devices",
      deviceCount: 0,
      reachableCount: 0,
      offlineCount: 0,
      successCount: 0,
      confirmedCount: 0,
    };
  }

  if (!client.connected) {
    homeSirenRuntimeMap.set(runtimeKey, {
      desiredOn: shouldTurnOn,
      deviceSignature,
      status: "mqtt_offline",
      lastCommandAt: 0,
      confirmedCount: 0,
      reason,
      updatedAt: now,
    });

    console.log(
      "📢 HOME SIREN MQTT OFFLINE:",
      cleanOwnerUid,
      cleanHomeId,
      shouldTurnOn ? "ON" : "OFF",
      reason,
    );

    return {
      status: "mqtt_offline",
      deviceCount: devices.length,
      reachableCount: reachableDevices.length,
      offlineCount,
      successCount: 0,
      confirmedCount: 0,
    };
  }

  if (reachableDevices.length === 0) {
    homeSirenRuntimeMap.set(runtimeKey, {
      desiredOn: shouldTurnOn,
      deviceSignature,
      status: "devices_offline",
      lastCommandAt: 0,
      confirmedCount: 0,
      reason,
      updatedAt: now,
    });

    console.log(
      "📢 HOME SIREN DEVICES OFFLINE:",
      cleanOwnerUid,
      cleanHomeId,
      shouldTurnOn ? "ON" : "OFF",
      `online=0/${devices.length}`,
      reason,
    );

    return {
      status: "devices_offline",
      deviceCount: devices.length,
      reachableCount: 0,
      offlineCount: devices.length,
      successCount: 0,
      confirmedCount: 0,
    };
  }

  let successCount = 0;
  let confirmedCount = 0;

  for (const { deviceId, device } of reachableDevices) {
    if (shouldTurnOn) {
      const commandStartedAt = Date.now();

      // Chỉ ghi "đã gửi lệnh". Tuyệt đối không tự ghi alarm=true vì callback
      // MQTT chỉ xác nhận broker nhận lệnh, không chứng minh còi đã nhận hoặc kêu.
      await persistHomeSirenUiState(
        cleanOwnerUid,
        cleanHomeId,
        deviceId,
        {
          commandStatus: "on_command_sent",
          commandedAt: commandStartedAt,
        },
      );

      const result = await publishHomeSirenMqtt(
        deviceId,
        {
          alarm: true,
          volume: normalizeHomeSirenVolume(
            device.sirenVolume ?? device.volume,
          ),
          melody: normalizeHomeSirenMelody(
            device.sirenMelody ?? device.melody,
          ),
          duration: normalizeHomeSirenDuration(
            device.sirenDuration ?? device.duration,
          ),
        },
      );

      if (!result.ok) {
        await persistHomeSirenUiState(
          cleanOwnerUid,
          cleanHomeId,
          deviceId,
          {
            commandStatus: "on_command_failed",
            commandedAt: commandStartedAt,
          },
        );

        console.log(
          "HOME SIREN MQTT COMMAND ERROR:",
          deviceId,
          result.error,
        );
        continue;
      }

      successCount++;

      const reportedOn = await waitForHomeSirenReportedOn(
        cleanOwnerUid,
        cleanHomeId,
        deviceId,
        commandStartedAt,
      );

      if (reportedOn) {
        confirmedCount++;
      }

      continue;
    }

    let commandAccepted = false;
    let reportedOff = false;

    for (
      let attempt = 1;
      attempt <= HOME_SIREN_STOP_MAX_ATTEMPTS;
      attempt++
    ) {
      const commandStartedAt = Date.now();
      const result = await publishHomeSirenMqtt(
        deviceId,
        { alarm: false },
      );

      if (!result.ok) {
        console.log(
          "HOME SIREN MQTT STOP ERROR:",
          deviceId,
          `attempt=${attempt}`,
          result.error,
        );
      } else {
        commandAccepted = true;
        reportedOff = await waitForHomeSirenReportedOff(
          cleanOwnerUid,
          cleanHomeId,
          deviceId,
          commandStartedAt,
        );

        if (reportedOff) {
          break;
        }
      }

      if (attempt < HOME_SIREN_STOP_MAX_ATTEMPTS) {
        await waitMs(HOME_SIREN_STOP_RETRY_DELAY_MS);
      }
    }

    if (commandAccepted) {
      successCount++;
    }

    if (reportedOff) {
      confirmedCount++;

      await persistHomeSirenUiState(
        cleanOwnerUid,
        cleanHomeId,
        deviceId,
        {
          alarmOn: false,
          commandStatus: "off_confirmed",
        },
      );
    } else if (commandAccepted) {
      // Không ghi `alarm:false` khi thiết bị chưa xác nhận đã tắt. UI tiếp tục
      // hiện trạng thái đang kêu để người dùng có thể thử tắt lại.
      await persistHomeSirenUiState(
        cleanOwnerUid,
        cleanHomeId,
        deviceId,
        {
          commandStatus: "off_command_unconfirmed",
        },
      );
    }
  }

  const targetCount = reachableDevices.length;
  const allSucceeded = successCount === targetCount;
  const allConfirmed = confirmedCount === targetCount;
  let status;

  if (shouldTurnOn) {
    if (allConfirmed) {
      status = offlineCount > 0 ? "active_partial" : "active";
    } else if (confirmedCount > 0) {
      status = "partial";
    } else if (allSucceeded) {
      status = "start_unconfirmed";
    } else {
      status = "partial";
    }
  } else if (allConfirmed) {
    status = "stopped";
  } else if (allSucceeded) {
    status = "stopped_unconfirmed";
  } else {
    status = "partial";
  }

  homeSirenRuntimeMap.set(runtimeKey, {
    desiredOn: shouldTurnOn,
    deviceSignature,
    status,
    lastCommandAt: allConfirmed ? now : 0,
    confirmedCount,
    reason,
    updatedAt: Date.now(),
  });

  if (
    shouldLogHomeSirenResult(runtimeKey, {
      shouldTurnOn,
      status,
      successCount,
      deviceCount: devices.length,
      confirmedCount,
      reason,
    })
  ) {
    console.log(
      shouldTurnOn
        ? "🚨 HOME SIREN ON:"
        : "🔕 HOME SIREN OFF:",
      cleanOwnerUid,
      cleanHomeId,
      `accepted=${successCount}/${targetCount}`,
      `confirmed=${confirmedCount}/${targetCount}`,
      `online=${targetCount}/${devices.length}`,
      reason,
    );
  }

  return {
    status,
    deviceCount: devices.length,
    reachableCount: targetCount,
    offlineCount,
    successCount,
    confirmedCount,
  };
}

function collectHomeIncidentKeysInCache(
  ownerUid,
  homeId,
  { requirePhysicalSiren = false } = {},
) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();
  const incidentKeys = new Set();

  for (const [receiverUid, account] of accountCache.entries()) {
    const incidents = account?.alarmIncidents || {};

    for (const [incidentId, incident] of Object.entries(incidents)) {
      const belongsToHome =
        String(incident?.ownerUid || "").trim() === cleanOwnerUid &&
        String(incident?.homeId || "").trim() === cleanHomeId;
      const isActive = incident?.status === "active";

      if (
        belongsToHome &&
        isActive &&
        (!requirePhysicalSiren || incidentRequiresPhysicalSiren(incident))
      ) {
        incidentKeys.add(
          getHomeSirenIncidentMuteKey(receiverUid, incidentId),
        );
      }
    }
  }

  return incidentKeys;
}

function collectPhysicalSirenDemandKeysInCache(ownerUid, homeId) {
  return collectHomeIncidentKeysInCache(
    ownerUid,
    homeId,
    { requirePhysicalSiren: true },
  );
}

async function collectHomeIncidentKeysInDatabase(
  ownerUid,
  homeId,
  { requirePhysicalSiren = false } = {},
) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();
  const receiverUids = getAlarmReceiverUidsForHome(
    cleanOwnerUid,
    cleanHomeId,
  );
  const incidentKeys = new Set();

  const snapshots = await Promise.all(
    receiverUids.map(async (receiverUid) => ({
      receiverUid,
      snap: await db
        .ref(`accounts/${receiverUid}/alarmIncidents`)
        .once("value"),
    })),
  );

  for (const { receiverUid, snap } of snapshots) {
    const incidents = snap.val() || {};

    for (const [incidentId, incident] of Object.entries(incidents)) {
      const belongsToHome =
        String(incident?.ownerUid || "").trim() === cleanOwnerUid &&
        String(incident?.homeId || "").trim() === cleanHomeId;
      const isActive = incident?.status === "active";

      if (
        belongsToHome &&
        isActive &&
        (!requirePhysicalSiren || incidentRequiresPhysicalSiren(incident))
      ) {
        incidentKeys.add(
          getHomeSirenIncidentMuteKey(receiverUid, incidentId),
        );
      }
    }
  }

  return incidentKeys;
}

async function mutePhysicalSirenForHome(
  ownerUid,
  homeId,
  mutedBy,
  { reason = "manual_siren_mute" } = {},
) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();
  const now = Date.now();

  if (!cleanOwnerUid || !cleanHomeId) {
    return {
      status: "invalid_home",
      mutedIncidentCount: 0,
    };
  }

  // Snapshot toàn bộ incident active của Home, kể cả incident chưa tới cấp còi.
  // Nhờ vậy vòng leo thang sau đó cũng không bật lại còi của đúng sự cố đã tắt.
  // Incident mới có ID mới nên vẫn có thể kích hoạt còi trở lại.
  const activeIncidentKeys = collectHomeIncidentKeysInCache(
    cleanOwnerUid,
    cleanHomeId,
  );
  const databaseIncidentKeys = await collectHomeIncidentKeysInDatabase(
    cleanOwnerUid,
    cleanHomeId,
  );

  for (const key of databaseIncidentKeys) {
    activeIncidentKeys.add(key);
  }

  const mutedIncidentKeys = Object.fromEntries(
    Array.from(activeIncidentKeys).map((key) => [key, true]),
  );
  const muteState = activeIncidentKeys.size > 0
    ? {
        active: true,
        mutedAt: now,
        mutedBy: String(mutedBy || "").trim(),
        mutedIncidentKeys,
      }
    : null;
  const runtimeKey = getHomeSirenRuntimeKey(
    cleanOwnerUid,
    cleanHomeId,
  );

  homeSirenManualMuteRuntimeMap.set(runtimeKey, muteState);

  if (muteState) {
    await db
      .ref(
        `accounts/${cleanOwnerUid}/homes/${cleanHomeId}/sirenManualMute`,
      )
      .set(muteState);
  } else {
    await db
      .ref(
        `accounts/${cleanOwnerUid}/homes/${cleanHomeId}/sirenManualMute`,
      )
      .remove();
  }

  const result = await setPhysicalSirenForHome(
    cleanOwnerUid,
    cleanHomeId,
    false,
    {
      force: true,
      reason,
    },
  );

  console.log(
    "🔕 HOME SIREN MANUALLY MUTED:",
    cleanOwnerUid,
    cleanHomeId,
    `incidents=${activeIncidentKeys.size}`,
    `by=${String(mutedBy || "").trim()}`,
  );

  return {
    ...result,
    mutedIncidentCount: activeIncidentKeys.size,
  };
}

async function reconcilePhysicalSirenForHome(
  ownerUid,
  homeId,
  {
    force = false,
    useDatabase = false,
    reason = "siren_reconcile",
  } = {},
) {
  let demandKeys = new Set();

  try {
    demandKeys = useDatabase
      ? await collectHomeIncidentKeysInDatabase(
          ownerUid,
          homeId,
          { requirePhysicalSiren: true },
        )
      : collectPhysicalSirenDemandKeysInCache(
          ownerUid,
          homeId,
        );

    const manualMute = await getHomeSirenManualMute(
      ownerUid,
      homeId,
      { useDatabase },
    );

    if (manualMute && demandKeys.size === 0) {
      // Khi toàn bộ sự cố cũ đã kết thúc, tự bỏ mute để sự cố mới sau này
      // vẫn có thể kích hoạt còi bình thường.
      await clearHomeSirenManualMute(ownerUid, homeId);
    }

    const mutedKeys = new Set(
      Object.keys(manualMute?.mutedIncidentKeys || {}),
    );
    const hasUnmutedDemand = Array.from(demandKeys).some(
      (key) => !mutedKeys.has(key),
    );

    await setPhysicalSirenForHome(
      ownerUid,
      homeId,
      hasUnmutedDemand,
      {
        force,
        reason: manualMute && !hasUnmutedDemand
          ? `${reason}:manual_muted`
          : reason,
      },
    );
  } catch (error) {
    console.log(
      "HOME SIREN RECONCILE READ ERROR:",
      ownerUid,
      homeId,
      error.message,
    );
  }
}

async function requestPhysicalSirenForIncident(
  receiverUid,
  incidentId,
  incident,
  reason,
) {
  const ownerUid = String(
    incident?.ownerUid || receiverUid,
  ).trim();
  const homeId = String(incident?.homeId || "").trim();

  if (!ownerUid || !homeId) {
    return {
      status: "invalid_home",
      deviceCount: 0,
      successCount: 0,
    };
  }

  // Chặn phòng thủ tại điểm cuối. Timer cũ hoặc một lời gọi bị trễ không được
  // phép bật còi nếu snapshot incident hiện tại đã tắt còi vật lý.
  if (incident?.physicalSirenEnabled === false) {
    await reconcilePhysicalSirenForHome(
      ownerUid,
      homeId,
      {
        useDatabase: true,
        reason: `${reason}:physical_siren_disabled`,
      },
    );

    const devices = await getHomeSirenDevices(ownerUid, homeId);

    return {
      status: "disabled_by_policy",
      deviceCount: devices.length,
      successCount: 0,
    };
  }

  const incidentRef = db.ref(
    `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
  );
  const now = Date.now();

  // Ghi ý định trước khi publish để backend restart giữa chừng vẫn biết
  // sự cố này đang yêu cầu còi vật lý.
  await incidentRef.update({
    homeSirenStatus: "start_requested",
    homeSirenRequestedAt: now,
    updatedAt: now,
  });

  const manualMute = await getHomeSirenManualMute(
    ownerUid,
    homeId,
    { useDatabase: true },
  );
  const incidentMuteKey = getHomeSirenIncidentMuteKey(
    receiverUid,
    incidentId,
  );
  const isManuallyMuted =
    manualMute?.mutedIncidentKeys?.[incidentMuteKey] === true;

  let result;

  if (isManuallyMuted) {
    // Incident này đã được người dùng chủ động tắt còi. Chạy reconcile để
    // vẫn bật còi nếu Home đồng thời có một incident mới chưa bị mute.
    await reconcilePhysicalSirenForHome(
      ownerUid,
      homeId,
      {
        useDatabase: true,
        reason: `${reason}:manual_muted`,
      },
    );

    const devices = await getHomeSirenDevices(ownerUid, homeId);
    result = {
      status: "manual_muted",
      deviceCount: devices.length,
      successCount: 0,
    };
  } else {
    result = await setPhysicalSirenForHome(
      ownerUid,
      homeId,
      true,
      { reason },
    );
  }

  await incidentRef.update({
    homeSirenStatus: result.status,
    homeSirenDeviceCount: result.deviceCount,
    homeSirenCommandedAt: Date.now(),
    updatedAt: Date.now(),
  });

  return result;
}

function collectCachedHomesWithSiren() {
  const homes = [];

  for (const [ownerUid, account] of accountCache.entries()) {
    for (const [homeId, home] of Object.entries(
      account?.homes || {},
    )) {
      if (getHomeSirenDevicesFromHome(home).length > 0) {
        homes.push({ ownerUid, homeId });
      }
    }
  }

  return homes;
}

async function reconcileAllPhysicalSirens({
  force = false,
  reason = "periodic_reconcile",
} = {}) {
  const homes = collectCachedHomesWithSiren();

  for (const { ownerUid, homeId } of homes) {
    await reconcilePhysicalSirenForHome(
      ownerUid,
      homeId,
      {
        force,
        useDatabase: false,
        reason,
      },
    );
  }
}

function startPhysicalSirenMonitor() {
  if (homeSirenReconcileTimer) {
    return;
  }

  homeSirenReconcileTimer = setIntervalFn(() => {
    void reconcileAllPhysicalSirens({
      reason: "periodic_reconcile",
    });
  }, HOME_SIREN_RECONCILE_INTERVAL_MS);

  console.log(
    "📢 HOME SIREN MONITOR STARTED:",
    `interval=${HOME_SIREN_RECONCILE_INTERVAL_MS / 1000}s`,
  );
}


  function getHomeSirenRuntime(ownerUid, homeId) {
    return homeSirenRuntimeMap.get(
      getHomeSirenRuntimeKey(ownerUid, homeId),
    ) || null;
  }

  function stopPhysicalSirenMonitor() {
    if (!homeSirenReconcileTimer) {
      return;
    }

    clearIntervalFn(homeSirenReconcileTimer);
    homeSirenReconcileTimer = null;
  }

  return {
    getHomeSirenRuntimeKey,
    getHomeSirenRuntime,
    getHomeSirenIncidentMuteKey,
    normalizeHomeSirenManualMute,
    normalizeHomeSirenVolume,
    normalizeHomeSirenMelody,
    normalizeHomeSirenDuration,
    getHomeSirenDevicesFromHome,
    isHomeSirenDeviceReachable,
    getHomeSirenDevices,
    shouldLogHomeSirenResult,
    setPhysicalSirenForHome,
    collectHomeIncidentKeysInCache,
    collectPhysicalSirenDemandKeysInCache,
    collectHomeIncidentKeysInDatabase,
    mutePhysicalSirenForHome,
    reconcilePhysicalSirenForHome,
    requestPhysicalSirenForIncident,
    collectCachedHomesWithSiren,
    reconcileAllPhysicalSirens,
    startPhysicalSirenMonitor,
    stopPhysicalSirenMonitor,
  };
}

module.exports = {
  createPhysicalSirenDomain,
  HOME_SIREN_DEFAULT_VOLUME,
  HOME_SIREN_DEFAULT_MELODY,
  HOME_SIREN_COMMAND_DURATION_SEC,
  HOME_SIREN_REFRESH_INTERVAL_MS,
  HOME_SIREN_RECONCILE_INTERVAL_MS,
};
