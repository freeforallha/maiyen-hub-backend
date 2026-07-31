"use strict";

const DEFAULT_PAIR_DURATION_SECONDS = 60;
const MAX_PAIR_DURATION_SECONDS = 60;
const PAIR_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const PAIR_REQUEST_FUTURE_SKEW_MS = 1000;
const DEVICE_REMOVE_DELAY_MS = 2000;

const DEVICE_BASE_NAME_BY_TYPE = Object.freeze({
  door: "Cửa Nhà",
  window: "Cửa Sổ",
  gate: "Cổng Nhà",
  door_lock: "Khóa Cửa",
  lock: "Khóa Cửa",
  motion: "Giám sát chuyển động",
  presence: "Giám sát hiện diện",
  vibration: "Ghi nhận rung chấn",
  glass_break: "Phát hiện kính vỡ",
  smoke: "Báo cháy",
  heat: "Cảnh báo nhiệt độ",
  carbon_monoxide: "Cảnh báo khí CO",
  gas: "Cảnh báo rò rỉ gas",
  water_leak: "Cảnh báo ngập nước",
  flood: "Cảnh báo ngập nước",
  temperature: "Nhiệt độ và độ ẩm",
  sos: "Nút SOS",
  smart_plug: "Ổ cắm thông minh",
  power_monitor: "Theo dõi điện năng",
  ups: "Nguồn dự phòng",
  siren: "Còi báo động",
  smart_valve: "Van nước thông minh",
  camera: "Camera",
  doorbell: "Chuông cửa",
  keypad: "Bàn phím an ninh",
  repeater: "Bộ mở rộng sóng",
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizePairDuration(
  rawDuration,
  fallback = DEFAULT_PAIR_DURATION_SECONDS,
  maxDuration = MAX_PAIR_DURATION_SECONDS,
) {
  const duration = Number(rawDuration);

  if (
    Number.isFinite(duration) &&
    duration >= 1 &&
    duration <= maxDuration
  ) {
    return Math.floor(duration);
  }

  return fallback;
}

function isPairRequestFresh(
  requestTime,
  now,
  maxAgeMs = PAIR_REQUEST_MAX_AGE_MS,
  futureSkewMs = PAIR_REQUEST_FUTURE_SKEW_MS,
) {
  const timestamp = Number(requestTime);
  const currentTime = Number(now);

  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(currentTime) &&
    timestamp <= currentTime + futureSkewMs &&
    timestamp >= currentTime - maxAgeMs
  );
}

function normalizePairRequest(
  rawRequest,
  now,
  options = {},
) {
  const request = asObject(rawRequest);
  const maxDuration = Number(
    options.maxDurationSeconds || MAX_PAIR_DURATION_SECONDS,
  );
  const requestedDuration = Number(request.duration);
  const duration = normalizePairDuration(
    requestedDuration,
    DEFAULT_PAIR_DURATION_SECONDS,
    maxDuration,
  );

  const normalized = {
    active: request.active === true,
    requestedBy: cleanText(request.requestedBy),
    ownerUid: cleanText(request.ownerUid),
    homeId: cleanText(request.homeId),
    hubId: cleanText(request.hubId),
    roomId: cleanText(request.roomId || "unassigned"),
    duration,
    requestTime: Number(request.time),
  };

  normalized.valid = Boolean(
    normalized.active &&
      normalized.requestedBy &&
      normalized.ownerUid &&
      normalized.homeId &&
      normalized.hubId &&
      normalized.roomId &&
      Number.isFinite(requestedDuration) &&
      requestedDuration >= 1 &&
      requestedDuration <= maxDuration &&
      isPairRequestFresh(
        normalized.requestTime,
        now,
        options.maxAgeMs,
        options.futureSkewMs,
      ),
  );

  return normalized;
}

function getDeviceBaseName(deviceType) {
  const cleanType = cleanText(deviceType);

  return (
    DEVICE_BASE_NAME_BY_TYPE[cleanType] ||
    "Thiết bị chưa nhận diện"
  );
}

function getDefaultDeviceName(deviceType, rawDevices) {
  const devices = asObject(rawDevices);
  const cleanType = cleanText(deviceType);
  const baseName = getDeviceBaseName(cleanType);
  const sameTypeDevices = Object.values(devices).filter((device) => {
    return cleanText(device?.type) === cleanType;
  });

  if (sameTypeDevices.length === 0) {
    return baseName;
  }

  const existingNames = new Set(
    sameTypeDevices.map((device) => cleanText(device?.name)),
  );
  let sequenceNumber = Math.max(2, sameTypeDevices.length + 1);

  while (existingNames.has(`${baseName} ${sequenceNumber}`)) {
    sequenceNumber += 1;
  }

  return `${baseName} ${sequenceNumber}`;
}

function buildNewDeviceRecord({
  ieee,
  deviceType,
  roomId,
  timestamp,
  isSecurityDeviceType,
}) {
  const cleanDeviceType = cleanText(deviceType) || "unknown";
  const securityDevice = isSecurityDeviceType(cleanDeviceType);

  return {
    ieee: cleanText(ieee),
    type: cleanDeviceType,
    roomId: cleanText(roomId) || "unassigned",
    alarmPolicy: securityDevice
      ? {
          enabled: true,
          notificationEnabled: true,
          physicalSirenEnabled: true,
          fullscreenEnabled: true,
        }
      : null,
    alarmSchedules: securityDevice
      ? {
          default: {
            enabled: true,
            start: "23:00",
            end: "06:00",
            repeatMinutes: 0,
            days: [1, 2, 3, 4, 5, 6, 7],
          },
        }
      : null,
    availability: "unknown",
    last_seen: null,
    battery: null,
    battery_low: null,
    battpercentage: null,
    voltage: null,
    linkquality: null,
    contact: null,
    smoke: null,
    tamper: false,
    temperature: null,
    humidity: null,
    action: null,
    occupancy: null,
    motion: null,
    vibration: null,
    vibration_strength: null,
    last_vibration_at: null,
    vibration_active_until: null,
    glass_break: null,
    broken_glass: null,
    sensitivity: null,
    carbon_monoxide: null,
    co: null,
    melody: null,
    duration: null,
    volume: null,
    last_siren_report_at: null,
    last_event: null,
    created: timestamp,
    updated_at: timestamp,
  };
}

function createDeviceManagementDomain(options) {
  const {
    client,
    db,
    deviceMap,
    deviceId,
    getDeviceTypeFromModel,
    isSecurityDeviceType,
    getCachedHomeData,
    getSharedMembersForHome,
    addHomeNotificationToHomeRecipients,
    scheduleLocalRuntimeSnapshotSave,
    forgetDeviceRuntime,
    now = () => Date.now(),
    wait = (durationMs) =>
      new Promise((resolve) => setTimeout(resolve, durationMs)),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    maxPairDurationSeconds = MAX_PAIR_DURATION_SECONDS,
    pairRequestMaxAgeMs = PAIR_REQUEST_MAX_AGE_MS,
    pairRequestFutureSkewMs = PAIR_REQUEST_FUTURE_SKEW_MS,
    deviceRemoveDelayMs = DEVICE_REMOVE_DELAY_MS,
    log = (...args) => console.log(...args),
  } = options || {};

  if (!client || typeof client.on !== "function") {
    throw new Error("Device management requires an MQTT client");
  }

  if (!db || typeof db.ref !== "function") {
    throw new Error("Device management requires Firebase db");
  }

  if (!deviceMap || typeof deviceMap !== "object") {
    throw new Error("Device management requires deviceMap");
  }

  if (typeof getDeviceTypeFromModel !== "function") {
    throw new Error("Device management requires getDeviceTypeFromModel");
  }

  if (typeof isSecurityDeviceType !== "function") {
    throw new Error("Device management requires isSecurityDeviceType");
  }

  let started = false;
  let pairingSession = null;
  const pairCleanupTimerMap = new Map();
  const deviceDeleteInProgress = new Set();

  const refs = {
    deviceIndex: null,
    pairRequests: null,
    deleteRequests: null,
  };

  function getRef(path) {
    return db.ref(path);
  }

  function scheduleSnapshotSave() {
    if (typeof scheduleLocalRuntimeSnapshotSave === "function") {
      scheduleLocalRuntimeSnapshotSave();
    }
  }

  function forgetLocalDeviceRuntime(cleanDeviceId) {
    if (typeof forgetDeviceRuntime === "function") {
      forgetDeviceRuntime(cleanDeviceId);
    }
  }

  function getSharedMembers(homeId) {
    if (typeof getSharedMembersForHome !== "function") {
      return {};
    }

    return asObject(getSharedMembersForHome(homeId));
  }

  function publish(topic, payload) {
    return new Promise((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async function setPermitJoin(enable, time = DEFAULT_PAIR_DURATION_SECONDS) {
    const duration = normalizePairDuration(
      time,
      DEFAULT_PAIR_DURATION_SECONDS,
      maxPairDurationSeconds,
    );

    await publish("zigbee2mqtt/bridge/request/permit_join", {
      value: enable === true,
      time: duration,
    });

    log("permit_join =", enable === true);
  }

  function cancelPairCleanupTimer(requestId) {
    const timer = pairCleanupTimerMap.get(requestId);

    if (!timer) {
      return false;
    }

    clearTimeoutFn(timer);
    pairCleanupTimerMap.delete(requestId);
    return true;
  }

  async function removePairRequest(snapshot, requestId) {
    if (snapshot?.ref && typeof snapshot.ref.remove === "function") {
      await snapshot.ref.remove();
      return;
    }

    await getRef(`pair_requests/${requestId}`).remove();
  }

  async function closePairingSession(requestId, reason) {
    if (!pairingSession) {
      return false;
    }

    if (requestId && pairingSession.key !== requestId) {
      return false;
    }

    const closedKey = pairingSession.key;
    pairingSession = null;

    try {
      await setPermitJoin(false);
    } catch (error) {
      log("PAIR PERMIT CLOSE ERROR:", closedKey, error.message);
    }

    log("🔒 PAIR SESSION CLOSED:", closedKey, reason || "closed");
    return true;
  }

  function schedulePairRequestCleanup(snapshot, requestId, durationSeconds) {
    cancelPairCleanupTimer(requestId);

    const timer = setTimeoutFn(async () => {
      pairCleanupTimerMap.delete(requestId);

      try {
        await closePairingSession(requestId, "timeout");
        await removePairRequest(snapshot, requestId);
        log("🧹 PAIR REQUEST REMOVED:", requestId);
      } catch (error) {
        log("PAIR REQUEST CLEANUP ERROR:", error.message);
      }
    }, durationSeconds * 1000);

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }

    pairCleanupTimerMap.set(requestId, timer);
  }

  async function hasHomeAdminPermission(
    requestedBy,
    ownerUid,
    homeId,
  ) {
    if (requestedBy === ownerUid) {
      return true;
    }

    const sharedSnap = await getRef(
      `accounts/${requestedBy}/sharedHomes/${homeId}`,
    ).once("value");
    const sharedInfo = asObject(sharedSnap.val());

    return (
      cleanText(sharedInfo.ownerUid) === ownerUid &&
      cleanText(sharedInfo.role).toLowerCase() === "admin"
    );
  }

  function roomExists(homeData, roomId) {
    if (roomId === "unassigned") {
      return true;
    }

    return Object.prototype.hasOwnProperty.call(
      asObject(homeData?.rooms),
      roomId,
    );
  }

  async function handlePairRequest(snapshot) {
    const rawRequest = snapshot?.val?.();
    const requestId = cleanText(snapshot?.key);

    if (!rawRequest || !requestId) {
      return;
    }

    const normalized = normalizePairRequest(rawRequest, now(), {
      maxDurationSeconds: maxPairDurationSeconds,
      maxAgeMs: pairRequestMaxAgeMs,
      futureSkewMs: pairRequestFutureSkewMs,
    });

    schedulePairRequestCleanup(
      snapshot,
      requestId,
      normalized.duration,
    );

    try {
      if (!normalized.valid) {
        log("❌ PAIR REQUEST REJECTED: INVALID DATA", requestId);
        cancelPairCleanupTimer(requestId);
        await removePairRequest(snapshot, requestId);
        return;
      }

      if (normalized.hubId !== cleanText(deviceId)) {
        return;
      }

      const homeSnap = await getRef(
        `accounts/${normalized.ownerUid}/homes/${normalized.homeId}`,
      ).once("value");
      const homeData = homeSnap.val() || null;

      if (!homeSnap.exists() || !homeData) {
        log("❌ PAIR REQUEST REJECTED: HOME NOT FOUND", requestId);
        cancelPairCleanupTimer(requestId);
        await removePairRequest(snapshot, requestId);
        return;
      }

      const hasPermission = await hasHomeAdminPermission(
        normalized.requestedBy,
        normalized.ownerUid,
        normalized.homeId,
      );

      if (!hasPermission) {
        log(
          "❌ PAIR REQUEST REJECTED: NO PERMISSION",
          requestId,
          normalized.requestedBy,
        );
        cancelPairCleanupTimer(requestId);
        await removePairRequest(snapshot, requestId);
        return;
      }

      if (!roomExists(homeData, normalized.roomId)) {
        log(
          "❌ PAIR REQUEST REJECTED: ROOM NOT FOUND",
          requestId,
          normalized.roomId,
        );
        cancelPairCleanupTimer(requestId);
        await removePairRequest(snapshot, requestId);
        return;
      }

      if (pairingSession?.key === requestId) {
        return;
      }

      if (pairingSession) {
        log("❌ PAIR REQUEST REJECTED: HUB BUSY", requestId);
        cancelPairCleanupTimer(requestId);
        await removePairRequest(snapshot, requestId);
        return;
      }

      await setPermitJoin(true, normalized.duration);

      pairingSession = {
        key: requestId,
        uid: normalized.ownerUid,
        requestedBy: normalized.requestedBy,
        homeId: normalized.homeId,
        roomId: normalized.roomId,
        inProgressDevices: new Set(),
        pairedDevices: new Set(),
      };

      log(
        "🟢 PAIR START:",
        requestId,
        normalized.homeId,
        normalized.requestedBy,
      );
    } catch (error) {
      log("PAIR REQUEST PROCESS ERROR:", error.message);
      cancelPairCleanupTimer(requestId);
      await closePairingSession(requestId, "request_error");

      try {
        await removePairRequest(snapshot, requestId);
      } catch (_) {}
    }
  }

  async function handlePairRequestRemoved(snapshot) {
    const requestId = cleanText(snapshot?.key);

    if (!requestId) {
      return;
    }

    cancelPairCleanupTimer(requestId);
    await closePairingSession(requestId, "request_removed");
    log("🧹 REQUEST REMOVED:", requestId);
  }

  function upsertDeviceIndex(snapshot) {
    const cleanDeviceId = cleanText(snapshot?.key);
    const value = asObject(snapshot?.val?.());
    const uid = cleanText(value.uid);
    const homeId = cleanText(value.homeId);

    if (!cleanDeviceId) {
      return;
    }

    if (!uid || !homeId) {
      delete deviceMap[cleanDeviceId];
      forgetLocalDeviceRuntime(cleanDeviceId);
      scheduleSnapshotSave();
      return;
    }

    deviceMap[cleanDeviceId] = { uid, homeId };
    scheduleSnapshotSave();
  }

  function removeDeviceIndex(snapshot) {
    const cleanDeviceId = cleanText(snapshot?.key);

    if (!cleanDeviceId) {
      return;
    }

    delete deviceMap[cleanDeviceId];
    forgetLocalDeviceRuntime(cleanDeviceId);
    scheduleSnapshotSave();
  }

  async function registerPairedDevice(payload, eventType = "") {
    const session = pairingSession;
    const ieee = cleanText(payload?.ieee_address);

    if (!session || !ieee) {
      return false;
    }

    const definition = asObject(payload?.definition);

    if (
      eventType === "device_announce" &&
      !cleanText(definition.model) &&
      !cleanText(definition.description)
    ) {
      log("⏳ DEVICE INTERVIEW WAIT:", ieee);
      return false;
    }

    if (
      session.inProgressDevices.has(ieee) ||
      session.pairedDevices.has(ieee)
    ) {
      return false;
    }

    session.inProgressDevices.add(ieee);

    try {
      const indexRef = getRef(`system/devices_by_ieee/${ieee}`);
      const indexSnap = await indexRef.once("value");
      const existing = asObject(indexSnap.val());
      const existingUid = cleanText(existing.uid);
      const existingHomeId = cleanText(existing.homeId);

      if (
        existingUid &&
        existingHomeId &&
        (existingUid !== session.uid || existingHomeId !== session.homeId)
      ) {
        await getRef(
          `accounts/${existingUid}/homes/${existingHomeId}/devices/${ieee}`,
        ).remove();
      }

      const deviceType = getDeviceTypeFromModel(
        payload?.definition?.model,
        payload?.definition?.description,
        ieee,
      );
      const devicesRef = getRef(
        `accounts/${session.uid}/homes/${session.homeId}/devices`,
      );
      const devicesSnap = await devicesRef.once("value");
      const devices = asObject(devicesSnap.val());
      const defaultName = getDefaultDeviceName(deviceType, devices);
      const timestamp = now();
      const deviceRecord = {
        name: defaultName,
        ...buildNewDeviceRecord({
          ieee,
          deviceType,
          roomId: session.roomId,
          timestamp,
          isSecurityDeviceType,
        }),
      };

      await getRef(
        `accounts/${session.uid}/homes/${session.homeId}/devices/${ieee}`,
      ).set(deviceRecord);

      await indexRef.set({
        uid: session.uid,
        homeId: session.homeId,
        deviceId: cleanText(deviceId),
        hubType: "raspberry_pi",
        updatedAt: timestamp,
      });

      deviceMap[ieee] = {
        uid: session.uid,
        homeId: session.homeId,
      };
      scheduleSnapshotSave();

      const pairedHome =
        (typeof getCachedHomeData === "function" &&
          getCachedHomeData(session.uid, session.homeId)) ||
        {};
      const homeName =
        cleanText(pairedHome.name) || session.homeId;

      await addHomeNotificationToHomeRecipients({
        ownerUid: session.uid,
        homeId: session.homeId,
        homeName,
        type: "device_added",
        category: "device",
        severity: "info",
        title: "Thiết bị mới",
        message: `${defaultName}: Thiết bị mới`,
        deviceId: ieee,
        actorUid: session.requestedBy,
        entityType: "device",
        entityId: ieee,
        dedupeKey: `device_added|${ieee}`,
        dedupeMs: 60 * 1000,
        data: {
          deviceName: defaultName,
          deviceType,
          roomId: session.roomId || "unassigned",
        },
      });

      session.pairedDevices.add(ieee);
      log("✅ DEVICE READY:", ieee);
      return true;
    } finally {
      session.inProgressDevices.delete(ieee);
    }
  }

  async function handleMqttPairingMessage(topic, message) {
    try {
      if (topic !== "zigbee2mqtt/bridge/event" || !pairingSession) {
        return;
      }

      const data = JSON.parse(message.toString());
      const eventType = cleanText(data?.type);
      const payload = data?.data;

      if (
        !payload ||
        ![
          "device_announce",
          "device_interview",
          "device_connected",
        ].includes(eventType)
      ) {
        return;
      }

      await registerPairedDevice(payload, eventType);
    } catch (error) {
      log("MQTT PAIRING ERROR:", error.message);
    }
  }

  function forgetMappedDevice(deviceKey, ownerUid, homeId) {
    const mapped = asObject(deviceMap[deviceKey]);

    if (
      mapped.uid &&
      mapped.homeId &&
      (mapped.uid !== ownerUid || mapped.homeId !== homeId)
    ) {
      return false;
    }

    delete deviceMap[deviceKey];
    forgetLocalDeviceRuntime(deviceKey);
    scheduleSnapshotSave();
    return true;
  }

  async function notifyDeviceDeleteResult({
    ownerUid,
    homeId,
    deviceId: deletedDeviceId,
    requestedBy,
    deviceName,
    succeeded,
    errorMessage,
  }) {
    if (typeof addHomeNotificationToHomeRecipients !== "function") {
      return;
    }

    const home =
      (typeof getCachedHomeData === "function" &&
        getCachedHomeData(ownerUid, homeId)) ||
      {};
    const homeName = cleanText(home.name) || homeId;

    await addHomeNotificationToHomeRecipients({
      ownerUid,
      homeId,
      homeName,
      type: succeeded
        ? "device_delete_succeeded"
        : "device_delete_failed",
      category: "device",
      severity: succeeded ? "success" : "warning",
      title: succeeded
        ? "Thiết bị đã được xoá"
        : "Không thể xoá thiết bị",
      message: succeeded
        ? `${deviceName}: Thiết bị đã được xoá`
        : "Hãy thử lại thao tác xoá thiết bị.",
      deviceId: deletedDeviceId,
      actorUid: requestedBy,
      entityType: "device",
      entityId: deletedDeviceId,
      dedupeKey: `${
        succeeded
          ? "device_delete_succeeded"
          : "device_delete_failed"
      }|${deletedDeviceId}`,
      dedupeMs: 30 * 1000,
      data: {
        deviceName,
        requestedBy,
        ...(errorMessage
          ? { error: cleanText(errorMessage).slice(0, 200) }
          : {}),
      },
    });
  }

  async function removeDeleteRequest(snapshot, requestId) {
    if (snapshot?.ref && typeof snapshot.ref.remove === "function") {
      await snapshot.ref.remove();
      return;
    }

    await getRef(`device_delete_requests/${requestId}`).remove();
  }

  async function handleDeviceDeleteRequest(snapshot) {
    const requestId = cleanText(snapshot?.key);
    const request = asObject(snapshot?.val?.());

    if (!requestId || request.status !== "pending") {
      return;
    }

    const ownerUid = cleanText(request.ownerUid);
    const homeId = cleanText(request.homeId);
    const deletedDeviceId = cleanText(request.deviceId);
    const requestedBy = cleanText(request.requestedBy);

    if (!ownerUid || !homeId || !deletedDeviceId || !requestedBy) {
      log("❌ DEVICE DELETE REQUEST INVALID:", requestId);
      await removeDeleteRequest(snapshot, requestId);
      return;
    }

    const operationKey = `${ownerUid}|${homeId}|${deletedDeviceId}`;

    if (deviceDeleteInProgress.has(operationKey)) {
      return;
    }

    deviceDeleteInProgress.add(operationKey);

    try {
      const permitted = await hasHomeAdminPermission(
        requestedBy,
        ownerUid,
        homeId,
      );

      if (!permitted) {
        log(
          "❌ DEVICE DELETE REQUEST REJECTED: NO PERMISSION",
          requestId,
          requestedBy,
        );
        await removeDeleteRequest(snapshot, requestId);
        return;
      }

      const deviceRef = getRef(
        `accounts/${ownerUid}/homes/${homeId}/devices/${deletedDeviceId}`,
      );
      const [deviceSnap, indexSnap] = await Promise.all([
        deviceRef.once("value"),
        getRef(`system/devices_by_ieee/${deletedDeviceId}`).once("value"),
      ]);
      const storedDevice = asObject(deviceSnap.val());
      const deviceName =
        cleanText(storedDevice.name || request.deviceName) ||
        deletedDeviceId;
      const indexData = asObject(indexSnap.val());
      const indexUid = cleanText(indexData.uid);
      const indexHomeId = cleanText(indexData.homeId);
      const indexOwnedByTarget =
        (!indexUid && !indexHomeId) ||
        (indexUid === ownerUid && indexHomeId === homeId);

      if (!deviceSnap.exists()) {
        const updates = {
          [`device_delete_requests/${requestId}`]: null,
        };

        if (indexOwnedByTarget) {
          updates[`system/devices_by_ieee/${deletedDeviceId}`] = null;
        }

        await getRef("").update(updates);

        if (indexOwnedByTarget) {
          forgetMappedDevice(deletedDeviceId, ownerUid, homeId);
        }

        await notifyDeviceDeleteResult({
          ownerUid,
          homeId,
          deviceId: deletedDeviceId,
          requestedBy,
          deviceName,
          succeeded: true,
        });

        log("🧹 DEVICE ALREADY REMOVED:", deletedDeviceId);
        return;
      }

      if (!indexOwnedByTarget) {
        throw new Error("device_index_mismatch");
      }

      log(
        "🗑️ DELETE DEVICE:",
        deletedDeviceId,
        `owner=${ownerUid}`,
        `requestedBy=${requestedBy}`,
      );

      await publish("zigbee2mqtt/bridge/request/device/remove", {
        id: deletedDeviceId,
        force: true,
      });
      await wait(deviceRemoveDelayMs);

      const updates = {
        [`accounts/${ownerUid}/homes/${homeId}/devices/${deletedDeviceId}`]: null,
        [`system/devices_by_ieee/${deletedDeviceId}`]: null,
        [`device_delete_requests/${requestId}`]: null,
      };
      const affectedUids = new Set([ownerUid]);

      for (const sharedUid of Object.keys(getSharedMembers(homeId))) {
        const cleanUid = cleanText(sharedUid);

        if (cleanUid) {
          affectedUids.add(cleanUid);
        }
      }

      for (const affectedUid of affectedUids) {
        updates[
          `accounts/${affectedUid}/customRules/${homeId}/devices/${deletedDeviceId}`
        ] = null;
      }

      await getRef("").update(updates);
      forgetMappedDevice(deletedDeviceId, ownerUid, homeId);

      await notifyDeviceDeleteResult({
        ownerUid,
        homeId,
        deviceId: deletedDeviceId,
        requestedBy,
        deviceName,
        succeeded: true,
      });

      log(
        "✅ DEVICE REMOVED:",
        deletedDeviceId,
        `request=${requestId}`,
      );
    } catch (error) {
      log("DELETE DEVICE ERROR:", requestId, error.message);

      try {
        await notifyDeviceDeleteResult({
          ownerUid,
          homeId,
          deviceId: deletedDeviceId,
          requestedBy,
          deviceName:
            cleanText(request.deviceName) || deletedDeviceId,
          succeeded: false,
          errorMessage: error.message,
        });
      } catch (notificationError) {
        log(
          "DEVICE DELETE FAILURE NOTIFICATION ERROR:",
          notificationError.message,
        );
      }

      try {
        await removeDeleteRequest(snapshot, requestId);
      } catch (_) {}
    } finally {
      deviceDeleteInProgress.delete(operationKey);
    }
  }

  async function cleanupOldPairRequests() {
    await closePairingSession(null, "startup_cleanup");
    await getRef("pair_requests").remove();
    log("🧹 OLD PAIR REQUESTS CLEARED");
  }

  function attachFirebaseListener(ref, eventName, handler) {
    ref.on(eventName, handler);
  }

  function detachFirebaseListener(ref, eventName, handler) {
    if (ref && typeof ref.off === "function") {
      ref.off(eventName, handler);
    }
  }

  function startDeviceManagement() {
    if (started) {
      return false;
    }

    refs.deviceIndex = getRef("system/devices_by_ieee");
    refs.pairRequests = getRef("pair_requests");
    refs.deleteRequests = getRef("device_delete_requests");

    attachFirebaseListener(
      refs.deviceIndex,
      "child_added",
      upsertDeviceIndex,
    );
    attachFirebaseListener(
      refs.deviceIndex,
      "child_changed",
      upsertDeviceIndex,
    );
    attachFirebaseListener(
      refs.deviceIndex,
      "child_removed",
      removeDeviceIndex,
    );
    attachFirebaseListener(
      refs.pairRequests,
      "child_added",
      handlePairRequest,
    );
    attachFirebaseListener(
      refs.pairRequests,
      "child_removed",
      handlePairRequestRemoved,
    );
    attachFirebaseListener(
      refs.deleteRequests,
      "child_added",
      handleDeviceDeleteRequest,
    );
    client.on("message", handleMqttPairingMessage);

    started = true;
    log("🧩 DEVICE MANAGEMENT STARTED");
    return true;
  }

  async function stopDeviceManagement() {
    if (!started) {
      return false;
    }

    detachFirebaseListener(
      refs.deviceIndex,
      "child_added",
      upsertDeviceIndex,
    );
    detachFirebaseListener(
      refs.deviceIndex,
      "child_changed",
      upsertDeviceIndex,
    );
    detachFirebaseListener(
      refs.deviceIndex,
      "child_removed",
      removeDeviceIndex,
    );
    detachFirebaseListener(
      refs.pairRequests,
      "child_added",
      handlePairRequest,
    );
    detachFirebaseListener(
      refs.pairRequests,
      "child_removed",
      handlePairRequestRemoved,
    );
    detachFirebaseListener(
      refs.deleteRequests,
      "child_added",
      handleDeviceDeleteRequest,
    );

    if (typeof client.off === "function") {
      client.off("message", handleMqttPairingMessage);
    } else if (typeof client.removeListener === "function") {
      client.removeListener("message", handleMqttPairingMessage);
    }

    for (const requestId of pairCleanupTimerMap.keys()) {
      cancelPairCleanupTimer(requestId);
    }

    await closePairingSession(null, "domain_stop");
    started = false;
    return true;
  }

  function getRuntimeState() {
    return {
      started,
      pairingActive: pairingSession !== null,
      pairingRequestId: pairingSession?.key || null,
      pairedDeviceCount: pairingSession?.pairedDevices?.size || 0,
      cleanupTimerCount: pairCleanupTimerMap.size,
      deleteInProgressCount: deviceDeleteInProgress.size,
    };
  }

  return {
    cleanupOldPairRequests,
    getRuntimeState,
    handleDeviceDeleteRequest,
    handleMqttPairingMessage,
    handlePairRequest,
    handlePairRequestRemoved,
    registerPairedDevice,
    setPermitJoin,
    startDeviceManagement,
    stopDeviceManagement,
    upsertDeviceIndex,
    removeDeviceIndex,
  };
}

module.exports = {
  DEVICE_BASE_NAME_BY_TYPE,
  buildNewDeviceRecord,
  createDeviceManagementDomain,
  getDefaultDeviceName,
  getDeviceBaseName,
  isPairRequestFresh,
  normalizePairDuration,
  normalizePairRequest,
};
