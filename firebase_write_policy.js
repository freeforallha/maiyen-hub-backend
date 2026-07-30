"use strict";

const DEVICE_TELEMETRY_FIELDS = new Set([
  "last_seen",
  "linkquality",
  "battery",
  "battpercentage",
  "temperature",
  "humidity",
  "power",
  "current",
  "voltage",
  "energy",
  "consumption",
  "device_temperature",
  "vibration_strength",
  "angle",
  "x_axis",
  "y_axis",
  "z_axis",
  "last_siren_report_at",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function valuesEqual(left, right) {
  if (Number.isNaN(left) && Number.isNaN(right)) {
    return true;
  }

  return left === right;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function buildDeviceFirebaseUpdate({
  candidateUpdate,
  currentDevice,
  persistedTelemetry,
  now,
  lastTelemetryPersistAt = 0,
  telemetryIntervalMs = 60 * 1000,
}) {
  const candidate = asObject(candidateUpdate);
  const current = asObject(currentDevice);
  const persisted = asObject(persistedTelemetry);
  const immediate = {};
  const pendingTelemetry = {};

  for (const [field, value] of Object.entries(candidate)) {
    if (field === "updated_at") {
      continue;
    }

    if (DEVICE_TELEMETRY_FIELDS.has(field)) {
      const previousValue = hasOwn(persisted, field)
        ? persisted[field]
        : current[field];

      if (!valuesEqual(previousValue, value)) {
        pendingTelemetry[field] = value;
      }

      continue;
    }

    if (!valuesEqual(current[field], value)) {
      immediate[field] = value;
    }
  }

  const hasImmediateChange = Object.keys(immediate).length > 0;
  const telemetryDue =
    Number(lastTelemetryPersistAt || 0) <= 0 ||
    Number(now || 0) - Number(lastTelemetryPersistAt || 0) >=
      Math.max(1000, Number(telemetryIntervalMs || 0));

  const result = { ...immediate };

  // Khi đã phải ghi một thay đổi quan trọng, mang theo telemetry mới nhất
  // trong cùng một update. Nếu không có thay đổi quan trọng, telemetry chỉ
  // được ghi khi đến chu kỳ giới hạn.
  if (hasImmediateChange || telemetryDue) {
    Object.assign(result, pendingTelemetry);
  }

  if (Object.keys(result).length > 0) {
    result.updated_at = Number(now || Date.now());
  }

  return result;
}

function updatePersistedTelemetrySnapshot(
  previousSnapshot,
  firebaseUpdate,
) {
  const next = {
    ...asObject(previousSnapshot),
  };

  for (const field of DEVICE_TELEMETRY_FIELDS) {
    if (hasOwn(asObject(firebaseUpdate), field)) {
      next[field] = firebaseUpdate[field];
    }
  }

  return next;
}

function firebaseUpdateContainsTelemetry(firebaseUpdate) {
  const update = asObject(firebaseUpdate);

  for (const field of DEVICE_TELEMETRY_FIELDS) {
    if (hasOwn(update, field)) {
      return true;
    }
  }

  return false;
}

function memberPresenceStatusSignature(statusMap) {
  const normalized = {};

  for (const memberUid of Object.keys(asObject(statusMap)).sort()) {
    const value = asObject(statusMap[memberUid]);

    normalized[memberUid] = {
      online: value.online === true,
      connected: value.connected === true,
      autoAwayParticipant:
        value.autoAwayParticipant === true,
      state: String(value.state || "unknown"),
      locationKnown: value.locationKnown === true,
      monitoringEligible:
        value.monitoringEligible === true,
      monitoringAvailable:
        value.monitoringAvailable === true,
      monitoringWarnings: Array.isArray(
        value.monitoringWarnings,
      )
        ? [...value.monitoringWarnings].sort()
        : [],
      monitoringWarningReason: String(
        value.monitoringWarningReason || "",
      ),
      monitoringHealth: String(
        value.monitoringHealth || "",
      ),
      monitoringHealthReason: String(
        value.monitoringHealthReason || "",
      ),
      appState: String(value.appState || ""),
      reason: String(value.reason || ""),
    };
  }

  return JSON.stringify(normalized);
}

function presenceCleanupTargetSignature(reason) {
  return JSON.stringify({
    state: "unknown",
    event: String(reason || "session_stale"),
    monitoringEligible: false,
    monitoringAvailable: false,
    monitoringBlockingReason: String(
      reason || "session_stale",
    ),
  });
}

module.exports = {
  DEVICE_TELEMETRY_FIELDS,
  buildDeviceFirebaseUpdate,
  firebaseUpdateContainsTelemetry,
  memberPresenceStatusSignature,
  presenceCleanupTargetSignature,
  updatePersistedTelemetrySnapshot,
};
