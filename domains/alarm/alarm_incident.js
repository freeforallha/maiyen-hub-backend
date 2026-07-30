"use strict";

const crypto = require("node:crypto");
const {
  normalizeRepeatMinutes,
} = require("./alarm_schedule");

const SECURITY_DEVICE_TYPES = new Set([
  "door",
  "window",
  "gate",
  "lock",
  "door_lock",
  "motion",
  "presence",
  "vibration",
  "glass_break",
]);

const EMERGENCY_DEVICE_TYPES = new Set([
  "smoke",
  "heat",
  "carbon_monoxide",
  "gas",
  "water_leak",
  "flood",
  "sos",
]);

const PERSISTENT_EMERGENCY_DEVICE_TYPES = new Set([
  "smoke",
  "heat",
  "carbon_monoxide",
  "gas",
  "water_leak",
  "flood",
]);

const HOME_SIREN_ACTIVE_STATUSES = new Set([
  "start_requested",
  "start_unconfirmed",
  "active",
  "active_partial",
  "partial",
  "mqtt_offline",
  "devices_offline",
  "no_devices",
]);

function isSecurityDeviceType(deviceType) {
  return SECURITY_DEVICE_TYPES.has(deviceType);
}

function isEmergencyDeviceType(deviceType) {
  return EMERGENCY_DEVICE_TYPES.has(deviceType);
}

