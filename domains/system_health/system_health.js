"use strict";

const {
  createHomeStatusAggregation,
} = require("../home/home_status_aggregation");

const SYSTEM_HEALTH_CHECK_INTERVAL_MS = 60 * 1000;
const SYSTEM_HEALTH_HUB_TIMEOUT_MS = 180 * 1000;
const SYSTEM_HEALTH_HUB_STARTUP_GRACE_MS = 90 * 1000;
const SYSTEM_HEALTH_NO_DATA_GRACE_MS = 10 * 60 * 1000;

function createSystemHealthDomain({
  db,
  getFirebaseConnected,
  getAccountsEntries,
  addHomeNotificationToHomeRecipients,
  normalizeLockState,
  isActiveSignal,
  isSecurityDeviceType,
  isEmergencyDeviceType,
  homeStatusAggregation: injectedHomeStatusAggregation = null,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = (...args) => console.log(...args),
  startedAt = now(),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("createSystemHealthDomain requires Firebase db");
  }

  if (typeof getFirebaseConnected !== "function") {
    throw new TypeError(
      "createSystemHealthDomain requires getFirebaseConnected",
    );
  }

  if (typeof getAccountsEntries !== "function") {
    throw new TypeError(
      "createSystemHealthDomain requires getAccountsEntries",
    );
  }

  if (typeof addHomeNotificationToHomeRecipients !== "function") {
    throw new TypeError(
      "createSystemHealthDomain requires addHomeNotificationToHomeRecipients",
    );
  }

  const homeStatusAggregation =
    injectedHomeStatusAggregation ||
    createHomeStatusAggregation({
      normalizeLockState,
      isActiveSignal,
      isSecurityDeviceType,
      isEmergencyDeviceType,
      now,
      startedAt,
    });

  for (const methodName of [
    "getHeartbeatLimitMs",
    "parseSystemHealthTimestamp",
    "isSystemHealthExplicitlyOffline",
    "isSystemHealthExplicitlyOnline",
    "evaluateDeviceSystemHealth",
    "evaluateHomeSystemHealth",
    "getHomeNotificationSafety",
  ]) {
    if (typeof homeStatusAggregation[methodName] !== "function") {
      throw new TypeError(
        `createSystemHealthDomain requires homeStatusAggregation.${methodName}`,
      );
    }
  }

  const {
    getHeartbeatLimitMs,
    parseSystemHealthTimestamp,
    isSystemHealthExplicitlyOffline,
    isSystemHealthExplicitlyOnline,
    evaluateDeviceSystemHealth,
    evaluateHomeSystemHealth,
    getHomeNotificationSafety,
  } = homeStatusAggregation;

  const systemHealthRuntimeSignatureMap = new Map();
  let systemHealthMonitorTimer = null;
  let systemHealthCheckInProgress = false;

  function getSystemHealthRuntimeKey(ownerUid, homeId) {
    return `${ownerUid}|${homeId}`;
  }

  function normalizeSystemHealthIssues(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value && typeof value === "object") {
      return Object.values(value).filter(Boolean);
    }
    return [];
  }

  function getSystemHealthIssueIdentity(issue) {
    return `${String(issue?.code || "")}|${String(issue?.entityId || "")}`;
  }

  function shouldEmitSystemHealthRecovery(
    issue,
    home,
    health,
    currentTime = now(),
  ) {
    const code = String(issue?.code || "");

    if (code === "device_offline" || code === "device_low_battery") {
      const deviceId = String(
        issue?.deviceId || issue?.entityId || "",
      ).trim();
      const devices = home?.devices || {};

      // Thiết bị bị xoá khỏi nhà không phải là một lần "online trở lại"
      // hoặc "pin đã ổn định".
      if (
        deviceId.length === 0 ||
        !Object.prototype.hasOwnProperty.call(devices, deviceId)
      ) {
        return false;
      }

      const device = devices[deviceId] || {};

      if (code === "device_offline") {
        const lastSeen = parseSystemHealthTimestamp(device.last_seen);
        const deviceType = String(device.type || "unknown")
          .trim()
          .toLowerCase();
        const hasFreshHeartbeat =
          lastSeen > 0 &&
          currentTime - lastSeen <= getHeartbeatLimitMs(deviceType) * 1.3;

        // Sau khi backend khởi động lại, khoảng grace không được tự biến
        // trạng thái chưa xác định thành "online trở lại".
        return isSystemHealthExplicitlyOnline(device.availability) ||
          hasFreshHeartbeat;
      }

      const batteryValue = Number(device.battery);
      return device.battery_low === false ||
        (
          Number.isFinite(batteryValue) &&
          batteryValue > 20
        );
    }

    if (code === "hub_offline" || code === "mqtt_offline") {
      const currentHubId = String(home?.hubId || "").trim();
      const issueHubId = String(
        issue?.hubId || issue?.entityId || "",
      ).trim();
      const heartbeatAt = parseSystemHealthTimestamp(
        home?.hubStatus?.lastHeartbeatAt,
      );
      const hasFreshHeartbeat =
        heartbeatAt > 0 &&
        currentTime - heartbeatAt <= SYSTEM_HEALTH_HUB_TIMEOUT_MS;

      // Không báo phục hồi khi Hub chỉ bị gỡ, được thay bằng Hub khác,
      // hoặc backend đang ở startup grace nhưng chưa nhận heartbeat mới.
      if (
        health?.hubTracked !== true ||
        currentHubId.length === 0 ||
        issueHubId !== currentHubId ||
        !hasFreshHeartbeat
      ) {
        return false;
      }

      return code === "mqtt_offline"
        ? home?.hubStatus?.mqttConnected === true
        : health?.hubOnline === true;
    }

    return true;
  }

  function buildSystemHealthNotification(issue, recovered) {
    const code = String(issue?.code || "");
    const deviceName = String(
      issue?.deviceName || issue?.entityId || "Thiết bị",
    ).trim() || "Thiết bị";

    if (code === "hub_offline") {
      return {
        type: recovered ? "system_hub_online" : "system_hub_offline",
        category: "home",
        severity: recovered ? "success" : "warning",
        title: recovered ? "Hub đã kết nối trở lại" : "Hub mất kết nối",
        message: recovered ? "Hub đã kết nối trở lại" : "Hub mất kết nối",
        entityType: "home",
        entityId: String(issue?.hubId || issue?.entityId || ""),
        data: { issueCode: code, recovered },
      };
    }

    if (code === "mqtt_offline") {
      return {
        type: recovered ? "system_mqtt_online" : "system_mqtt_offline",
        category: "home",
        severity: recovered ? "success" : "warning",
        title: recovered ? "MQTT đã kết nối trở lại" : "MQTT mất kết nối",
        message: recovered ? "MQTT đã kết nối trở lại" : "MQTT mất kết nối",
        entityType: "home",
        entityId: String(issue?.hubId || issue?.entityId || ""),
        data: { issueCode: code, recovered },
      };
    }

    if (code === "device_offline") {
      return {
        type: recovered ? "system_device_online" : "system_device_offline",
        category: "device",
        severity: recovered ? "success" : "warning",
        title: recovered ? "Thiết bị online" : "Thiết bị offline",
        message: `${deviceName}: ${recovered ? "Thiết bị đang Online" : "Thiết bị đang Offline"}`,
        deviceId: String(issue?.deviceId || issue?.entityId || ""),
        entityType: "device",
        entityId: String(issue?.deviceId || issue?.entityId || ""),
        data: { issueCode: code, recovered, deviceName },
      };
    }

    if (code === "device_low_battery") {
      return {
        type: recovered
          ? "system_device_battery_ok"
          : "system_device_low_battery",
        category: "device",
        severity: recovered ? "success" : "warning",
        title: recovered ? "Pin thiết bị đã ổn định" : "Pin yếu",
        message: `${deviceName}: ${recovered ? "Bình thường" : "Pin yếu"}`,
        deviceId: String(issue?.deviceId || issue?.entityId || ""),
        entityType: "device",
        entityId: String(issue?.deviceId || issue?.entityId || ""),
        data: {
          issueCode: code,
          recovered,
          deviceName,
          battery: issue?.battery ?? null,
        },
      };
    }

    return null;
  }

  async function checkSystemHealth() {
    if (!getFirebaseConnected() || systemHealthCheckInProgress) {
      return;
    }

    systemHealthCheckInProgress = true;

    try {
      const currentTime = now();
      const updates = {};
      const healthNotifications = [];
      let changedHomes = 0;
      let expiredEmergencyHolds = 0;

      for (const [ownerUid, account] of getAccountsEntries()) {
        const homes = account?.homes || {};

        for (const [homeId, rawHome] of Object.entries(homes)) {
          const home = rawHome || {};
          const devices = home.devices || {};

          // Dự phòng sau khi backend khởi động lại: timer runtime có thể mất,
          // nên monitor 60 giây sẽ dọn mọi mốc Nguy hiểm đã hết hạn.
          for (const [deviceId, device] of Object.entries(devices)) {
            const activeUntil = Number(
              device?.emergency_active_until || 0,
            );

            if (activeUntil <= 0 || activeUntil > currentTime) {
              continue;
            }

            const deviceBasePath =
              `accounts/${ownerUid}/homes/${homeId}/devices/${deviceId}`;
            updates[`${deviceBasePath}/emergency_active_until`] = null;

            if (String(device?.type || "").trim() === "sos") {
              updates[`${deviceBasePath}/sos_active_until`] = null;
            }

            expiredEmergencyHolds++;
          }

          const health = evaluateHomeSystemHealth(home, currentTime);
          const runtimeKey = getSystemHealthRuntimeKey(ownerUid, homeId);
          const signature = [
            health.status,
            health.protectionComplete ? "complete" : "incomplete",
            health.issueSignature,
          ].join("|");
          const current =
            home.systemHealth && typeof home.systemHealth === "object"
              ? home.systemHealth
              : {};
          const currentSignature = [
            String(current.status || ""),
            current.protectionComplete === true
              ? "complete"
              : "incomplete",
            String(current.issueSignature || ""),
          ].join("|");

          if (
            systemHealthRuntimeSignatureMap.get(runtimeKey) === signature ||
            currentSignature === signature
          ) {
            systemHealthRuntimeSignatureMap.set(runtimeKey, signature);
            continue;
          }

          systemHealthRuntimeSignatureMap.set(runtimeKey, signature);

          // Không tạo một loạt cảnh báo ở lần đánh giá đầu tiên sau khi cài đặt
          // hoặc nâng cấp. Chỉ thông báo các chuyển trạng thái thật sự về sau.
          if (Number(current.evaluatedAt || 0) > 0) {
            const previousIssues = normalizeSystemHealthIssues(current.issues);
            const nextIssues = normalizeSystemHealthIssues(health.issues);
            const previousByKey = new Map(
              previousIssues.map((issue) => [
                getSystemHealthIssueIdentity(issue),
                issue,
              ]),
            );
            const nextByKey = new Map(
              nextIssues.map((issue) => [
                getSystemHealthIssueIdentity(issue),
                issue,
              ]),
            );

            for (const [issueKey, issue] of nextByKey.entries()) {
              if (!previousByKey.has(issueKey)) {
                const notification = buildSystemHealthNotification(
                  issue,
                  false,
                );
                if (notification) {
                  healthNotifications.push({
                    ownerUid,
                    homeId,
                    homeName: String(home.name || homeId).trim() || homeId,
                    notification,
                  });
                }
              }
            }

            for (const [issueKey, issue] of previousByKey.entries()) {
              if (
                !nextByKey.has(issueKey) &&
                shouldEmitSystemHealthRecovery(
                  issue,
                  home,
                  health,
                  currentTime,
                )
              ) {
                const notification = buildSystemHealthNotification(
                  issue,
                  true,
                );
                if (notification) {
                  healthNotifications.push({
                    ownerUid,
                    homeId,
                    homeName: String(home.name || homeId).trim() || homeId,
                    notification,
                  });
                }
              }
            }
          }

          updates[
            `accounts/${ownerUid}/homes/${homeId}/systemHealth`
          ] = {
            ...health,
            evaluatedAt: currentTime,
          };
          changedHomes++;
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);

        for (const item of healthNotifications) {
          const notification = item.notification;
          await addHomeNotificationToHomeRecipients({
            ownerUid: item.ownerUid,
            homeId: item.homeId,
            homeName: item.homeName,
            ...notification,
            dedupeKey:
              `${notification.type}|${notification.entityId || item.homeId}`,
            dedupeMs: 30 * 1000,
          });
        }

        log(
          "🩺 SYSTEM HEALTH UPDATED:",
          `homes=${changedHomes}`,
          `notifications=${healthNotifications.length}`,
          `expiredEmergencyHolds=${expiredEmergencyHolds}`,
        );
      }
    } catch (error) {
      log("SYSTEM HEALTH CHECK ERROR:", error.message);
    } finally {
      systemHealthCheckInProgress = false;
    }
  }

  function startSystemHealthMonitor() {
    if (systemHealthMonitorTimer) {
      return;
    }

    void checkSystemHealth();

    systemHealthMonitorTimer = setIntervalFn(() => {
      void checkSystemHealth();
    }, SYSTEM_HEALTH_CHECK_INTERVAL_MS);

    log(
      "🩺 SYSTEM HEALTH MONITOR STARTED:",
      `interval=${SYSTEM_HEALTH_CHECK_INTERVAL_MS / 1000}s`,
    );
  }

  function stopSystemHealthMonitor() {
    if (!systemHealthMonitorTimer) {
      return;
    }

    clearIntervalFn(systemHealthMonitorTimer);
    systemHealthMonitorTimer = null;
  }

  return {
    getHeartbeatLimitMs,
    parseSystemHealthTimestamp,
    isSystemHealthExplicitlyOffline,
    isSystemHealthExplicitlyOnline,
    evaluateDeviceSystemHealth,
    evaluateHomeSystemHealth,
    getHomeNotificationSafety,
    shouldEmitSystemHealthRecovery,
    buildSystemHealthNotification,
    checkSystemHealth,
    startSystemHealthMonitor,
    stopSystemHealthMonitor,
  };
}

module.exports = {
  createSystemHealthDomain,
};
