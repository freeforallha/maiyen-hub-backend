"use strict";

const crypto = require("node:crypto");
const {
  isActiveSignal,
  isVibrationAction,
  isGlassBreakAction,
  normalizeLockState,
} = require("../devices/device_profile");
const {
  normalizeRepeatMinutes,
  normalizeSecurityModeRepeatMinutes,
} = require("./alarm_schedule");

const SENSOR_EVENT_CATEGORY = Object.freeze({
  EMERGENCY: "emergency",
  SECURITY: "security",
  SYSTEM_WARNING: "system_warning",
  IGNORE: "ignore",
});

const SENSOR_EVENT_SEVERITY = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  ALARM: "alarm",
  EMERGENCY: "emergency",
});

const ALARM_INCIDENT_SCHEMA_VERSION = 2;
const SAME_ALARM_EVENT_MIN_INTERVAL_MS = 60 * 1000;
const SENSOR_ALARM_DEBOUNCE_MAX_AGE_MS = 5 * 60 * 1000;
const SENSOR_ALARM_DEBOUNCE_MAX_ENTRIES = 5000;
const DEFAULT_VIBRATION_ACTIVE_WINDOW_MS = 15 * 1000;
const DEFAULT_EMERGENCY_STATUS_HOLD_MS = 5 * 60 * 1000;

function normalizeHomeSecurityMode(value) {
  const mode = String(value || "").trim().toLowerCase();

  if (mode === "armed" || mode === "unprotected") {
    return mode;
  }

  return "normal";
}

function getStandardIncidentEventCategory(flowType) {
  return String(flowType || "").trim() === "emergency"
    ? SENSOR_EVENT_CATEGORY.EMERGENCY
    : SENSOR_EVENT_CATEGORY.SECURITY;
}

function getStandardIncidentAlarmLevel(flowType) {
  return String(flowType || "").trim() === "emergency"
    ? SENSOR_EVENT_SEVERITY.EMERGENCY
    : SENSOR_EVENT_SEVERITY.ALARM;
}

function getLegacyIncidentSeverity(flowType) {
  return String(flowType || "").trim() === "emergency"
    ? "critical"
    : "warning";
}

function getIncidentResolutionType(resolvedBy) {
  return String(resolvedBy || "").trim() === "safehome_backend"
    ? "automatic"
    : "manual";
}

function buildStandardIncidentFields(
  flowType,
  statusReason = "sensor_triggered",
) {
  return {
    schemaVersion: ALARM_INCIDENT_SCHEMA_VERSION,
    eventCategory: getStandardIncidentEventCategory(flowType),
    alarmLevel: getStandardIncidentAlarmLevel(flowType),
    severity: getLegacyIncidentSeverity(flowType),
    statusReason: String(statusReason || "sensor_triggered"),
  };
}

function getSensorAlarmEventCode(deviceType, reason) {
  const normalizedType = String(deviceType || "unknown").trim();
  const normalizedReason = String(reason || "")
    .trim()
    .toLowerCase();

  if (
    normalizedReason.includes("bị tháo") ||
    normalizedReason.includes("tamper") ||
    normalizedReason.includes("cạy")
  ) {
    return `${normalizedType}:tamper`;
  }

  if (normalizedType === "sos") return "sos:pressed";
  if (normalizedType === "smoke") return "smoke:active";
  if (normalizedType === "heat") return "heat:active";
  if (normalizedType === "carbon_monoxide") return "co:active";
  if (normalizedType === "gas") return "gas:active";
  if (
    normalizedType === "water_leak" ||
    normalizedType === "flood"
  ) {
    return "water_leak:active";
  }
  if (
    normalizedType === "door" ||
    normalizedType === "window" ||
    normalizedType === "gate"
  ) {
    return `${normalizedType}:open`;
  }
  if (
    normalizedType === "door_lock" ||
    normalizedType === "lock"
  ) {
    return `${normalizedType}:unlocked`;
  }
  if (
    normalizedType === "motion" ||
    normalizedType === "presence"
  ) {
    return `${normalizedType}:motion`;
  }
  if (normalizedType === "vibration") {
    return "vibration:detected";
  }
  if (normalizedType === "glass_break") {
    return "glass_break:detected";
  }

  return `${normalizedType}:${normalizedReason || "trigger"}`;
}

