"use strict";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function createMqttDeviceIngestionDomain(options = {}) {
  const {
    client,
    db,
    deviceMap = {},
    getFirebaseConnected = () => false,
    getCachedHomeData = () => null,
    applyDeviceUpdateToLocalCache = () => null,
    enqueueOfflineFirebaseUpdate = () => {},
    buildDeviceFirebaseUpdate,
    firebaseUpdateContainsTelemetry,
    updatePersistedTelemetrySnapshot,
    isActiveSignal,
    isVibrationAction,
    isGlassBreakAction,
    normalizeLockState,
    inferDeviceTypeFromPayload,
    applyEmergencyStatusLatch,
    scheduleEmergencyStatusClear = () => {},
    scheduleSosStateClear = () => {},
    scheduleVibrationStateClear = () => {},
    cancelVibrationStateClear = () => {},
    getHomeSirenRuntime = () => null,
    setPhysicalSirenForHome = async () => {},
    validateSecurityIncidentsForHome = async () => {},
    isPersistentEmergencyIncidentItem = () => false,
    isEmergencyIncidentItemStillUnsafe = () => null,
    resolveClearedPersistentEmergencyIncidents = async () => {},
    addDeviceNotification = async () => {},
    getAlarmReceiverUidsForHome = () => [],
    processScheduleAlarmsForOwner = async () => {},
    reconcileOfflineAlarmDemandsForHome = async () => {},
    emergencyStatusHoldMs = 5 * 60 * 1000,
    vibrationActiveWindowMs = 15 * 1000,
    coValuePersistIntervalMs = 30 * 1000,
    coTelemetryPersistIntervalMs = 60 * 1000,
    deviceTelemetryPersistIntervalMs = 60 * 1000,
    log = (...args) => console.log(...args),
  } = options;

  if (!client || typeof client.on !== "function") {
    throw new TypeError("client.on is required");
  }

  if (!db || typeof db.ref !== "function") {
    throw new TypeError("db.ref is required");
  }

  for (const [name, fn] of Object.entries({
    buildDeviceFirebaseUpdate,
    firebaseUpdateContainsTelemetry,
    updatePersistedTelemetrySnapshot,
    isActiveSignal,
    isVibrationAction,
    isGlassBreakAction,
    normalizeLockState,
    inferDeviceTypeFromPayload,
    applyEmergencyStatusLatch,
  })) {
    if (typeof fn !== "function") {
      throw new TypeError(`${name} is required`);
    }
  }

  const CO_VALUE_PERSIST_INTERVAL_MS = Math.max(1, Number(coValuePersistIntervalMs) || 30 * 1000);
  const CO_TELEMETRY_PERSIST_INTERVAL_MS = Math.max(1, Number(coTelemetryPersistIntervalMs) || 60 * 1000);
  const DEVICE_TELEMETRY_PERSIST_INTERVAL_MS = Math.max(1, Number(deviceTelemetryPersistIntervalMs) || 60 * 1000);
  const EMERGENCY_STATUS_HOLD_MS = Math.max(1, Number(emergencyStatusHoldMs) || 5 * 60 * 1000);
  const VIBRATION_ACTIVE_WINDOW_MS = Math.max(1, Number(vibrationActiveWindowMs) || 15 * 1000);

  const coSensorRuntimeMap = new Map();
  const coSensorProcessingPromiseMap = new Map();
  const devicePersistenceRuntimeMap = new Map();
  let started = false;

// ================= CO SENSOR FAST PATH =================
function isCarbonMonoxidePayload(data) {
  return Boolean(
    data &&
    typeof data === "object" &&
    (
      data.carbon_monoxide !== undefined ||
      data.co_alarm !== undefined ||
      data.co !== undefined
    )
  );
}

function telemetryValueChanged(previousValue, nextValue) {
  if (nextValue === undefined) {
    return false;
  }

  const previousNumber = Number(previousValue);
  const nextNumber = Number(nextValue);

  if (
    Number.isFinite(previousNumber) &&
    Number.isFinite(nextNumber)
  ) {
    return previousNumber !== nextNumber;
  }

  return previousValue !== nextValue;
}

async function processCarbonMonoxidePacket(
  deviceId,
  uid,
  homeId,
  data,
) {
  const deviceRef = db.ref(
    `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
  );

  let runtime = coSensorRuntimeMap.get(deviceId);

  // Ưu tiên snapshot cục bộ để CO vẫn xử lý được ngay khi Firebase mất mạng.
  if (!runtime) {
    let persistedDevice =
      getCachedHomeData(uid, homeId)?.devices?.[deviceId] || null;

    if (!persistedDevice && getFirebaseConnected()) {
      try {
        const deviceSnap = await deviceRef.once("value");
        persistedDevice = deviceSnap.val();
      } catch (error) {
        log(
          "CO FIREBASE READ FALLBACK:",
          deviceId,
          error.message,
        );
      }
    }

    if (!persistedDevice) {
      log(
        "⚠️ CO SKIPPED, NO LOCAL SNAPSHOT:",
        deviceId,
      );
      return;
    }

    runtime = {
      device: { ...persistedDevice },
      persistedCarbonMonoxide:
        persistedDevice.carbon_monoxide,
      persistedCoAlarm: persistedDevice.co_alarm,
      persistedCo: persistedDevice.co,
      persistedLastSeen: persistedDevice.last_seen,
      persistedLinkquality: persistedDevice.linkquality,
      lastCoPersistAt: 0,
      lastTelemetryPersistAt: 0,
    };

    coSensorRuntimeMap.set(deviceId, runtime);
  }

  const now = Date.now();
  const oldDevice = { ...runtime.device };
  const nextDevice = { ...oldDevice };

  const coFields = [
    "carbon_monoxide",
    "co_alarm",
    "co",
    "last_seen",
    "linkquality",
    "availability",
  ];

  for (const field of coFields) {
    if (data[field] !== undefined) {
      nextDevice[field] = data[field];
    }
  }

  if (
    String(oldDevice.type || "unknown").trim() === "unknown"
  ) {
    nextDevice.type = "carbon_monoxide";
  }

  const oldAlarmActive =
    isActiveSignal(oldDevice.carbon_monoxide) ||
    isActiveSignal(oldDevice.co_alarm);
  const nextAlarmActive =
    isActiveSignal(nextDevice.carbon_monoxide) ||
    isActiveSignal(nextDevice.co_alarm);
  const alarmActiveChanged =
    oldAlarmActive !== nextAlarmActive;
  const emergencyStatusTriggered =
    !oldAlarmActive && nextAlarmActive;

  const carbonMonoxideNeedsPersist =
    data.carbon_monoxide !== undefined &&
    data.carbon_monoxide !==
      runtime.persistedCarbonMonoxide;
  const coAlarmNeedsPersist =
    data.co_alarm !== undefined &&
    data.co_alarm !== runtime.persistedCoAlarm;
  const alarmStateNeedsPersist =
    carbonMonoxideNeedsPersist || coAlarmNeedsPersist;

  const coValueChanged = telemetryValueChanged(
    runtime.persistedCo,
    data.co,
  );
  const coPersistDue =
    coValueChanged &&
    (
      runtime.lastCoPersistAt === 0 ||
      now - runtime.lastCoPersistAt >=
        CO_VALUE_PERSIST_INTERVAL_MS ||
      alarmStateNeedsPersist
    );

  const telemetryPersistDue =
    runtime.lastTelemetryPersistAt === 0 ||
    now - runtime.lastTelemetryPersistAt >=
      CO_TELEMETRY_PERSIST_INTERVAL_MS;

  const updateData = {};

  // OFF → ON và ON → OFF luôn ghi ngay lập tức.
  if (carbonMonoxideNeedsPersist) {
    updateData.carbon_monoxide =
      data.carbon_monoxide;
  }

  if (coAlarmNeedsPersist) {
    updateData.co_alarm = data.co_alarm;
  }

  // ppm chỉ ghi tối đa 30 giây/lần và chỉ khi giá trị thay đổi.
  if (coPersistDue) {
    updateData.co = data.co;
  }

  // last_seen/linkquality chỉ ghi tối đa 60 giây/lần.
  if (telemetryPersistDue) {
    if (data.last_seen !== undefined) {
      updateData.last_seen = data.last_seen;
    }

    if (data.linkquality !== undefined) {
      updateData.linkquality = data.linkquality;
    }

    if (data.availability !== undefined) {
      updateData.availability = data.availability;
    }
  }

  if (
    oldDevice.type === "unknown" ||
    oldDevice.type === undefined ||
    oldDevice.type === null
  ) {
    updateData.type = "carbon_monoxide";
  }

  if (alarmActiveChanged) {
    updateData.last_event = now;
  }

  if (emergencyStatusTriggered) {
    updateData.emergency_triggered_at = now;
    updateData.emergency_active_until =
      now + EMERGENCY_STATUS_HOLD_MS;
  }

  runtime.device = nextDevice;

  if (Object.keys(updateData).length === 0) {
    return;
  }

  updateData.updated_at = now;
  const latestHomeFromCache = applyDeviceUpdateToLocalCache(
    uid,
    homeId,
    deviceId,
    updateData,
  );

  if (getFirebaseConnected()) {
    try {
      await deviceRef.update(updateData);
    } catch (error) {
      log(
        "📴 CO UPDATE QUEUED:",
        deviceId,
        error.message,
      );
      enqueueOfflineFirebaseUpdate(
        `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
        updateData,
      );
    }
  } else {
    enqueueOfflineFirebaseUpdate(
      `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
      updateData,
    );
  }

  runtime.device = {
    ...runtime.device,
    ...updateData,
  };

  if (updateData.carbon_monoxide !== undefined) {
    runtime.persistedCarbonMonoxide =
      updateData.carbon_monoxide;
  }

  if (updateData.co_alarm !== undefined) {
    runtime.persistedCoAlarm = updateData.co_alarm;
  }

  if (updateData.co !== undefined) {
    runtime.persistedCo = updateData.co;
    runtime.lastCoPersistAt = now;
  }

  if (
    updateData.last_seen !== undefined ||
    updateData.linkquality !== undefined ||
    updateData.availability !== undefined
  ) {
    runtime.persistedLastSeen = updateData.last_seen ??
      runtime.persistedLastSeen;
    runtime.persistedLinkquality = updateData.linkquality ??
      runtime.persistedLinkquality;
    runtime.lastTelemetryPersistAt = now;
  }

  log("☠️ CO FIREBASE UPDATE:", deviceId, updateData);

  if (emergencyStatusTriggered) {
    scheduleEmergencyStatusClear(
      uid,
      homeId,
      deviceId,
      now,
      Number(updateData.emergency_active_until || 0),
      "carbon_monoxide",
    );
  }

  // Chỉ khi trạng thái an toàn/nguy hiểm thực sự đổi mới đọc dữ liệu Home,
  // tạo lịch sử và chạy Alarm cho tất cả thành viên.
  if (!alarmActiveChanged) {
    return;
  }

  const deviceName =
    runtime.device.name || oldDevice.name || deviceId;
  const latestCo = Number(
    nextDevice.co ?? oldDevice.co,
  );
  const coText = Number.isFinite(latestCo)
    ? ` (${latestCo} ppm)`
    : "";

  if (getFirebaseConnected()) {
    await addDeviceNotification(
      uid,
      homeId,
      deviceId,
      nextAlarmActive
        ? `Phát hiện khí CO${coText}`
        : `Khí CO đã trở lại bình thường${coText}`,
      "status",
    );
  }

  // Khi CO hết nguy hiểm, đóng ngay các incident CO tương ứng và dừng còi
  // vật lý; không chờ auto-expire 30 phút.
  if (!nextAlarmActive) {
    const latestHomeData =
      latestHomeFromCache ||
      getCachedHomeData(uid, homeId) ||
      {};

    if (getFirebaseConnected()) {
      try {
        await resolveClearedPersistentEmergencyIncidents(
          uid,
          homeId,
          {
            homeOverride: latestHomeData,
            reason: "carbon_monoxide_cleared",
          },
        );
      } catch (error) {
        log(
          "CO INCIDENT RESOLVE DEFERRED:",
          homeId,
          error.message,
        );
      }
    }

    await reconcileOfflineAlarmDemandsForHome(uid, homeId);
    return;
  }

  const latestHomeData =
    latestHomeFromCache ||
    getCachedHomeData(uid, homeId) ||
    {};
  const homeName = latestHomeData.name || homeId;

  // processScheduleAlarmsForOwner cần state cũ để nhận đúng cạnh OFF → ON.
  const homeDataForAlarm = {
    ...latestHomeData,
    devices: {
      ...(latestHomeData.devices || {}),
      [deviceId]: oldDevice,
    },
  };

  const alarmReceiverUids = getAlarmReceiverUidsForHome(
    uid,
    homeId,
  );

  for (const receiverUid of alarmReceiverUids) {
    try {
      await processScheduleAlarmsForOwner(
        receiverUid,
        uid,
        homeId,
        homeName,
        deviceId,
        deviceName,
        "carbon_monoxide",
        homeDataForAlarm,
        {
          carbon_monoxide: nextDevice.carbon_monoxide,
          co_alarm: nextDevice.co_alarm,
          co: nextDevice.co,
          last_event: now,
          updated_at: now,
        },
      );
    } catch (receiverError) {
      log(
        "CO ALARM RECEIVER ERROR:",
        receiverUid,
        uid,
        homeId,
        receiverError.message,
      );
    }
  }

  await reconcileOfflineAlarmDemandsForHome(uid, homeId);
}

async function enqueueCarbonMonoxidePacket(
  deviceId,
  uid,
  homeId,
  data,
) {
  const previous =
    coSensorProcessingPromiseMap.get(deviceId) ||
    Promise.resolve();

  const current = previous
    .catch(() => { })
    .then(() => {
      return processCarbonMonoxidePacket(
        deviceId,
        uid,
        homeId,
        data,
      );
    });

  coSensorProcessingPromiseMap.set(deviceId, current);

  try {
    await current;
  } finally {
    if (
      coSensorProcessingPromiseMap.get(deviceId) === current
    ) {
      coSensorProcessingPromiseMap.delete(deviceId);
    }
  }
}

function getDevicePersistenceRuntime(deviceId, currentDevice) {
  const cleanDeviceId = String(deviceId || "").trim();

  if (!cleanDeviceId) {
    return {
      persistedTelemetry: {},
      lastTelemetryPersistAt: 0,
    };
  }

  let runtime = devicePersistenceRuntimeMap.get(cleanDeviceId);

  if (!runtime) {
    const device = asObject(currentDevice);

    runtime = {
      persistedTelemetry:
        updatePersistedTelemetrySnapshot({}, device),
      lastTelemetryPersistAt: Number(
        device.updated_at || 0,
      ),
    };

    devicePersistenceRuntimeMap.set(
      cleanDeviceId,
      runtime,
    );
  }

  return runtime;
}

function recordDeviceFirebaseUpdate(
  deviceId,
  runtime,
  firebaseUpdate,
  now,
) {
  const cleanDeviceId = String(deviceId || "").trim();

  if (!cleanDeviceId || !runtime) {
    return;
  }

  runtime.persistedTelemetry =
    updatePersistedTelemetrySnapshot(
      runtime.persistedTelemetry,
      firebaseUpdate,
    );

  if (firebaseUpdateContainsTelemetry(firebaseUpdate)) {
    runtime.lastTelemetryPersistAt = Number(now || Date.now());
  }

  devicePersistenceRuntimeMap.set(
    cleanDeviceId,
    runtime,
  );
}


async function handleMqttDeviceMessage(topic, msg) {
  try {
    const data = JSON.parse(msg.toString());

    // ===== SENSOR UPDATE =====
    if (!topic.startsWith("zigbee2mqtt/")) return;

    const rawTopic = topic.replace("zigbee2mqtt/", "");
    if (rawTopic.startsWith("bridge")) return;

    const topicParts = rawTopic.split("/");
    const deviceId = topicParts[0];
    const subTopic = topicParts[1] || null;

    // Không coi chính lệnh điều khiển /set hoặc /get là trạng thái sensor.
    // Chỉ lưu trạng thái thực do Zigbee2MQTT publish lại ở topic thiết bị.
    if (subTopic === "set" || subTopic === "get") {
      return;
    }

    if (subTopic === "availability") {
      const availabilityValue =
        typeof data === "string"
          ? data
          : data.state || data.availability || data.status || null;

      if (!availabilityValue) return;

      let map = deviceMap[deviceId];

      if (!map) {
        const snap = await db
          .ref(`system/devices_by_ieee/${deviceId}`)
          .once("value");

        const found = snap.val();

        if (!found?.uid || !found?.homeId) {
          log("⚠️ AVAILABILITY NO MAP:", deviceId);
          return;
        }

        map = {
          uid: found.uid,
          homeId: found.homeId,
        };

        deviceMap[deviceId] = map;
      }

      const { uid, homeId } = map;

      const deviceRef = db.ref(
        `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
      );

      let currentDevice =
        getCachedHomeData(uid, homeId)?.devices?.[deviceId] ||
        null;

      if (!currentDevice && getFirebaseConnected()) {
        const deviceSnap = await deviceRef.once("value");

        if (!deviceSnap.exists()) {
          log(
            "🧹 DEVICE DELETED FROM APP, REMOVE MAP:",
            deviceId,
          );

          delete deviceMap[deviceId];
          devicePersistenceRuntimeMap.delete(deviceId);

          await db.ref(`system/devices_by_ieee/${deviceId}`).remove();

          return;
        }

        currentDevice = deviceSnap.val() || {};
      }

      if (!currentDevice) {
        log(
          "⚠️ AVAILABILITY SKIPPED, NO LOCAL SNAPSHOT:",
          deviceId,
        );
        return;
      }

      if (currentDevice.availability === availabilityValue) {
        return;
      }

      const availabilityUpdate = {
        availability: availabilityValue,
        updated_at: Date.now(),
      };

      applyDeviceUpdateToLocalCache(
        uid,
        homeId,
        deviceId,
        availabilityUpdate,
      );

      if (getFirebaseConnected()) {
        try {
          await deviceRef.update(availabilityUpdate);
        } catch (error) {
          log(
            "📴 AVAILABILITY UPDATE QUEUED:",
            deviceId,
            error.message,
          );
          enqueueOfflineFirebaseUpdate(
            `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
            availabilityUpdate,
          );
        }
      } else {
        enqueueOfflineFirebaseUpdate(
          `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
          availabilityUpdate,
        );
      }

      log("📶 AVAILABILITY:", deviceId, availabilityValue);
      return;
    }

    const map = deviceMap[deviceId];
    if (!map) return;

    const { uid, homeId } = map;

    // Fast path riêng cho cảm biến CO: giữ Alarm tức thời nhưng không đọc/ghi
    // Firebase theo từng packet MQTT liên tục.
    if (isCarbonMonoxidePayload(data)) {
      await enqueueCarbonMonoxidePacket(
        deviceId,
        uid,
        homeId,
        data,
      );
      return;
    }

    const deviceRef = db.ref(
      `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
    );

    let homeData = getCachedHomeData(uid, homeId);
    let oldData = homeData?.devices?.[deviceId] || null;

    if ((!homeData || !oldData) && getFirebaseConnected()) {
      try {
        const [oldSnap, homeSnap] = await Promise.all([
          deviceRef.once("value"),
          db.ref(`accounts/${uid}/homes/${homeId}`)
            .once("value"),
        ]);

        oldData = oldSnap.val() || oldData || {};
        homeData = homeSnap.val() || homeData || {};
      } catch (error) {
        log(
          "MQTT FIREBASE READ FALLBACK:",
          deviceId,
          error.message,
        );
      }
    }

    if (!homeData || !oldData) {
      log(
        "⚠️ SENSOR SKIPPED, NO LOCAL SNAPSHOT:",
        deviceId,
      );
      return;
    }

    const deviceName = oldData.name || deviceId;
    const homeName = homeData.name || homeId;

    const oldTamper = oldData.tamper;

    const now = Date.now();

    const currentDeviceType = String(
      oldData.type || "unknown",
    ).trim();

    const inferredDeviceType =
      inferDeviceTypeFromPayload(
        data,
        currentDeviceType,
      );

    let updateData = {};

    if (
      currentDeviceType === "unknown" &&
      inferredDeviceType !== "unknown"
    ) {
      updateData.type = inferredDeviceType;
    }

    const fieldsToCopy = [
      "availability",
      "last_seen",
      "linkquality",
      "contact",
      "tamper",
      "battery",
      "battery_low",
      "smoke",
      "temperature",
      "humidity",
      "action",
      "occupancy",
      "motion",
      "presence",
      "vibration",
      "vibration_strength",
      "glass_break",
      "broken_glass",
      "sensitivity",
      "angle",
      "x_axis",
      "y_axis",
      "z_axis",
      "gas",
      "gas_alarm",
      "carbon_monoxide",
      "co_alarm",
      "co",
      "water_leak",
      "leak",
      "water",
      "heat",
      "heat_alarm",
      "temperature_alarm",
      "high_temperature_alarm",
      "over_temperature_alarm",
      "short_circuit",
      "short_circuit_alarm",
      "electrical_fault",
      "over_current",
      "overcurrent",
      "over_current_alarm",
      "over_voltage",
      "overvoltage",
      "over_voltage_alarm",
      "over_temperature",
      "overtemperature",
      "device_overheat",
      "electrical_overheat",
      "lock",
      "lock_state",
      "state",
      "power",
      "current",
      "voltage",
      "energy",
      "consumption",
      "device_temperature",
      "switch_type",

      // Cấu hình của còi NEO NAS-AB02B2. Trạng thái `alarm` được
      // copy riêng sau khi đã chắc chắn đây là thiết bị còi, tránh ghi đè
      // Map lịch Alarm của sensor an ninh.
      "melody",
      "duration",
      "volume",
      "battpercentage",
    ];

    for (const field of fieldsToCopy) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    const provisionalDeviceType =
      updateData.type ||
      currentDeviceType ||
      inferredDeviceType ||
      "unknown";

    if (
      provisionalDeviceType === "siren" &&
      data.alarm !== undefined
    ) {
      updateData.alarm = data.alarm;
    }

    const eventFields = [
      "contact",
      "tamper",
      "smoke",
      "action",
      "occupancy",
      "motion",
      "presence",
      "vibration",
      "glass_break",
      "broken_glass",
      "gas",
      "gas_alarm",
      "carbon_monoxide",
      "co_alarm",
      "water_leak",
      "leak",
      "water",
      "heat",
      "heat_alarm",
      "temperature_alarm",
      "high_temperature_alarm",
      "over_temperature_alarm",
      "short_circuit",
      "short_circuit_alarm",
      "electrical_fault",
      "over_current",
      "overcurrent",
      "over_current_alarm",
      "over_voltage",
      "overvoltage",
      "over_voltage_alarm",
      "over_temperature",
      "overtemperature",
      "device_overheat",
      "electrical_overheat",
      "lock",
      "lock_state",
      "state",
      "alarm",
    ];

    const hasChangedEventField = eventFields.some((field) => {
      if (field === "alarm" && provisionalDeviceType !== "siren") {
        return false;
      }

      return (
        data[field] !== undefined &&
        data[field] !== oldData[field]
      );
    });

    const vibrationEventPacket =
      provisionalDeviceType === "vibration" &&
      (
        (
          isActiveSignal(data.vibration) &&
          !isActiveSignal(oldData.vibration)
        ) ||
        (
          isVibrationAction(data.action) &&
          (
            !isVibrationAction(oldData.action) ||
            now - Number(oldData.last_vibration_at || 0) >
              VIBRATION_ACTIVE_WINDOW_MS
          )
        )
      );
    const glassBreakEventPacket =
      provisionalDeviceType === "glass_break" &&
      (
        (
          (
            isActiveSignal(data.glass_break) ||
            isActiveSignal(data.broken_glass)
          ) &&
          !(
            isActiveSignal(oldData.glass_break) ||
            isActiveSignal(oldData.broken_glass)
          )
        ) ||
        (
          isGlassBreakAction(data.action) &&
          !isGlassBreakAction(oldData.action)
        )
      );
    const vibrationClearPacket =
      provisionalDeviceType === "vibration" &&
      data.vibration !== undefined &&
      !isActiveSignal(data.vibration) &&
      !isVibrationAction(data.action);
    const shouldRecordLastEvent =
      provisionalDeviceType === "vibration"
        ? vibrationEventPacket
        : provisionalDeviceType === "glass_break"
          ? glassBreakEventPacket
          : hasChangedEventField && !vibrationClearPacket;

    if (shouldRecordLastEvent) {
      updateData.last_event = now;
    }

    if (data.battery !== undefined) {
      updateData.battery_status = "percent";
    }

    // Còi NEO dùng battpercentage thay cho battery. Chuẩn hóa thêm về
    // battery để phần UI/kiểm tra pin hiện có dùng chung được ngay.
    if (
      data.battpercentage !== undefined &&
      data.battery === undefined
    ) {
      const normalizedBattery = Number(
        data.battpercentage,
      );

      if (Number.isFinite(normalizedBattery)) {
        updateData.battery = normalizedBattery;
        updateData.battery_status = "percent";
      }
    }

    if (data.battery_low !== undefined) {
      updateData.battery_status =
        data.battery_low === true ? "low" : "ok";
    }

    const resolvedDeviceType =
      updateData.type ||
      currentDeviceType ||
      inferredDeviceType ||
      "unknown";

    if (
      resolvedDeviceType === "sos" &&
      data.action !== undefined
    ) {
      updateData.last_triggered = now;
      updateData.sos_active_until =
        now + EMERGENCY_STATUS_HOLD_MS;
    }

    const emergencyStatusTriggered =
      applyEmergencyStatusLatch(
        updateData,
        oldData,
        resolvedDeviceType,
        now,
      );

    if (resolvedDeviceType === "vibration") {
      if (vibrationEventPacket) {
        updateData.last_event = now;
        updateData.last_vibration_at = now;
        updateData.vibration_active_until =
          now + VIBRATION_ACTIVE_WINDOW_MS;
      } else if (
        data.vibration !== undefined &&
        !isActiveSignal(data.vibration)
      ) {
        updateData.vibration_active_until = null;
      }
    }

    if (
      resolvedDeviceType === "siren" &&
      data.alarm !== undefined
    ) {
      // Chỉ timestamp packet trạng thái thật do Zigbee2MQTT trả về.
      // Không dùng updated_at vì telemetry khác có thể làm xác nhận OFF sai.
      updateData.last_siren_report_at = now;
      updateData.siren_command_status = isActiveSignal(data.alarm)
        ? "reported_on"
        : "reported_off";
    }

    const persistenceRuntime =
      getDevicePersistenceRuntime(
        deviceId,
        oldData,
      );

    const firebaseUpdateData =
      buildDeviceFirebaseUpdate({
        candidateUpdate: updateData,
        currentDevice: oldData,
        persistedTelemetry:
          persistenceRuntime.persistedTelemetry,
        now,
        lastTelemetryPersistAt:
          persistenceRuntime.lastTelemetryPersistAt,
        telemetryIntervalMs:
          DEVICE_TELEMETRY_PERSIST_INTERVAL_MS,
      });

    const cacheUpdateData = {
      ...updateData,
    };

    if (firebaseUpdateData.updated_at !== undefined) {
      cacheUpdateData.updated_at =
        firebaseUpdateData.updated_at;
    }

    const latestHomeFromCache = applyDeviceUpdateToLocalCache(
      uid,
      homeId,
      deviceId,
      cacheUpdateData,
    );

    if (Object.keys(firebaseUpdateData).length > 0) {
      if (getFirebaseConnected()) {
        try {
          await deviceRef.update(firebaseUpdateData);
        } catch (error) {
          log(
            "📴 DEVICE UPDATE QUEUED:",
            deviceId,
            error.message,
          );
          enqueueOfflineFirebaseUpdate(
            `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
            firebaseUpdateData,
          );
        }
      } else {
        enqueueOfflineFirebaseUpdate(
          `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
          firebaseUpdateData,
        );
      }

      recordDeviceFirebaseUpdate(
        deviceId,
        persistenceRuntime,
        firebaseUpdateData,
        now,
      );
    }

    if (emergencyStatusTriggered) {
      scheduleEmergencyStatusClear(
        uid,
        homeId,
        deviceId,
        now,
        Number(updateData.emergency_active_until || 0),
        resolvedDeviceType,
      );
    }

    if (
      resolvedDeviceType === "sos" &&
      updateData.last_triggered === now
    ) {
      scheduleSosStateClear(
        uid,
        homeId,
        deviceId,
        now,
        Number(updateData.sos_active_until || 0),
      );
    }

    if (
      resolvedDeviceType === "vibration" &&
      updateData.last_vibration_at === now
    ) {
      scheduleVibrationStateClear(
        uid,
        homeId,
        deviceId,
        now,
      );
    } else if (
      resolvedDeviceType === "vibration" &&
      data.vibration !== undefined &&
      !isActiveSignal(data.vibration)
    ) {
      cancelVibrationStateClear(uid, homeId, deviceId);
    }

    // Còi có duration hữu hạn. Nếu nó tự OFF trong khi Home vẫn còn incident
    // yêu cầu còi, bật lại ngay thay vì chờ chu kỳ refresh 20 phút.
    if (
      resolvedDeviceType === "siren" &&
      data.alarm !== undefined &&
      !isActiveSignal(data.alarm)
    ) {
      const sirenRuntime = getHomeSirenRuntime(uid, homeId);

      if (sirenRuntime?.desiredOn === true) {
        setTimeout(() => {
          void setPhysicalSirenForHome(
            uid,
            homeId,
            true,
            {
              force: true,
              reason: "siren_reported_off_while_incident_active",
            },
          );
        }, 1000);
      }
    }

    const incidentStateFields = [
      "contact",
      "tamper",
      "occupancy",
      "motion",
      "presence",
      "lock",
      "lock_state",
      "state",
    ];

    const incidentStateChanged =
      incidentStateFields.some((field) => {
        return (
          updateData[field] !== undefined &&
          updateData[field] !== oldData[field]
        );
      });

    const latestHomeData = latestHomeFromCache || {
      ...homeData,
      devices: {
        ...(homeData.devices || {}),
        [deviceId]: {
          ...oldData,
          ...updateData,
        },
      },
    };

    if (incidentStateChanged && getFirebaseConnected()) {
      try {
        await validateSecurityIncidentsForHome(
          uid,
          homeId,
          "device_state_changed",
          { homeOverride: latestHomeData },
        );
      } catch (error) {
        log(
          "SECURITY INCIDENT VALIDATION DEFERRED:",
          homeId,
          error.message,
        );
      }
    }

    if (
      updateData.last_event !== undefined &&
      isPersistentEmergencyIncidentItem({
        type: resolvedDeviceType,
      }) &&
      isEmergencyIncidentItemStillUnsafe(
        latestHomeData,
        {
          deviceId,
          type: resolvedDeviceType,
        },
      ) === false
    ) {
      if (getFirebaseConnected()) {
        try {
          await resolveClearedPersistentEmergencyIncidents(
            uid,
            homeId,
            {
              homeOverride: latestHomeData,
              reason: `${resolvedDeviceType}_cleared`,
            },
          );
        } catch (error) {
          log(
            "EMERGENCY INCIDENT RESOLVE DEFERRED:",
            homeId,
            error.message,
          );
        }
      }
    }


    if (
      updateData.last_event !== undefined &&
      getFirebaseConnected()
    ) {
      let statusText = "";

      const currentType = updateData.type || oldData.type || "door";

      if (
        currentType === "door" ||
        currentType === "window" ||
        currentType === "gate"
      ) {
        statusText =
          updateData.contact === false
            ? "Cửa mở"
            : "Cửa đóng";
      } else if (
        currentType === "door_lock" ||
        currentType === "lock"
      ) {
        statusText =
          normalizeLockState({
            ...oldData,
            ...updateData,
          }) === "unlocked"
            ? "Khóa đã mở"
            : "Khóa đã đóng";
      } else if (
        currentType === "motion" ||
        currentType === "presence"
      ) {
        statusText = "Phát hiện chuyển động";
      } else if (currentType === "vibration") {
        statusText = "Phát hiện rung/chấn động";
      } else if (currentType === "glass_break") {
        statusText = "Phát hiện kính vỡ";
      } else if (currentType === "smoke") {
        statusText = isActiveSignal(updateData.smoke)
          ? "Phát hiện khói"
          : "Khói đã trở lại bình thường";
      } else if (currentType === "heat") {
        statusText = "Cập nhật cảnh báo nhiệt";
      } else if (currentType === "carbon_monoxide") {
        const latestCo = Number(
          updateData.co ?? oldData.co,
        );
        const coText = Number.isFinite(latestCo)
          ? ` (${latestCo} ppm)`
          : "";

        statusText = isActiveSignal(
          updateData.carbon_monoxide ??
          updateData.co_alarm ??
          oldData.carbon_monoxide ??
          oldData.co_alarm,
        )
          ? `Phát hiện khí CO${coText}`
          : `Khí CO đang bình thường${coText}`;
      } else if (currentType === "siren") {
        statusText = isActiveSignal(
          updateData.alarm ?? oldData.alarm,
        )
          ? "Còi báo động đang bật"
          : "Còi báo động đã tắt";
      } else if (currentType === "gas") {
        statusText = "Cập nhật cảm biến gas";
      } else if (
        currentType === "water_leak" ||
        currentType === "flood"
      ) {
        statusText = "Cập nhật cảm biến ngập nước";
      } else if (currentType === "sos") {
        statusText = "Nút SOS đã được bấm";
      } else if (currentType === "temperature") {
        statusText = "Cập nhật nhiệt độ / độ ẩm";
      } else if (currentType === "smart_plug") {
        statusText = "Ổ điện thông minh đã cập nhật";
      } else if (currentType === "repeater") {
        statusText = "Bộ mở rộng sóng đã cập nhật trạng thái";
      } else {
        statusText = "Thiết bị đã cập nhật trạng thái";
      }

      await addDeviceNotification(
        uid,
        homeId,
        deviceId,
        statusText,
        "status",
      );
    }

    if (
      getFirebaseConnected() &&
      updateData.tamper !== undefined &&
      updateData.tamper !== oldTamper
    ) {
      await addDeviceNotification(
        uid,
        homeId,
        deviceId,
        updateData.tamper ? "Tamper detected" : "Tamper cleared",
        "tamper",
      );
    }

    if (Object.keys(firebaseUpdateData).length > 0) {
      log(
        "📡 FIREBASE DEVICE UPDATE:",
        deviceId,
        firebaseUpdateData,
      );
    }

    // ===== HOME ALARM RECEIVERS =====
    // Chủ nhà + sharedByHome/{homeId}; mỗi receiver được xử lý độc lập.
    const alarmReceiverUids = getAlarmReceiverUidsForHome(
      uid,
      homeId,
    );

    log(
      "🚨 HOME ALARM RECEIVERS:",
      homeId,
      alarmReceiverUids,
    );

    for (const receiverUid of alarmReceiverUids) {
      try {
        await processScheduleAlarmsForOwner(
          receiverUid,
          uid,
          homeId,
          homeName,
          deviceId,
          deviceName,
          updateData.type || oldData.type || "door",
          homeData,
          updateData,
        );
      } catch (receiverError) {
        log(
          "HOME ALARM RECEIVER ERROR:",
          receiverUid,
          uid,
          homeId,
          receiverError.message,
        );
      }
    }

    await reconcileOfflineAlarmDemandsForHome(
      uid,
      homeId,
    );
  } catch (err) {
    log("MQTT ERROR:", err.message);
  }
}

  function startMqttDeviceIngestion() {
    if (started) {
      return false;
    }

    client.on("message", handleMqttDeviceMessage);
    started = true;
    log("📡 MQTT DEVICE INGESTION STARTED");
    return true;
  }

  function stopMqttDeviceIngestion() {
    if (!started) {
      return false;
    }

    if (typeof client.off === "function") {
      client.off("message", handleMqttDeviceMessage);
    } else if (typeof client.removeListener === "function") {
      client.removeListener("message", handleMqttDeviceMessage);
    }

    started = false;
    return true;
  }

  function getRuntimeState() {
    return {
      started,
      coRuntimeCount: coSensorRuntimeMap.size,
      coQueueCount: coSensorProcessingPromiseMap.size,
      persistenceRuntimeCount: devicePersistenceRuntimeMap.size,
    };
  }

  return {
    enqueueCarbonMonoxidePacket,
    getDevicePersistenceRuntime,
    getRuntimeState,
    handleMqttDeviceMessage,
    isCarbonMonoxidePayload,
    processCarbonMonoxidePacket,
    recordDeviceFirebaseUpdate,
    startMqttDeviceIngestion,
    stopMqttDeviceIngestion,
    telemetryValueChanged,
  };
}

module.exports = {
  createMqttDeviceIngestionDomain,
};
