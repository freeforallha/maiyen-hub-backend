"use strict";

const SYSTEM_HEALTH_HUB_TIMEOUT_MS = 180 * 1000;
const SYSTEM_HEALTH_HUB_STARTUP_GRACE_MS = 90 * 1000;
const SYSTEM_HEALTH_NO_DATA_GRACE_MS = 10 * 60 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function runtimeSignature(runtime) {
  const value = asObject(runtime);

  return JSON.stringify({
    status: String(value.status || ""),
    totalMemberCount: Number(value.totalMemberCount || 0),
    participantCount: Number(value.participantCount || 0),
    memberCount: Number(value.memberCount || 0),
    eligibleMemberCount: Number(value.eligibleMemberCount || 0),
    excludedCount: Number(value.excludedCount || 0),
    insideCount: Number(value.insideCount || 0),
    outsideCount: Number(value.outsideCount || 0),
    unknownCount: Number(value.unknownCount || 0),
    knownLocationCount: Number(value.knownLocationCount || 0),
    armingInsideCount: Number(value.armingInsideCount || 0),
    armingOutsideCount: Number(value.armingOutsideCount || 0),
    armingUnknownCount: Number(value.armingUnknownCount || 0),
    allOutsideSince: Number(value.allOutsideSince || 0),
    insideCandidateSince: Number(value.insideCandidateSince || 0),
    rearmBlockedUntil: Number(value.rearmBlockedUntil || 0),
    cycleArmed: value.cycleArmed === true,
    manualNormalSnoozeUntil: Number(
      value.manualNormalSnoozeUntil || 0,
    ),
    insideOverrideUid: String(value.insideOverrideUid || ""),
    insideOverrideAt: Number(value.insideOverrideAt || 0),
  });
}

function buildAutoAwayRuntime({
  status,
  totalMemberCount,
  participantCount = 0,
  memberCount,
  eligibleMemberCount,
  excludedCount,
  insideCount,
  outsideCount,
  unknownCount,
  knownLocationCount,
  armingInsideCount,
  armingOutsideCount,
  armingUnknownCount,
  allOutsideSince,
  insideCandidateSince = 0,
  rearmBlockedUntil = 0,
  cycleArmed,
  manualNormalSnoozeUntil = 0,
  insideOverrideUid = "",
  insideOverrideAt = 0,
  now,
}) {
  const safeInsideCount = Number(insideCount || 0);
  const safeOutsideCount = Number(outsideCount || 0);
  const safeUnknownCount = Number(unknownCount || 0);
  const safeEligibleMemberCount = Number(
    eligibleMemberCount ?? memberCount ?? 0,
  );
  const safeKnownLocationCount = Number(
    knownLocationCount ?? safeInsideCount + safeOutsideCount,
  );

  return {
    status,
    totalMemberCount,
    participantCount: Number(participantCount || 0),
    // memberCount giữ vai trò mẫu số hiển thị cũ.
    // Luôn dùng tổng thành viên thật để tránh UI hiện 2/2
    // khi thực tế là 2/3 và 1/3 chưa rõ vị trí.
    memberCount,
    eligibleMemberCount: safeEligibleMemberCount,
    excludedCount,
    insideCount: safeInsideCount,
    outsideCount: safeOutsideCount,
    unknownCount: safeUnknownCount,
    knownLocationCount: safeKnownLocationCount,
    armingInsideCount: Number(
      armingInsideCount ?? safeInsideCount,
    ),
    armingOutsideCount: Number(
      armingOutsideCount ?? safeOutsideCount,
    ),
    armingUnknownCount: Number(
      armingUnknownCount ?? Math.max(
        0,
        safeEligibleMemberCount -
          Number(armingInsideCount ?? safeInsideCount) -
          Number(armingOutsideCount ?? safeOutsideCount),
      ),
    ),
    allOutsideSince: allOutsideSince || null,
    insideCandidateSince: Number(insideCandidateSince || 0) || null,
    rearmBlockedUntil: Number(rearmBlockedUntil || 0) || null,
    cycleArmed: cycleArmed === true,
    manualNormalSnoozeUntil:
      Number(manualNormalSnoozeUntil || 0) || null,
    insideOverrideUid:
      String(insideOverrideUid || "").trim() || null,
    insideOverrideAt: Number(insideOverrideAt || 0) || null,
    updatedAt: now,
  };
}