function getAlarmEventControlId(item) {
  const identity = [
    String(item?.ownerUid || "").trim(),
    String(item?.homeId || "").trim(),
    String(item?.deviceId || item?.deviceName || "").trim(),
    getSensorAlarmEventCode(item?.type, item?.reason),
  ].join("|");

  return crypto
    .createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
}

function getAlarmEventControlRuntimeKey(receiverUid, controlId) {
  return `${String(receiverUid || "").trim()}|${String(controlId || "").trim()}`;
}

function isPersistentAlarmEventCode(eventCode) {
  const normalized = String(eventCode || "").trim();

  return (
    normalized.endsWith(":open") ||
    normalized.endsWith(":unlocked") ||
    normalized.endsWith(":active") ||
    normalized.endsWith(":tamper")
  );
}

function isAlarmEventCodeActiveForDevice(eventCode, rawDevice) {
  const code = String(eventCode || "").trim();
  const device = rawDevice || {};

  if (code.endsWith(":tamper")) {
    return device.tamper === true;
  }

  if (
    code === "door:open" ||
    code === "window:open" ||
    code === "gate:open"
  ) {
    return device.contact === false;
  }

  if (code === "door_lock:unlocked" || code === "lock:unlocked") {
    return normalizeLockState(device) === "unlocked";
  }

  if (code === "smoke:active") {
    return isActiveSignal(device.smoke);
  }

  if (code === "heat:active") {
    return (
      isActiveSignal(device.heat) ||
      isActiveSignal(device.heat_alarm) ||
      isActiveSignal(device.high_temperature_alarm)
    );
  }

  if (code === "co:active") {
    return (
      isActiveSignal(device.carbon_monoxide) ||
      isActiveSignal(device.co_alarm)
    );
  }

  if (code === "gas:active") {
    return isActiveSignal(device.gas) || isActiveSignal(device.gas_alarm);
  }

  if (code === "water_leak:active") {
    return (
      isActiveSignal(device.water_leak) ||
      isActiveSignal(device.leak) ||
      isActiveSignal(device.water)
    );
  }

  return false;
}

function didEmergencySignalRise(oldDevice, updateData, keys) {
  const previous = oldDevice || {};
  const update = updateData || {};

  return keys.some((key) => {
    return (
      update[key] !== undefined &&
      isActiveSignal(update[key]) &&
      !isActiveSignal(previous[key])
    );
  });
}

function didEmergencyStatusTrigger(deviceType, oldDevice, updateData) {
  const type = String(deviceType || "unknown")
    .trim()
    .toLowerCase();

  if (type === "sos") {
    return updateData?.action !== undefined;
  }

  if (type === "smoke") {
    return didEmergencySignalRise(oldDevice, updateData, ["smoke"]);
  }

  if (type === "heat" || type === "temperature") {
    return didEmergencySignalRise(oldDevice, updateData, [
      "heat",
      "heat_alarm",
      "temperature_alarm",
      "high_temperature_alarm",
      "over_temperature_alarm",
    ]);
  }

  if (type === "carbon_monoxide") {
    return didEmergencySignalRise(oldDevice, updateData, [
      "carbon_monoxide",
      "co_alarm",
    ]);
  }

  if (type === "gas") {
    return didEmergencySignalRise(oldDevice, updateData, [
      "gas",
      "gas_alarm",
    ]);
  }

  if (type === "water_leak" || type === "flood") {
    return didEmergencySignalRise(oldDevice, updateData, [
      "water_leak",
      "leak",
      "water",
    ]);
  }

  if (
    [
      "smart_plug",
      "power_monitor",
      "ups",
      "electrical_fault",
      "short_circuit",
    ].includes(type)
  ) {
    return didEmergencySignalRise(oldDevice, updateData, [
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
    ]);
  }

  return false;
}