function getAlarmIncidentTargetKey(
  receiverUid,
  ownerUid,
  homeId,
  flowType = "security",
) {
  return crypto
    .createHash("sha256")
    .update(
      [
        String(receiverUid || ""),
        String(ownerUid || ""),
        String(homeId || ""),
        String(flowType || "security"),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
}

function getAlarmIncidentTimerKey(uid, incidentId) {
  return `${uid}_${incidentId}`;
}

function getLocalActiveAlarmIncidentKey(
  receiverUid,
  targetKey,
) {
  return `${receiverUid}|${targetKey}`;
}

function getAlarmStagePriority(stage) {
  const priorities = {
    detected: 0,
    notification: 0,
    alarm: 1,
    fullscreen_siren: 1,
    siren: 2,
    calling: 3,
  };

  return priorities[String(stage || "")] ?? -1;
}

function getAlarmStageRetryKey(
  receiverUid,
  incidentId,
  targetStage,
) {
  return `${receiverUid}_${incidentId}_${targetStage}`;
}

function getAlarmIncidentItemIdentity(item) {
  return [
    String(item?.ownerUid || "").trim(),
    String(item?.homeId || "").trim(),
    String(item?.deviceId || item?.deviceName || "").trim(),
    String(item?.type || "").trim(),
    String(item?.alarmSource || "scheduled_alarm").trim(),
    String(item?.reason || "").trim(),
  ].join("|");
}

function normalizeAlarmIncidentItems(items) {
  const uniqueItems = [];
  const seenIdentities = new Set();

  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = rawItem || {};
    const homeId = String(item.homeId || "").trim();
    const reason = String(item.reason || "").trim();

    if (!homeId || !reason) {
      continue;
    }

    // Không chỉ so sánh homeId + reason: hai cảm biến cùng tên/lý do trong
    // một nhà vẫn phải được giữ thành hai item độc lập.
    const identity = getAlarmIncidentItemIdentity(item);

    if (!seenIdentities.has(identity)) {
      seenIdentities.add(identity);
      uniqueItems.push({
        ownerUid: String(item.ownerUid || "").trim(),
        homeId,
        homeName:
          String(item.homeName || "").trim() || homeId,
        deviceId: String(item.deviceId || "").trim(),
        deviceName: String(item.deviceName || "").trim(),
        type: String(item.type || "").trim(),
        reason,
        repeatMinutes: normalizeRepeatMinutes(
          item.repeatMinutes,
        ),
        nextAlarm: String(item.nextAlarm || "").trim(),
        alarmSource:
          String(item.alarmSource || "scheduled_alarm").trim() ||
          "scheduled_alarm",
        eventCategory: String(
          item.eventCategory || "",
        ).trim(),
        alarmLevel: String(
          item.alarmLevel || item.severity || "",
        ).trim(),
        notificationEnabled:
          item.notificationEnabled !== false,
        physicalSirenEnabled:
          item.physicalSirenEnabled !== false,
        fullscreenEnabled:
          item.fullscreenEnabled !== false,
      });
    }
  }

  return uniqueItems.slice(0, 20);
}

function getSecurityAlarmSourcePriority(source) {
  switch (String(source || "").trim()) {
    case "security_mode":
      return 4;
    case "home_schedule":
      return 3;
    case "personal_schedule":
      return 2;
    case "scheduled_alarm":
      return 1;
    default:
      return 0;
  }
}

function getSecurityAlarmConditionIdentity(item) {
  return [
    String(item?.ownerUid || "").trim(),
    String(item?.homeId || "").trim(),
    String(item?.deviceId || item?.deviceName || "").trim(),
    String(item?.type || "").trim(),
    String(item?.reason || "").trim(),
  ].join("|");
}

function normalizePreferredSecurityIncidentItems(items) {
  const preferredByCondition = new Map();

  for (const item of normalizeAlarmIncidentItems(items)) {
    const conditionKey = getSecurityAlarmConditionIdentity(item);
    const current = preferredByCondition.get(conditionKey);

    if (
      !current ||
      getSecurityAlarmSourcePriority(item.alarmSource) >=
        getSecurityAlarmSourcePriority(current.alarmSource)
    ) {
      // Cùng điều kiện thì item mới hơn thắng để thay đổi notification,
      // fullscreen và còi vật lý có hiệu lực ngay trên incident đang active.
      preferredByCondition.set(conditionKey, item);
    }
  }

  return [...preferredByCondition.values()].slice(0, 20);
}

function filterCurrentSecurityAlarmDeliveryItems(
  requestedItems,
  currentItems,
) {
  const requestedConditionKeys = new Set(
    normalizePreferredSecurityIncidentItems(requestedItems).map(
      getSecurityAlarmConditionIdentity,
    ),
  );

  if (requestedConditionKeys.size === 0) {
    return normalizePreferredSecurityIncidentItems(currentItems);
  }

  return normalizePreferredSecurityIncidentItems(currentItems).filter(
    (item) => requestedConditionKeys.has(
      getSecurityAlarmConditionIdentity(item),
    ),
  );
}

function getAlarmIncidentFlowType(items) {
  const normalized = normalizeAlarmIncidentItems(items);

  return normalized.some((item) => {
    return isEmergencyDeviceType(
      String(item.type || "").trim(),
    );
  })
    ? "emergency"
    : "security";
}

function getEmergencyIncidentTitle(items) {
  const types = new Set(
    normalizeAlarmIncidentItems(items).map((item) => {
      return String(item.type || "").trim();
    }),
  );

  if (types.has("sos")) {
    return "🆘 SOS KHẨN CẤP";
  }

  if (types.has("smoke")) {
    return "🔥 CẢNH BÁO KHÓI / CHÁY";
  }

  if (types.has("heat")) {
    return "🌡️ CẢNH BÁO NHIỆT ĐỘ NGUY HIỂM";
  }

  if (types.has("carbon_monoxide")) {
    return "☠️ CẢNH BÁO KHÍ CO";
  }

  if (types.has("gas")) {
    return "⚠️ CẢNH BÁO RÒ RỈ GAS";
  }

  if (
    types.has("water_leak") ||
    types.has("flood")
  ) {
    return "🌊 CẢNH BÁO NGẬP NƯỚC";
  }

  return "🚨 CẢNH BÁO KHẨN CẤP";
}

function getAlarmIncidentLines(items) {
  const normalized = normalizeAlarmIncidentItems(items);
  const lines = normalized.slice(0, 4).map((item) => {
    return `${item.homeName}: ${item.reason}`;
  });

  if (normalized.length > 4) {
    lines.push("...");
  }

  return lines;
}

function haveAlarmIncidentItemsChanged(oldItems, newItems) {
  return JSON.stringify(
    normalizePreferredSecurityIncidentItems(oldItems),
  ) !== JSON.stringify(
    normalizePreferredSecurityIncidentItems(newItems),
  );
}

function getAlarmIncidentRuntimePreferences(items) {
  const normalizedItems = normalizeAlarmIncidentItems(items);

  return {
    notificationEnabled: normalizedItems.some(
      (item) => item.notificationEnabled !== false,
    ),
    fullscreenEnabled: normalizedItems.some(
      (item) => item.fullscreenEnabled !== false,
    ),
    physicalSirenEnabled: normalizedItems.some(
      (item) => item.physicalSirenEnabled !== false,
    ),
  };
}

function isPersistentEmergencyIncidentItem(item) {
  const type = String(item?.type || "").trim();
  return PERSISTENT_EMERGENCY_DEVICE_TYPES.has(type);
}

function getSecurityIncidentStageRank(stage) {
  return [
    "detected",
    "alarm",
    "siren",
    "calling",
  ].indexOf(String(stage || "detected"));
}

function incidentRequiresPhysicalSiren(incident) {
  if (!incident || incident.status !== "active") {
    return false;
  }

  if (incident.physicalSirenEnabled === false) {
    return false;
  }

  const requestedStatus = String(
    incident.homeSirenStatus || "",
  ).trim();

  if (HOME_SIREN_ACTIVE_STATUSES.has(requestedStatus)) {
    return true;
  }

  const stage = String(incident.stage || "").trim();

  if (incident.flowType === "emergency") {
    return stage === "fullscreen_siren" || stage === "calling";
  }

  return stage === "siren" || stage === "calling";
}

function createAlarmIncidentDomain({
  localActiveAlarmIncidentMap = new Map(),
  offlineTransientAlarmTtlMs,
  alarmIncidentAutoExpireMs,
} = {}) {
  if (!(localActiveAlarmIncidentMap instanceof Map)) {
    throw new TypeError("localActiveAlarmIncidentMap must be a Map");
  }

  const transientTtlMs = Number(offlineTransientAlarmTtlMs);
  const autoExpireMs = Number(alarmIncidentAutoExpireMs);

  if (!Number.isFinite(transientTtlMs) || transientTtlMs < 0) {
    throw new TypeError("offlineTransientAlarmTtlMs must be non-negative");
  }

  if (!Number.isFinite(autoExpireMs) || autoExpireMs < 0) {
    throw new TypeError("alarmIncidentAutoExpireMs must be non-negative");
  }

  function setLocalActiveAlarmIncident(
    receiverUid,
    incidentId,
    incident,
  ) {
    const targetKey = String(
      incident?.targetKey || "",
    ).trim();

    if (!receiverUid || !incidentId || !targetKey) {
      return;
    }

    localActiveAlarmIncidentMap.set(
      getLocalActiveAlarmIncidentKey(
        receiverUid,
        targetKey,
      ),
      {
        incidentId,
        incident,
      },
    );
  }

  function hasLocalActiveAlarmIncidentForReceiver(receiverUid) {
    const prefix = `${String(receiverUid || "").trim()}|`;

    if (prefix === "|") {
      return false;
    }

    for (const [key, value] of localActiveAlarmIncidentMap.entries()) {
      if (
        key.startsWith(prefix) &&
        value?.incident?.status === "active"
      ) {
        return true;
      }
    }

    return false;
  }

  function removeLocalActiveAlarmIncident(
    receiverUid,
    targetKey,
  ) {
    const cleanTargetKey = String(
      targetKey || "",
    ).trim();

    if (!receiverUid || !cleanTargetKey) {
      return;
    }

    localActiveAlarmIncidentMap.delete(
      getLocalActiveAlarmIncidentKey(
        receiverUid,
        cleanTargetKey,
      ),
    );
  }

  function getAlarmIncidentExpireDelayMs(flowType, items) {
    const normalizedFlowType = String(flowType || "").trim();
    const normalizedItems = normalizeAlarmIncidentItems(items);

    if (
      normalizedFlowType === "emergency" &&
      normalizedItems.length > 0 &&
      !normalizedItems.some(isPersistentEmergencyIncidentItem)
    ) {
      return transientTtlMs;
    }

    return autoExpireMs;
  }

  return {
    getAlarmIncidentTargetKey,
    getAlarmIncidentTimerKey,
    getLocalActiveAlarmIncidentKey,
    setLocalActiveAlarmIncident,
    hasLocalActiveAlarmIncidentForReceiver,
    removeLocalActiveAlarmIncident,
    getAlarmStagePriority,
    getAlarmStageRetryKey,
    getAlarmIncidentItemIdentity,
    normalizeAlarmIncidentItems,
    getSecurityAlarmSourcePriority,
    getSecurityAlarmConditionIdentity,
    normalizePreferredSecurityIncidentItems,
    filterCurrentSecurityAlarmDeliveryItems,
    getAlarmIncidentFlowType,
    getEmergencyIncidentTitle,
    getAlarmIncidentLines,
    haveAlarmIncidentItemsChanged,
    getAlarmIncidentRuntimePreferences,
    isPersistentEmergencyIncidentItem,
    getAlarmIncidentExpireDelayMs,
    getSecurityIncidentStageRank,
    incidentRequiresPhysicalSiren,
    isSecurityDeviceType,
    isEmergencyDeviceType,
  };
}

module.exports = {
  createAlarmIncidentDomain,
  getAlarmIncidentTargetKey,
  getAlarmIncidentTimerKey,
  getLocalActiveAlarmIncidentKey,
  getAlarmStagePriority,
  getAlarmStageRetryKey,
  getAlarmIncidentItemIdentity,
  normalizeAlarmIncidentItems,
  getSecurityAlarmSourcePriority,
  getSecurityAlarmConditionIdentity,
  normalizePreferredSecurityIncidentItems,
  filterCurrentSecurityAlarmDeliveryItems,
  getAlarmIncidentFlowType,
  getEmergencyIncidentTitle,
  getAlarmIncidentLines,
  haveAlarmIncidentItemsChanged,
  getAlarmIncidentRuntimePreferences,
  isPersistentEmergencyIncidentItem,
  getSecurityIncidentStageRank,
  incidentRequiresPhysicalSiren,
  isSecurityDeviceType,
  isEmergencyDeviceType,
};