function presenceSummarySignature(summary) {
  const value = asObject(summary);

  return JSON.stringify({
    totalMemberCount: Number(value.totalMemberCount || 0),
    participantCount: Number(value.participantCount || 0),
    participantInsideCount: Number(value.participantInsideCount || 0),
    participantOutsideCount: Number(value.participantOutsideCount || 0),
    participantUnknownCount: Number(value.participantUnknownCount || 0),
    signedInCount: Number(value.signedInCount || 0),
    onlineCount: Number(value.onlineCount || 0),
    connectedCount: Number(value.connectedCount || 0),
    memberCount: Number(value.memberCount || 0),
    eligibleMemberCount: Number(value.eligibleMemberCount || 0),
    excludedCount: Number(value.excludedCount || 0),
    insideCount: Number(value.insideCount || 0),
    outsideCount: Number(value.outsideCount || 0),
    unknownCount: Number(value.unknownCount || 0),
    knownLocationCount: Number(value.knownLocationCount || 0),
    armingInsideCount: Number(value.armingInsideCount || 0),
    armingOutsideCount: Number(value.armingOutsideCount || 0),
    armingUnknownCount: Number(value.armingUnknownCount || 0),
    unavailableCount: Number(value.unavailableCount || 0),
  });
}

function buildPresenceSummary({
  totalMemberCount,
  participantCount = 0,
  participantInsideCount = 0,
  participantOutsideCount = 0,
  participantUnknownCount = 0,
  signedInCount,
  onlineCount,
  connectedCount,
  memberCount,
  eligibleMemberCount,
  excludedCount,
  insideCount,
  outsideCount,
  unknownCount,
  knownLocationCount,
  armingInsideCount,
  armingOutsideCount,
  armingUnknownCount,
  unavailableCount,
  now,
}) {
  return {
    totalMemberCount,
    participantCount: Number(participantCount || 0),
    participantInsideCount: Number(participantInsideCount || 0),
    participantOutsideCount: Number(participantOutsideCount || 0),
    participantUnknownCount: Number(participantUnknownCount || 0),
    signedInCount,
    onlineCount,
    connectedCount,
    // memberCount giữ tương thích cho UI cũ, nhưng phải là
    // tổng thành viên thật, không phải số người eligible.
    memberCount,
    eligibleMemberCount,
    excludedCount,
    insideCount,
    outsideCount,
    unknownCount,
    knownLocationCount,
    armingInsideCount,
    armingOutsideCount,
    armingUnknownCount,
    unavailableCount,
    updatedAt: now,
  };
}