function createSensorAlarmEngine(options = {}) {
  const {
    db = null,
    getCachedAccountData = () => null,
    normalizeAlarmIncidentItems = (items) =>
      Array.isArray(items) ? items : [],
    isSecurityDeviceType = () => false,
    isEmergencyDeviceType = () => false,
    alarmEventControlRuntimeMap = new Map(),
    sensorAlarmEventDebounceMap = new Map(),
    sameAlarmEventMinIntervalMs = SAME_ALARM_EVENT_MIN_INTERVAL_MS,
    sensorAlarmDebounceMaxAgeMs = SENSOR_ALARM_DEBOUNCE_MAX_AGE_MS,
    sensorAlarmDebounceMaxEntries = SENSOR_ALARM_DEBOUNCE_MAX_ENTRIES,
    vibrationActiveWindowMs = DEFAULT_VIBRATION_ACTIVE_WINDOW_MS,
    emergencyStatusHoldMs = DEFAULT_EMERGENCY_STATUS_HOLD_MS,
    nowFn = () => Date.now(),
    log = (...args) => console.log(...args),
  } = options;

  if (!(alarmEventControlRuntimeMap instanceof Map)) {
    throw new TypeError("alarmEventControlRuntimeMap must be a Map");
  }
  if (!(sensorAlarmEventDebounceMap instanceof Map)) {
    throw new TypeError("sensorAlarmEventDebounceMap must be a Map");
  }
  if (typeof getCachedAccountData !== "function") {
    throw new TypeError("getCachedAccountData must be a function");
  }
  if (typeof normalizeAlarmIncidentItems !== "function") {
    throw new TypeError("normalizeAlarmIncidentItems must be a function");
  }
  if (typeof isSecurityDeviceType !== "function") {
    throw new TypeError("isSecurityDeviceType must be a function");
  }
  if (typeof isEmergencyDeviceType !== "function") {
    throw new TypeError("isEmergencyDeviceType must be a function");
  }
  if (typeof nowFn !== "function") {
    throw new TypeError("nowFn must be a function");
  }

  const console = { log };
  const minIntervalMs = Math.max(
    0,
    Number(sameAlarmEventMinIntervalMs) || 0,
  );
  const debounceMaxAgeMs = Math.max(
    0,
    Number(sensorAlarmDebounceMaxAgeMs) || 0,
  );
  const debounceMaxEntries = Math.max(
    1,
    Math.trunc(Number(sensorAlarmDebounceMaxEntries) || 1),
  );
  const vibrationWindowMs = Math.max(
    0,
    Number(vibrationActiveWindowMs) || 0,
  );
  const emergencyHoldMs = Math.max(
    0,
    Number(emergencyStatusHoldMs) || 0,
  );

  function normalizeDeviceAlarmPolicy(device, deviceType) {
    const raw =
      device?.alarmPolicy && typeof device.alarmPolicy === "object"
        ? device.alarmPolicy
        : {};
    const isEmergency = isEmergencyDeviceType(deviceType);

    return {
      enabled: isEmergency ? true : raw.enabled !== false,
      notificationEnabled: raw.notificationEnabled !== false,
      physicalSirenEnabled: raw.physicalSirenEnabled !== false,
      fullscreenEnabled: raw.fullscreenEnabled !== false,
    };
  }

  function getSensorEventCategory(deviceType) {
    if (isEmergencyDeviceType(deviceType)) {
      return SENSOR_EVENT_CATEGORY.EMERGENCY;
    }
    if (isSecurityDeviceType(deviceType)) {
      return SENSOR_EVENT_CATEGORY.SECURITY;
    }
    return SENSOR_EVENT_CATEGORY.SYSTEM_WARNING;
  }

  function getAlarmEventControlState(receiverUid, item) {
    const controlId = getAlarmEventControlId(item);
    const runtimeKey = getAlarmEventControlRuntimeKey(
      receiverUid,
      controlId,
    );
    const runtimeState = alarmEventControlRuntimeMap.get(runtimeKey);

    if (runtimeState) {
      return { controlId, state: runtimeState };
    }

    const account = getCachedAccountData(receiverUid);
    const cachedState = account?.alarmEventControls?.[controlId];

    return {
      controlId,
      state:
        cachedState && typeof cachedState === "object"
          ? cachedState
          : null,
    };
  }

  async function persistAlarmEventControlStates(receiverUid, states) {
    const cleanReceiverUid = String(receiverUid || "").trim();

    if (!cleanReceiverUid || !Array.isArray(states) || states.length === 0) {
      return;
    }

    const updates = {};

    for (const entry of states) {
      const controlId = String(entry?.controlId || "").trim();
      const state = entry?.state;

      if (!controlId || !state || typeof state !== "object") {
        continue;
      }

      alarmEventControlRuntimeMap.set(
        getAlarmEventControlRuntimeKey(cleanReceiverUid, controlId),
        state,
      );
      updates[
        `accounts/${cleanReceiverUid}/alarmEventControls/${controlId}`
      ] = state;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    if (!db || typeof db.ref !== "function") {
      throw new TypeError("db is required to persist Alarm event controls");
    }

    try {
      await db.ref().update(updates);
    } catch (error) {
      console.log(
        "ALARM EVENT CONTROL WRITE ERROR:",
        cleanReceiverUid,
        error.message,
      );
    }
  }

  async function markAlarmItemsTriggered(
    receiverUid,
    items,
    triggeredAt = nowFn(),
  ) {
    const unique = new Map();

    for (const item of normalizeAlarmIncidentItems(items)) {
      const { controlId, state: previous } = getAlarmEventControlState(
        receiverUid,
        item,
      );
      const eventCode = getSensorAlarmEventCode(item?.type, item?.reason);
      const state = {
        ...(previous || {}),
        ownerUid: String(item?.ownerUid || receiverUid).trim(),
        homeId: String(item?.homeId || "").trim(),
        deviceId: String(
          item?.deviceId || item?.deviceName || "",
        ).trim(),
        deviceType: String(item?.type || "unknown").trim(),
        eventCode,
        latched: isPersistentAlarmEventCode(eventCode),
        lastTriggeredAt: triggeredAt,
        cooldownUntil: triggeredAt + minIntervalMs,
        acknowledgedAt: null,
        acknowledgedBy: null,
        updatedAt: triggeredAt,
      };

      unique.set(controlId, { controlId, state });
    }

    await persistAlarmEventControlStates(
      receiverUid,
      [...unique.values()],
    );
  }

  async function markAlarmItemsAcknowledged(
    receiverUid,
    items,
    acknowledgedBy,
    acknowledgedAt = nowFn(),
  ) {
    const unique = new Map();

    for (const item of normalizeAlarmIncidentItems(items)) {
      const { controlId, state: previous } = getAlarmEventControlState(
        receiverUid,
        item,
      );
      const eventCode = getSensorAlarmEventCode(item?.type, item?.reason);
      const state = {
        ...(previous || {}),
        ownerUid: String(item?.ownerUid || receiverUid).trim(),
        homeId: String(item?.homeId || "").trim(),
        deviceId: String(
          item?.deviceId || item?.deviceName || "",
        ).trim(),
        deviceType: String(item?.type || "unknown").trim(),
        eventCode,
        latched: isPersistentAlarmEventCode(eventCode),
        lastTriggeredAt: Number(
          previous?.lastTriggeredAt || acknowledgedAt,
        ),
        cooldownUntil: Math.max(
          Number(previous?.cooldownUntil || 0),
          acknowledgedAt + minIntervalMs,
        ),
        acknowledgedAt,
        acknowledgedBy: String(acknowledgedBy || "").trim(),
        updatedAt: acknowledgedAt,
      };

      unique.set(controlId, { controlId, state });
    }

    await persistAlarmEventControlStates(
      receiverUid,
      [...unique.values()],
    );
  }

  function filterNewAlarmItemsByEventControl(
    receiverUid,
    items,
    now = nowFn(),
  ) {
    const accepted = [];

    for (const item of normalizeAlarmIncidentItems(items)) {
      const { state } = getAlarmEventControlState(receiverUid, item);
      const latched = state?.latched === true;
      const cooldownUntil = Number(state?.cooldownUntil || 0);

      if (latched || cooldownUntil > now) {
        console.log(
          "🧯 SAME ALARM EVENT SUPPRESSED:",
          receiverUid,
          item.homeId,
          item.deviceId,
          getSensorAlarmEventCode(item.type, item.reason),
          latched
            ? "waiting_sensor_reset"
            : `cooldown=${cooldownUntil - now}ms`,
        );
        continue;
      }

      accepted.push(item);
    }

    return accepted;
  }

  async function releaseAlarmEventControlsForDeviceState({
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
    device,
  }) {
    const cleanReceiverUid = String(receiverUid || "").trim();
    const cleanOwnerUid = String(ownerUid || "").trim();
    const cleanHomeId = String(homeId || "").trim();
    const cleanDeviceId = String(deviceId || "").trim();

    if (
      !cleanReceiverUid ||
      !cleanOwnerUid ||
      !cleanHomeId ||
      !cleanDeviceId
    ) {
      return;
    }

    const candidates = new Map();
    const cachedControls =
      getCachedAccountData(cleanReceiverUid)?.alarmEventControls || {};

    for (const [controlId, state] of Object.entries(cachedControls)) {
      if (state && typeof state === "object") {
        candidates.set(controlId, state);
      }
    }

    const runtimePrefix = `${cleanReceiverUid}|`;

    for (const [runtimeKey, state] of alarmEventControlRuntimeMap.entries()) {
      if (!runtimeKey.startsWith(runtimePrefix)) {
        continue;
      }

      const controlId = runtimeKey.slice(runtimePrefix.length);
      candidates.set(controlId, state);
    }

    const now = nowFn();
    const released = [];

    for (const [controlId, state] of candidates.entries()) {
      if (
        state?.latched !== true ||
        String(state.ownerUid || "").trim() !== cleanOwnerUid ||
        String(state.homeId || "").trim() !== cleanHomeId ||
        String(state.deviceId || "").trim() !== cleanDeviceId ||
        isAlarmEventCodeActiveForDevice(state.eventCode, device)
      ) {
        continue;
      }

      released.push({
        controlId,
        state: {
          ...state,
          latched: false,
          lastSafeAt: now,
          updatedAt: now,
        },
      });
    }

    if (released.length > 0) {
      await persistAlarmEventControlStates(cleanReceiverUid, released);
      console.log(
        "🔓 ALARM EVENT REARMED AFTER SAFE STATE:",
        cleanReceiverUid,
        cleanHomeId,
        cleanDeviceId,
        `events=${released.length}`,
      );
    }
  }

  function getSensorAlarmDebounceMs(deviceType, eventCode) {
    void deviceType;
    void eventCode;
    return minIntervalMs;
  }

  function cleanupSensorAlarmDebounceMap(now = nowFn()) {
    if (sensorAlarmEventDebounceMap.size < debounceMaxEntries) {
      return;
    }

    for (const [key, lastAcceptedAt] of
      sensorAlarmEventDebounceMap.entries()) {
      if (
        now - Number(lastAcceptedAt || 0) > debounceMaxAgeMs
      ) {
        sensorAlarmEventDebounceMap.delete(key);
      }
    }

    if (sensorAlarmEventDebounceMap.size > debounceMaxEntries) {
      const sortedEntries = [
        ...sensorAlarmEventDebounceMap.entries(),
      ].sort((a, b) => Number(a[1]) - Number(b[1]));
      const removeCount =
        sensorAlarmEventDebounceMap.size - debounceMaxEntries;

      for (const [key] of sortedEntries.slice(0, removeCount)) {
        sensorAlarmEventDebounceMap.delete(key);
      }
    }
  }

  function shouldAcceptSensorAlarmTrigger({
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
    deviceType,
    reason,
  }) {
    const eventCode = getSensorAlarmEventCode(deviceType, reason);
    const key = [
      String(receiverUid || "").trim(),
      String(ownerUid || "").trim(),
      String(homeId || "").trim(),
      String(deviceId || "").trim(),
      eventCode,
    ].join("|");
    const now = nowFn();
    const debounceMs = getSensorAlarmDebounceMs(
      deviceType,
      eventCode,
    );
    const lastAcceptedAt = Number(
      sensorAlarmEventDebounceMap.get(key) || 0,
    );

    if (
      lastAcceptedAt > 0 &&
      now - lastAcceptedAt < debounceMs
    ) {
      return false;
    }

    sensorAlarmEventDebounceMap.set(key, now);
    cleanupSensorAlarmDebounceMap(now);
    return true;
  }

  function buildAlarmTriggerFromSensorEvent({
    deviceType,
    deviceName,
    oldDevice,
    updateData,
  }) {
    const safeOldDevice = oldDevice || {};
    const safeUpdateData = updateData || {};

    if (deviceType === "smoke") {
      if (
        isActiveSignal(safeUpdateData.smoke) &&
        !isActiveSignal(safeOldDevice.smoke)
      ) {
        return {
          category: SENSOR_EVENT_CATEGORY.EMERGENCY,
          severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
          reason: `${deviceName}: Phát hiện khói`,
        };
      }
    }

    if (deviceType === "sos") {
      if (safeUpdateData.action !== undefined) {
        return {
          category: SENSOR_EVENT_CATEGORY.EMERGENCY,
          severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
          reason: `${deviceName}: SOS được kích hoạt`,
        };
      }
    }

    if (deviceType === "heat") {
      const triggered =
        (isActiveSignal(safeUpdateData.heat) &&
          !isActiveSignal(safeOldDevice.heat)) ||
        (isActiveSignal(safeUpdateData.heat_alarm) &&
          !isActiveSignal(safeOldDevice.heat_alarm)) ||
        (isActiveSignal(safeUpdateData.high_temperature_alarm) &&
          !isActiveSignal(safeOldDevice.high_temperature_alarm));

      if (triggered) {
        return {
          category: SENSOR_EVENT_CATEGORY.EMERGENCY,
          severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
          reason: `${deviceName}: Phát hiện nhiệt độ nguy hiểm`,
        };
      }
    }

    if (deviceType === "carbon_monoxide") {
      const triggered =
        (isActiveSignal(safeUpdateData.carbon_monoxide) &&
          !isActiveSignal(safeOldDevice.carbon_monoxide)) ||
        (isActiveSignal(safeUpdateData.co_alarm) &&
          !isActiveSignal(safeOldDevice.co_alarm));

      if (triggered) {
        return {
          category: SENSOR_EVENT_CATEGORY.EMERGENCY,
          severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
          reason: `${deviceName}: Phát hiện khí CO`,
        };
      }
    }

    if (deviceType === "gas") {
      const triggered =
        (isActiveSignal(safeUpdateData.gas) &&
          !isActiveSignal(safeOldDevice.gas)) ||
        (isActiveSignal(safeUpdateData.gas_alarm) &&
          !isActiveSignal(safeOldDevice.gas_alarm));

      if (triggered) {
        return {
          category: SENSOR_EVENT_CATEGORY.EMERGENCY,
          severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
          reason: `${deviceName}: Phát hiện rò rỉ gas`,
        };
      }
    }

    if (deviceType === "water_leak" || deviceType === "flood") {
      const triggered =
        (isActiveSignal(safeUpdateData.water_leak) &&
          !isActiveSignal(safeOldDevice.water_leak)) ||
        (isActiveSignal(safeUpdateData.leak) &&
          !isActiveSignal(safeOldDevice.leak)) ||
        (isActiveSignal(safeUpdateData.water) &&
          !isActiveSignal(safeOldDevice.water));

      if (triggered) {
        return {
          category: SENSOR_EVENT_CATEGORY.EMERGENCY,
          severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
          reason: `${deviceName}: Phát hiện ngập nước`,
        };
      }
    }

    if (
      isEmergencyDeviceType(deviceType) &&
      safeUpdateData.tamper === true &&
      safeOldDevice.tamper !== true
    ) {
      return {
        category: SENSOR_EVENT_CATEGORY.EMERGENCY,
        severity: SENSOR_EVENT_SEVERITY.EMERGENCY,
        reason: `${deviceName}: Thiết bị bị tháo`,
      };
    }

    if (isSecurityDeviceType(deviceType)) {
      if (
        safeUpdateData.contact === false &&
        safeOldDevice.contact !== false
      ) {
        return {
          category: SENSOR_EVENT_CATEGORY.SECURITY,
          severity: SENSOR_EVENT_SEVERITY.ALARM,
          reason: `${deviceName}: Cửa mở bất thường`,
        };
      }

      if (
        safeUpdateData.tamper === true &&
        safeOldDevice.tamper !== true
      ) {
        return {
          category: SENSOR_EVENT_CATEGORY.SECURITY,
          severity: SENSOR_EVENT_SEVERITY.ALARM,
          reason: `${deviceName}: Thiết bị bị tháo`,
        };
      }

      const motionTriggered =
        (isActiveSignal(safeUpdateData.occupancy) &&
          !isActiveSignal(safeOldDevice.occupancy)) ||
        (isActiveSignal(safeUpdateData.motion) &&
          !isActiveSignal(safeOldDevice.motion)) ||
        (isActiveSignal(safeUpdateData.presence) &&
          !isActiveSignal(safeOldDevice.presence));

      if (
        (deviceType === "motion" || deviceType === "presence") &&
        motionTriggered
      ) {
        return {
          category: SENSOR_EVENT_CATEGORY.SECURITY,
          severity: SENSOR_EVENT_SEVERITY.ALARM,
          reason: `${deviceName}: Phát hiện chuyển động`,
        };
      }

      const vibrationTriggered =
        deviceType === "vibration" &&
        ((isActiveSignal(safeUpdateData.vibration) &&
          !isActiveSignal(safeOldDevice.vibration)) ||
          (isVibrationAction(safeUpdateData.action) &&
            (!isVibrationAction(safeOldDevice.action) ||
              nowFn() - Number(safeOldDevice.last_vibration_at || 0) >
                vibrationWindowMs)));

      if (vibrationTriggered) {
        return {
          category: SENSOR_EVENT_CATEGORY.SECURITY,
          severity: SENSOR_EVENT_SEVERITY.ALARM,
          reason: `${deviceName}: Phát hiện rung/chấn động`,
        };
      }

      const glassBreakTriggered =
        deviceType === "glass_break" &&
        (((isActiveSignal(safeUpdateData.glass_break) ||
          isActiveSignal(safeUpdateData.broken_glass)) &&
          !(isActiveSignal(safeOldDevice.glass_break) ||
            isActiveSignal(safeOldDevice.broken_glass))) ||
          (isGlassBreakAction(safeUpdateData.action) &&
            !isGlassBreakAction(safeOldDevice.action)));

      if (glassBreakTriggered) {
        return {
          category: SENSOR_EVENT_CATEGORY.SECURITY,
          severity: SENSOR_EVENT_SEVERITY.ALARM,
          reason: `${deviceName}: Phát hiện kính vỡ`,
        };
      }

      if (
        (deviceType === "door_lock" || deviceType === "lock") &&
        normalizeLockState({
          ...safeOldDevice,
          ...safeUpdateData,
        }) === "unlocked" &&
        normalizeLockState(safeOldDevice) !== "unlocked"
      ) {
        return {
          category: SENSOR_EVENT_CATEGORY.SECURITY,
          severity: SENSOR_EVENT_SEVERITY.ALARM,
          reason: `${deviceName}: Khóa đã mở`,
        };
      }
    }

    return null;
  }

  function applyEmergencyStatusLatch(
    updateData,
    oldDevice,
    deviceType,
    now,
  ) {
    if (!didEmergencyStatusTrigger(deviceType, oldDevice, updateData)) {
      return false;
    }

    updateData.emergency_triggered_at = now;
    updateData.emergency_active_until = now + emergencyHoldMs;
    return true;
  }

  function resolveAlarmActivationPriority({
    deviceType,
    homeMode,
    policyEnabled = true,
    activeSchedule = null,
    alarmPaused = false,
    modeRepeatMinutes = 0,
  } = {}) {
    const normalizedType = String(deviceType || "unknown").trim();
    const normalizedMode = normalizeHomeSecurityMode(homeMode);

    if (normalizedMode === "unprotected") {
      return {
        active: false,
        flowType: isEmergencyDeviceType(normalizedType)
          ? "emergency"
          : "security",
        source: "",
        reason: "home_unprotected",
        repeatMinutes: 0,
      };
    }

    if (isEmergencyDeviceType(normalizedType)) {
      return {
        active: true,
        flowType: "emergency",
        source: "emergency_sensor",
        reason: "",
        repeatMinutes: 0,
      };
    }

    if (!isSecurityDeviceType(normalizedType)) {
      return {
        active: false,
        flowType: "security",
        source: "",
        reason: "unsupported_device_type",
        repeatMinutes: 0,
      };
    }

    if (policyEnabled !== true) {
      return {
        active: false,
        flowType: "security",
        source: "",
        reason: "device_alarm_disabled",
        repeatMinutes: 0,
      };
    }

    if (normalizedMode === "armed") {
      return {
        active: true,
        flowType: "security",
        source: "security_mode",
        reason: "",
        repeatMinutes: normalizeSecurityModeRepeatMinutes(
          modeRepeatMinutes,
        ),
      };
    }

    if (alarmPaused) {
      return {
        active: false,
        flowType: "security",
        source: "",
        reason: "alarm_paused",
        repeatMinutes: 0,
      };
    }

    if (!activeSchedule) {
      return {
        active: false,
        flowType: "security",
        source: "",
        reason: "alarm_schedule_inactive",
        repeatMinutes: 0,
      };
    }

    return {
      active: true,
      flowType: "security",
      source: "scheduled_alarm",
      reason: "",
      repeatMinutes: normalizeRepeatMinutes(
        activeSchedule?.alarm?.repeatMinutes,
      ),
    };
  }

  return {
    normalizeDeviceAlarmPolicy,
    getSensorEventCategory,
    getSensorAlarmEventCode,
    getAlarmEventControlId,
    getAlarmEventControlRuntimeKey,
    getAlarmEventControlState,
    isPersistentAlarmEventCode,
    isAlarmEventCodeActiveForDevice,
    persistAlarmEventControlStates,
    markAlarmItemsTriggered,
    markAlarmItemsAcknowledged,
    filterNewAlarmItemsByEventControl,
    releaseAlarmEventControlsForDeviceState,
    getSensorAlarmDebounceMs,
    cleanupSensorAlarmDebounceMap,
    shouldAcceptSensorAlarmTrigger,
    buildAlarmTriggerFromSensorEvent,
    didEmergencyStatusTrigger,
    applyEmergencyStatusLatch,
    resolveAlarmActivationPriority,
  };
}

module.exports = {
  SENSOR_EVENT_CATEGORY,
  SENSOR_EVENT_SEVERITY,
  ALARM_INCIDENT_SCHEMA_VERSION,
  SAME_ALARM_EVENT_MIN_INTERVAL_MS,
  SENSOR_ALARM_DEBOUNCE_MAX_AGE_MS,
  SENSOR_ALARM_DEBOUNCE_MAX_ENTRIES,
  normalizeHomeSecurityMode,
  getStandardIncidentEventCategory,
  getStandardIncidentAlarmLevel,
  getLegacyIncidentSeverity,
  getIncidentResolutionType,
  buildStandardIncidentFields,
  getSensorAlarmEventCode,
  getAlarmEventControlId,
  getAlarmEventControlRuntimeKey,
  isPersistentAlarmEventCode,
  isAlarmEventCodeActiveForDevice,
  didEmergencyStatusTrigger,
  createSensorAlarmEngine,
};