function createHomeStatusAggregation({
  normalizeLockState,
  isActiveSignal,
  isSecurityDeviceType,
  isEmergencyDeviceType,
  now = () => Date.now(),
  startedAt = now(),
} = {}) {
  for (const [name, dependency] of Object.entries({
    normalizeLockState,
    isActiveSignal,
    isSecurityDeviceType,
    isEmergencyDeviceType,
  })) {
    if (typeof dependency !== "function") {
      throw new TypeError(
        `createHomeStatusAggregation requires ${name}`,
      );
    }
  }

  function getHeartbeatLimitMs(type) {
    if (type === "temperature") return 2 * 60 * 60 * 1000;
    if (type === "repeater") return 1 * 60 * 60 * 1000;
    if (type === "siren") return 1 * 60 * 60 * 1000;
    if (type === "smoke") return 24 * 60 * 60 * 1000;
    if (type === "sos") return 6 * 60 * 60 * 1000;

    return 6 * 60 * 60 * 1000;
  }

  function parseSystemHealthTimestamp(value) {
    if (value === null || value === undefined || value === "") {
      return 0;
    }

    const numeric = Number(value);

    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function normalizeSystemHealthAvailability(value) {
    const raw = value && typeof value === "object"
      ? value.state ?? value.status ?? value.value
      : value;

    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function isSystemHealthExplicitlyOffline(value) {
    const availability = normalizeSystemHealthAvailability(value);

    return (
      availability === "offline" ||
      availability === "unavailable" ||
      availability === "disconnected" ||
      availability === "not_available"
    );
  }

  function isSystemHealthExplicitlyOnline(value) {
    const availability = normalizeSystemHealthAvailability(value);

    return (
      availability === "online" ||
      availability === "available" ||
      availability === "connected"
    );
  }

  function isProtectionRelevantDeviceType(type) {
    return (
      isSecurityDeviceType(type) ||
      isEmergencyDeviceType(type) ||
      type === "siren" ||
      type === "repeater" ||
      type === "ups"
    );
  }

  function evaluateDeviceSystemHealth(
    deviceId,
    rawDevice,
    currentTime = now(),
  ) {
    const device = rawDevice || {};
    const type = String(device.type || "unknown")
      .trim()
      .toLowerCase();
    const deviceName = String(device.name || deviceId).trim() || deviceId;
    const issues = [];
    const availability = device.availability;
    const lastSeen = parseSystemHealthTimestamp(device.last_seen);
    const heartbeatLimitMs = getHeartbeatLimitMs(type);

    // last_seen là nguồn chính cho thiết bị pin. Zigbee2MQTT có thể đánh dấu
    // availability=offline sớm hơn ngưỡng heartbeat riêng của MaiYen.
    let offline = false;

    if (lastSeen > 0) {
      offline = currentTime - lastSeen > heartbeatLimitMs * 1.3;
    } else if (isSystemHealthExplicitlyOffline(availability)) {
      offline = true;
    } else if (
      !isSystemHealthExplicitlyOnline(availability) &&
      currentTime - startedAt >= SYSTEM_HEALTH_NO_DATA_GRACE_MS
    ) {
      offline = true;
    }

    if (offline) {
      issues.push({
        code: "device_offline",
        level: "warning",
        entityType: "device",
        entityId: deviceId,
        deviceId,
        deviceName,
        deviceType: type,
        message: `${deviceName}: mất kết nối`,
        protectionRelevant: isProtectionRelevantDeviceType(type),
      });
    }

    const batteryValue = Number(device.battery);
    const batteryLow = device.battery_low === true || (
      Number.isFinite(batteryValue) &&
      batteryValue >= 0 &&
      batteryValue <= 20
    );

    if (batteryLow) {
      issues.push({
        code: "device_low_battery",
        level: "warning",
        entityType: "device",
        entityId: deviceId,
        deviceId,
        deviceName,
        deviceType: type,
        battery: Number.isFinite(batteryValue) ? batteryValue : null,
        message: `${deviceName}: pin yếu`,
        protectionRelevant: isProtectionRelevantDeviceType(type),
      });
    }

    return issues;
  }

  function evaluateHomeSystemHealth(rawHome, currentTime = now()) {
    const home = rawHome || {};
    const issues = [];
    const hubId = String(home.hubId || "").trim();
    const hubStatus = home.hubStatus && typeof home.hubStatus === "object"
      ? home.hubStatus
      : {};
    const hubHeartbeatAt = parseSystemHealthTimestamp(
      hubStatus.lastHeartbeatAt,
    );

    const hubTracked = hubId.length > 0;
    let hubOnline = true;
    let mqttOnline = true;

    if (hubTracked) {
      const inStartupGrace =
        currentTime - startedAt < SYSTEM_HEALTH_HUB_STARTUP_GRACE_MS;
      const heartbeatMissingOrStale =
        hubHeartbeatAt <= 0 ||
        currentTime - hubHeartbeatAt > SYSTEM_HEALTH_HUB_TIMEOUT_MS;

      if (!inStartupGrace && heartbeatMissingOrStale) {
        hubOnline = false;
        mqttOnline = false;
        issues.push({
          code: "hub_offline",
          level: "warning",
          entityType: "hub",
          entityId: hubId,
          hubId,
          message: "Hub mất kết nối",
          protectionRelevant: true,
        });
      } else if (
        !heartbeatMissingOrStale &&
        hubStatus.mqttConnected === false
      ) {
        mqttOnline = false;
        issues.push({
          code: "mqtt_offline",
          level: "warning",
          entityType: "hub",
          entityId: hubId,
          hubId,
          message: "MQTT mất kết nối",
          protectionRelevant: true,
        });
      }
    }

    const devices = home.devices && typeof home.devices === "object"
      ? home.devices
      : {};

    for (const [deviceId, device] of Object.entries(devices)) {
      issues.push(
        ...evaluateDeviceSystemHealth(deviceId, device, currentTime),
      );
    }

    issues.sort((first, second) => {
      return `${first.code}|${first.entityId}`.localeCompare(
        `${second.code}|${second.entityId}`,
      );
    });

    const protectionComplete = !issues.some(
      (issue) => issue.protectionRelevant === true,
    );
    const issueSignature = issues
      .map((issue) => `${issue.code}:${issue.entityId}`)
      .join("|");
    const status = issues.length > 0 ? "warning" : "ok";

    return {
      status,
      eventCategory: "system_warning",
      alarmLevel: status === "warning" ? "warning" : "info",
      protectionComplete,
      warningCount: issues.length,
      hubTracked,
      hubOnline,
      mqttOnline,
      issues,
      issueSignature,
    };
  }

  function getHomeNotificationSafety(home) {
    const devices = home?.devices || {};
    const unsafeDevices = [];
    const dangerIssues = [];
    const systemWarnings = [];
    const systemHealth = evaluateHomeSystemHealth(home);

    for (const issue of systemHealth.issues) {
      if (issue.message) {
        systemWarnings.push(issue.message);
      }
    }

    for (const [deviceId, device] of Object.entries(devices)) {
      const name = device.name || deviceId;
      const type = device.type || "door";
      const issues = [];

      if (type === "door" || type === "window" || type === "gate") {
        if (device.contact === false) issues.push("đang mở");
        if (device.tamper === true) issues.push("bị tháo");
      }

      if (type === "door_lock" || type === "lock") {
        if (normalizeLockState(device) === "unlocked") {
          issues.push("khóa đang mở");
        }
        if (device.tamper === true) issues.push("bị tháo");
      }

      if (type === "smoke") {
        if (device.smoke === true) issues.push("phát hiện khói");
        if (device.tamper === true) issues.push("bị tháo");
      }

      if (type === "carbon_monoxide") {
        if (
          isActiveSignal(device.carbon_monoxide) ||
          isActiveSignal(device.co_alarm)
        ) {
          issues.push("phát hiện khí CO");
        }
      }

      if (type === "gas") {
        if (
          isActiveSignal(device.gas) ||
          isActiveSignal(device.gas_alarm)
        ) {
          issues.push("rò rỉ gas");
        }
      }

      if (type === "water_leak" || type === "flood") {
        if (
          isActiveSignal(device.water_leak) ||
          isActiveSignal(device.leak) ||
          isActiveSignal(device.water)
        ) {
          issues.push("phát hiện ngập nước");
        }
      }

      if (type === "sos") {
        const lastTriggered = Number(device.last_triggered || 0);
        const isRecentlyTriggered =
          lastTriggered > 0 && now() - lastTriggered < 60 * 1000;

        if (isRecentlyTriggered) issues.push("đã kích hoạt SOS");
      }

      if (issues.length > 0) {
        const detail = `${name}: ${issues.join(", ")}`;
        dangerIssues.push(detail);
        unsafeDevices.push(detail);
      }
    }

    for (const warning of systemWarnings) {
      if (!unsafeDevices.includes(warning)) {
        unsafeDevices.push(warning);
      }
    }

    return {
      safe: dangerIssues.length === 0 && systemWarnings.length === 0,
      protectionComplete: systemHealth.protectionComplete,
      dangerIssues,
      systemWarnings,
      unsafeDevices,
    };
  }

  return {
    getHeartbeatLimitMs,
    parseSystemHealthTimestamp,
    isSystemHealthExplicitlyOffline,
    isSystemHealthExplicitlyOnline,
    evaluateDeviceSystemHealth,
    evaluateHomeSystemHealth,
    getHomeNotificationSafety,
  };
}

module.exports = {
  createHomeStatusAggregation,
  runtimeSignature,
  buildAutoAwayRuntime,
  presenceSummarySignature,
  buildPresenceSummary,
};
