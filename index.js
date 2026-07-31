// 🔥 CORE
const mqtt = require("mqtt");
const admin = require("firebase-admin");
const os = require("os");
const { execFileSync } = require("child_process");
const {
  normalizeLanguageCode,
  localizeBackendText,
  localizeAlarmItemsJson,
} = require("./backend_localizations");
const {
  SYSTEM_VERSION,
  getSystemVersionHeartbeatFields,
} = require("./system_version");
const {
  createHubUpdateBridge,
} = require("./hub_update_bridge");
const {
  createHubUpdatePushCoordinator,
} = require("./hub_update_push");
const {
  buildDeviceFirebaseUpdate,
  firebaseUpdateContainsTelemetry,
  updatePersistedTelemetrySnapshot,
} = require("./firebase_write_policy");
const { createHubIdentity } = require("./domains/hub/hub_identity");
const { createHubHeartbeat } = require("./domains/hub/hub_heartbeat");
const {
  createOrderedListCleanup,
} = require("./domains/shared/ordered_list_cleanup");
const {
  createFcmDeliveryDomain,
} = require("./domains/notifications/fcm_delivery");
const {
  createScheduledReminderDomain,
} = require("./domains/notifications/scheduled_reminder");
const {
  createHomeActivityDomain,
} = require("./domains/notifications/home_activity");
const {
  createHomeStatusAggregation,
} = require("./domains/home/home_status_aggregation");
const {
  createSystemHealthDomain,
} = require("./domains/system_health/system_health");
const {
  createAutoAwayDomain,
} = require("./domains/auto_away/auto_away");
const {
  createPresenceSessionCoordinator,
} = require("./domains/presence/presence_session");
const {
  createSecurityModeOrchestrationDomain,
} = require("./domains/security/security_mode_orchestration");
const {
  createLocalRuntimeDomain,
} = require("./domains/runtime/local_runtime");
const {
  isActiveSignal,
  isVibrationAction,
  isGlassBreakAction,
  normalizeLockState,
  inferDeviceTypeFromPayload,
  getDeviceTypeFromModel,
} = require("./domains/devices/device_profile");
const {
  createMqttDeviceIngestionDomain,
} = require("./domains/devices/mqtt_device_ingestion");
const {
  createDeviceManagementDomain,
} = require("./domains/devices/device_management");
const {
  toMin,
  isValidHHMM,
  isNowInRange,
  normalizeRepeatMinutes,
  normalizeAlarmDays,
  alarmInstanceOverlapsPause,
  normalizeDeviceAlarmScheduleCollection,
  normalizeSecurityModeRepeatMinutes,
  getActiveScheduleOccurrenceIdentity,
  resolveActiveDeviceSchedule,
  isScheduledAlarmSource,
} = require("./domains/alarm/alarm_schedule");
const {
  createAlarmIncidentDomain,
} = require("./domains/alarm/alarm_incident");
const {
  createAlarmIncidentLifecycle,
} = require("./domains/alarm/alarm_incident_lifecycle");
const {
  createAlarmIncidentPersistence,
} = require("./domains/alarm/alarm_incident_persistence");
const {
  createPhysicalSirenDomain,
} = require("./domains/alarm/physical_siren");
const {
  createSensorAlarmEngine,
  SENSOR_EVENT_CATEGORY,
  SENSOR_EVENT_SEVERITY,
  ALARM_INCIDENT_SCHEMA_VERSION,
  normalizeHomeSecurityMode,
  getStandardIncidentEventCategory,
  getStandardIncidentAlarmLevel,
  getLegacyIncidentSeverity,
  getIncidentResolutionType,
  buildStandardIncidentFields,
} = require("./domains/alarm/sensor_alarm_engine");

const lastNotificationMap = {};
const lastScheduleAlarmMap = {};
let scheduledAlarmConfigurationRefreshTimer = null;
const alarmPauseExpiryTimerMap = new Map();

// Firebase connection state remains at the composition root because several
// alarm and persistence flows need a fast synchronous connectivity guard.
// The extracted local runtime domain owns snapshots, queue persistence and
// connection-monitor timers, and updates this shared boolean through callbacks.
let firebaseConnected = false;
let securityModeOrchestrationDomain = null;

// Offline alarm demand state belongs to the Alarm domain. It remains in the
// composition root while snapshot and queue persistence are extracted.
const OFFLINE_TRANSIENT_ALARM_TTL_MS = 5 * 60 * 1000;
const offlineAlarmDemandMap = new Map();
const offlineAlarmExpiryTimerMap = new Map();

const vibrationStateClearTimerMap = new Map();
const sosStateClearTimerMap = new Map();
const emergencyStatusClearTimerMap = new Map();

// Physical siren command/reconcile state now lives in the extracted domain.
// The action-result TTL remains here because it belongs to request cleanup.
const HOME_SIREN_ACTION_RESULT_TTL_MS = 30 * 1000;
const VIBRATION_ACTIVE_WINDOW_MS = 15 * 1000;

const userDirectoryCache = {};
let chatUnreadMigrationPromise = null;

// ================= LIMITED TIMELINES =================
// Giới hạn lưu thực tế. UI vẫn chỉ tải số lượng cần hiển thị.
const HOME_NOTIFICATION_STORAGE_LIMIT = 120;
const DEVICE_NOTIFICATION_STORAGE_LIMIT = 100;
const HOME_EVENT_STORAGE_LIMIT = 200;

// ================= ALARM ESCALATION =================
// Notification, đánh thức màn hình và còi vật lý kích hoạt ngay khi sự kiện
// hợp lệ được xác nhận. Chỉ bước chuẩn bị gọi điện giữ thời gian riêng.
const ALARM_INCIDENT_CALL_DELAY_MS = 60 * 1000;
const EMERGENCY_CALL_DELAY_MS = 35 * 1000;

// ================= IOS ALARM PRESENTATION =================
// Time Sensitive hoạt động mà không cần entitlement đặc biệt. Critical Alerts
// chỉ được bật sau khi Apple phê duyệt entitlement và provisioning profile.
// Giữ mặc định false để backend hiện tại vẫn gửi được push cho iOS trước khi
// có tài khoản Apple Developer trả phí.
const IOS_TIME_SENSITIVE_ALERTS_ENABLED =
  (process.env.MAIYEN_IOS_TIME_SENSITIVE_ALERTS_ENABLED ||
    process.env.SAFEHOME_IOS_TIME_SENSITIVE_ALERTS_ENABLED) !== "false";
const IOS_CRITICAL_ALERTS_ENABLED =
  (process.env.MAIYEN_IOS_CRITICAL_ALERTS_ENABLED ||
    process.env.SAFEHOME_IOS_CRITICAL_ALERTS_ENABLED) === "true";

// Giữ trạng thái Nguy hiểm thêm 5 phút kể từ lần kích hoạt mới nhất.
// Người dùng có thể xác nhận sớm theo từng tài khoản ở phía app.
const EMERGENCY_STATUS_HOLD_MS = 5 * 60 * 1000;
// Chỉ gộp các packet khẩn cấp liên tiếp của cùng một lần kích hoạt.
// Sau khoảng này, lần SOS hoặc sự kiện khẩn cấp mới phải tạo incident mới
// để notification và các cấp sau chạy lại từ đầu.
const EMERGENCY_MERGE_WINDOW_MS = 10 * 1000;

// Khi rời Mode Không bảo vệ, chỉ các sự kiện Emergency tức thời xảy ra
// trong 60 giây gần nhất mới được xem xét phát lại. Trạng thái nguy hiểm
// liên tục như khói/CO/gas vẫn được đánh giá theo trạng thái hiện tại.
const UNPROTECTED_TRANSIENT_REPLAY_WINDOW_MS = 60 * 1000;

function isHomeUnprotected(home) {
  if (securityModeOrchestrationDomain) {
    return securityModeOrchestrationDomain.isHomeUnprotected(home);
  }

  return normalizeHomeSecurityMode(home?.securityMode) === "unprotected";
}

const ALARM_INCIDENT_AUTO_EXPIRE_MS = 30 * 60 * 1000;

// Không polling dày. Watchdog chỉ chạy mỗi 60 giây và dùng cache
// để dọn incident bị bỏ sót khi listener hoặc backend vừa khởi động lại.
const ALARM_INCIDENT_WATCHDOG_INTERVAL_MS = 60 * 1000;

// Khi gửi push Alarm thất bại, không được đánh dấu đã sang cấp mới.
// Thử lại có giới hạn để tránh spam khi thiết bị không còn FCM token.
const ALARM_STAGE_RETRY_DELAY_MS = 15 * 1000;
const ALARM_STAGE_MAX_RETRY_COUNT = 4;

// Hub ghi heartbeat lên Firebase mỗi 60 giây.
// Backend và app chỉ coi Hub Offline khi quá 180 giây để chịu được
// một chu kỳ ghi chậm mà không tạo cảnh báo giả.
const HUB_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HUB_HEARTBEAT_STARTED_AT = Date.now();
let hubUpdateBridge = null;
let hubUpdatePushCoordinator = null;

function getHubUpdateHeartbeatFields() {
  if (!hubUpdateBridge) {
    return {
      updateAgentSchemaVersion: 1,
      updateAgentStatus: "not_started",
      updateAvailable: false,
    };
  }

  return hubUpdateBridge.getHeartbeatFields();
}

const alarmIncidentTimerMap = {};
const alarmIncidentAdvanceInProgress = new Set();
const alarmIncidentActionInProgress = new Set();
const homeSirenActionInProgress = new Set();
const alarmIncidentValidationPromiseMap = new Map();
const alarmIncidentStartPromiseMap = new Map();
const alarmIncidentQueuedStageMap = new Map();
const alarmIncidentStageRetryCountMap = new Map();
const localActiveAlarmIncidentMap = new Map();
const securityModeRepeatInProgress = new Set();

// ================= ALARM INCIDENT DOMAIN =================
// Identity, normalization, source precedence, delivery preferences and
// local active-incident indexing are pure domain concerns. Lifecycle timers,
// Firebase writes and push orchestration remain in this composition root.
const {
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
} = createAlarmIncidentDomain({
  localActiveAlarmIncidentMap,
  offlineTransientAlarmTtlMs: OFFLINE_TRANSIENT_ALARM_TTL_MS,
  alarmIncidentAutoExpireMs: ALARM_INCIDENT_AUTO_EXPIRE_MS,
});
let alarmIncidentWatchdogTimer = null;
const {
  deviceId: DEVICE_ID,
  hubName: HUB_NAME,
  hubModel: HUB_MODEL,
  readConnectedWifiInfo,
} = createHubIdentity();

console.log("🧠 DEVICE_ID:", DEVICE_ID);
console.log(
  "🏷️ MAIYEN SYSTEM VERSION:",
  `backend=${SYSTEM_VERSION.backendVersion}`,
  `firmware=${SYSTEM_VERSION.hubFirmwareVersion}`,
  `protocol=${SYSTEM_VERSION.protocolVersion}`,
);

// ================= FIREBASE =================
const serviceAccount = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/",
});

const db = admin.database();

const { queueOrderedListCleanup } = createOrderedListCleanup({
  batchSize: 20,
  maxPasses: 20,
  delayMs: 1500,
  logError: (cleanupKey, error) => {
    console.log(
      "ORDERED LIST CLEANUP ERROR:",
      cleanupKey,
      error.message,
    );
  },
});

let mqttConnected = false;

const {
  getHomesLinkedToThisHub,
  writeHubHeartbeat,
  startHubHeartbeat,
} = createHubHeartbeat({
  db,
  deviceId: DEVICE_ID,
  hubName: HUB_NAME,
  hubModel: HUB_MODEL,
  startedAt: HUB_HEARTBEAT_STARTED_AT,
  intervalMs: HUB_HEARTBEAT_INTERVAL_MS,
  readConnectedWifiInfo,
  getMqttConnected: () => mqttConnected,
  getSystemVersionHeartbeatFields,
  getHubUpdateHeartbeatFields,
  processId: process.pid,
  log: (...args) => console.log(...args),
});

// ================= MQTT =================
const client = mqtt.connect("mqtt://localhost:1883");

// ================= DEVICE PROFILE DOMAIN =================
// Pure sensor/action normalization and device classification live outside the
// composition root so pairing and MQTT processing share one tested mapping.

// ================= DEVICE MAP =================
let deviceMap = {};

// ================= TIME =================
function getCurrentHHMM() {
  const now = new Date();

  const hh = now.getHours().toString().padStart(2, "0");
  const mm = now.getMinutes().toString().padStart(2, "0");

  return `${hh}:${mm}`;
}

function getNextAlarmTimeText(repeatMinutes) {
  const minutes = parseInt(repeatMinutes || 0);

  if (minutes <= 0) {
    return "không lặp lại";
  }

  const next = new Date(Date.now() + minutes * 60 * 1000);
  const hh = next.getHours().toString().padStart(2, "0");
  const mm = next.getMinutes().toString().padStart(2, "0");

  return `${hh}:${mm}`;
}
function waitMs(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(durationMs) || 0));
  });
}

function getVibrationStateTimerKey(uid, homeId, deviceId) {
  return `${uid}|${homeId}|${deviceId}`;
}

function cancelVibrationStateClear(uid, homeId, deviceId) {
  const timerKey = getVibrationStateTimerKey(uid, homeId, deviceId);
  const timer = vibrationStateClearTimerMap.get(timerKey);

  if (timer) {
    clearTimeout(timer);
    vibrationStateClearTimerMap.delete(timerKey);
  }
}

function scheduleVibrationStateClear(
  uid,
  homeId,
  deviceId,
  eventTime,
) {
  const timerKey = getVibrationStateTimerKey(uid, homeId, deviceId);
  cancelVibrationStateClear(uid, homeId, deviceId);

  const timer = setTimeout(async () => {
    vibrationStateClearTimerMap.delete(timerKey);

    try {
      const deviceRef = db.ref(
        `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
      );
      const snap = await deviceRef.once("value");
      const device = snap.val() || {};

      // Chỉ clear đúng lần rung đã lên lịch. Lần rung mới hơn sẽ có timestamp
      // khác và timer riêng, nên không bị timer cũ ghi đè.
      if (Number(device.last_vibration_at || 0) !== eventTime) {
        return;
      }

      await deviceRef.update({
        vibration: false,
        vibration_active_until: null,
        updated_at: Date.now(),
      });
    } catch (error) {
      console.log(
        "VIBRATION STATE CLEAR ERROR:",
        deviceId,
        error.message,
      );
    }
  }, VIBRATION_ACTIVE_WINDOW_MS + 250);

  vibrationStateClearTimerMap.set(timerKey, timer);
}

function getSosStateTimerKey(uid, homeId, deviceId) {
  return `${uid}|${homeId}|${deviceId}`;
}

function cancelSosStateClear(uid, homeId, deviceId) {
  const timerKey = getSosStateTimerKey(uid, homeId, deviceId);
  const timer = sosStateClearTimerMap.get(timerKey);

  if (timer) {
    clearTimeout(timer);
    sosStateClearTimerMap.delete(timerKey);
  }
}

function scheduleSosStateClear(
  uid,
  homeId,
  deviceId,
  eventTime,
  activeUntil,
) {
  const timerKey = getSosStateTimerKey(uid, homeId, deviceId);
  cancelSosStateClear(uid, homeId, deviceId);

  const delayMs = Math.max(0, Number(activeUntil || 0) - Date.now());
  const timer = setTimeout(async () => {
    sosStateClearTimerMap.delete(timerKey);

    const currentDevice =
      getCachedHomeData(uid, homeId)?.devices?.[deviceId] || {};

    if (Number(currentDevice.last_triggered || 0) !== eventTime) {
      return;
    }

    const updateData = {
      sos_active_until: null,
      updated_at: Date.now(),
    };

    applyDeviceUpdateToLocalCache(
      uid,
      homeId,
      deviceId,
      updateData,
    );

    const devicePath =
      `accounts/${uid}/homes/${homeId}/devices/${deviceId}`;

    if (firebaseConnected) {
      try {
        await db.ref(devicePath).update(updateData);
        return;
      } catch (error) {
        console.log(
          "SOS STATE CLEAR QUEUED:",
          deviceId,
          error.message,
        );
      }
    }

    enqueueOfflineFirebaseUpdate(devicePath, updateData);
  }, delayMs + 120);

  sosStateClearTimerMap.set(timerKey, timer);
}

function getEmergencyStatusTimerKey(uid, homeId, deviceId) {
  return `${uid}|${homeId}|${deviceId}`;
}

function cancelEmergencyStatusClear(uid, homeId, deviceId) {
  const timerKey = getEmergencyStatusTimerKey(uid, homeId, deviceId);
  const timer = emergencyStatusClearTimerMap.get(timerKey);

  if (timer) {
    clearTimeout(timer);
    emergencyStatusClearTimerMap.delete(timerKey);
  }
}

function scheduleEmergencyStatusClear(
  uid,
  homeId,
  deviceId,
  eventTime,
  activeUntil,
  deviceType,
) {
  const timerKey = getEmergencyStatusTimerKey(uid, homeId, deviceId);
  cancelEmergencyStatusClear(uid, homeId, deviceId);

  const delayMs = Math.max(0, Number(activeUntil || 0) - Date.now());
  const timer = setTimeout(async () => {
    emergencyStatusClearTimerMap.delete(timerKey);

    const currentDevice =
      getCachedHomeData(uid, homeId)?.devices?.[deviceId] || {};

    if (
      Number(currentDevice.emergency_triggered_at || 0) !==
      Number(eventTime || 0)
    ) {
      return;
    }

    const updateData = {
      emergency_active_until: null,
      updated_at: Date.now(),
    };

    if (String(deviceType || "").trim() === "sos") {
      updateData.sos_active_until = null;
    }

    applyDeviceUpdateToLocalCache(
      uid,
      homeId,
      deviceId,
      updateData,
    );

    const devicePath =
      `accounts/${uid}/homes/${homeId}/devices/${deviceId}`;

    if (firebaseConnected) {
      try {
        await db.ref(devicePath).update(updateData);
        return;
      } catch (error) {
        console.log(
          "EMERGENCY STATUS CLEAR QUEUED:",
          deviceId,
          error.message,
        );
      }
    }

    enqueueOfflineFirebaseUpdate(devicePath, updateData);
  }, delayMs + 120);

  emergencyStatusClearTimerMap.set(timerKey, timer);
}

// Shared guard used by the composition root. Auto Away keeps its own
// private copy so the extracted domain does not depend on index.js.
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

// ================= BACKEND DATA CACHE =================
// Các tác vụ lặp dùng cache theo child thay vì tải lại toàn bộ /accounts.
// Chỉ có một lần bootstrap khi backend khởi động; sau đó cache được cập nhật
// bằng child_added / child_changed / child_removed.
const accountCache = new Map();
const sharedByHomeCache = new Map();
let backendDataCacheStarted = false;

// ================= FCM DELIVERY DOMAIN =================
// Owns active-session token selection, per-user localization, Firebase
// Messaging delivery results and cleanup of invalid installation tokens.
const {
  getUserLanguageCode,
  sendPushToUser,
} = createFcmDeliveryDomain({
  db,
  admin,
  accountCache,
  normalizeLanguageCode,
  localizeBackendText,
  localizeAlarmItemsJson,
  log: (...args) => console.log(...args),
});

// ================= HOME ACTIVITY DOMAIN =================
// Owns Home Notification persistence, recipient fanout, request validation,
// member/chat activity delivery and optional Home timeline writes.
const {
  addHomeNotificationFromBackend,
  addHomeNotificationToHomeRecipients,
  getCachedUserDisplayName,
  startHomeActivityMonitor,
  stopHomeActivityMonitor,
} = createHomeActivityDomain({
  db,
  getUserLanguageCode,
  localizeBackendText,
  queueOrderedListCleanup,
  getAlarmReceiverUidsForHome,
  lastNotificationMap,
  getCachedAccountData,
  buildUserDirectoryData,
  incrementChatUnreadCounter,
  sendChatNotificationPush,
  homeNotificationStorageLimit: HOME_NOTIFICATION_STORAGE_LIMIT,
  homeEventStorageLimit: HOME_EVENT_STORAGE_LIMIT,
  log: (...args) => console.log(...args),
});

// ================= SENSOR ALARM ENGINE DOMAIN =================
// Owns sensor-event normalization, event latching/debounce, Alarm policy and
// activation priority. Firebase access is injected only for persisted event
// controls; incident lifecycle and delivery orchestration remain here.
const {
  normalizeDeviceAlarmPolicy,
  getSensorEventCategory,
  getSensorAlarmEventCode,
  markAlarmItemsTriggered,
  markAlarmItemsAcknowledged,
  filterNewAlarmItemsByEventControl,
  releaseAlarmEventControlsForDeviceState,
  shouldAcceptSensorAlarmTrigger,
  buildAlarmTriggerFromSensorEvent,
  applyEmergencyStatusLatch,
  resolveAlarmActivationPriority,
} = createSensorAlarmEngine({
  db,
  getCachedAccountData,
  normalizeAlarmIncidentItems,
  isSecurityDeviceType,
  isEmergencyDeviceType,
  vibrationActiveWindowMs: VIBRATION_ACTIVE_WINDOW_MS,
  emergencyStatusHoldMs: EMERGENCY_STATUS_HOLD_MS,
  log: (...args) => console.log(...args),
});

let physicalSirenDomain = null;
let alarmIncidentPersistenceDomain = null;

// ================= LOCAL RUNTIME DOMAIN =================
// Owns the persisted Firebase snapshot, offline write/alarm queue and the
// Firebase connectivity monitor. Business decisions remain injected from the
// composition root so this module can be tested without loading the backend.
const {
  applyDeviceUpdateToLocalCache,
  enqueueOfflineAlarmItem,
  enqueueOfflineFirebaseUpdate,
  flushOfflineOperationQueue,
  loadLocalRuntimeState,
  persistLocalRuntimeSnapshotNow,
  persistOfflineQueueNow,
  persistRuntimeBeforeExit,
  scheduleLocalRuntimeSnapshotSave,
  startFirebaseConnectionMonitor,
  startOfflineQueueFlushTimer,
} = createLocalRuntimeDomain({
  db,
  accountCache,
  sharedByHomeCache,
  deviceMap,
  getFirebaseConnected: () => firebaseConnected,
  setFirebaseConnected: (value) => {
    firebaseConnected = value === true;
  },
  getAlarmIncidentItemIdentity,
  getCachedHomeData,
  isPersistentEmergencyIncidentItem,
  isEmergencyIncidentItemStillUnsafe,
  startOrMergeAlarmIncidents,
  resumeOfflineAlarmDemandsFromSnapshot,
  resumeActiveAlarmIncidents,
  reconcileAllPhysicalSirens: (...args) => {
    return physicalSirenDomain
      ? physicalSirenDomain.reconcileAllPhysicalSirens(...args)
      : Promise.resolve();
  },
  emergencyMergeWindowMs: EMERGENCY_MERGE_WINDOW_MS,
  offlineTransientAlarmTtlMs: OFFLINE_TRANSIENT_ALARM_TTL_MS,
  log: (...args) => console.log(...args),
});

// ================= HOME STATUS AGGREGATION =================
// Owns pure Home safety/system-warning evaluation and the normalized
// Presence/Auto Away counters consumed by Reminder and StatusPanel data.
const homeStatusAggregation = createHomeStatusAggregation({
  normalizeLockState,
  isActiveSignal,
  isSecurityDeviceType,
  isEmergencyDeviceType,
});

const {
  getHeartbeatLimitMs,
  parseSystemHealthTimestamp,
  isSystemHealthExplicitlyOffline,
  isSystemHealthExplicitlyOnline,
  evaluateHomeSystemHealth,
  getHomeNotificationSafety,
} = homeStatusAggregation;

// ================= SYSTEM HEALTH DOMAIN =================
// Persists system-warning transitions and emits recovery notifications.
// This monitor never creates Alarm incidents, fullscreen or physical siren.
const {
  startSystemHealthMonitor,
} = createSystemHealthDomain({
  db,
  getFirebaseConnected: () => firebaseConnected,
  getAccountsEntries: () => accountCache.entries(),
  addHomeNotificationToHomeRecipients,
  homeStatusAggregation,
  log: (...args) => console.log(...args),
});

// ================= SCHEDULED REMINDER DOMAIN =================
// Owns Reminder schedule selection, per-minute dedupe, summary batching,
// Home Notification creation and push delivery orchestration.
const {
  checkScheduledNotifications,
  startScheduledReminderMonitor,
  stopScheduledReminderMonitor,
} = createScheduledReminderDomain({
  db,
  getCachedAccountsObject,
  getCurrentHHMM,
  getHomeNotificationSafety,
  sendPushToUser,
  addHomeNotificationFromBackend,
  debugEnabled:
    (process.env.MAIYEN_REMINDER_DEBUG ||
      process.env.SAFEHOME_REMINDER_DEBUG) === "true",
  log: (...args) => console.log(...args),
});

// ================= PHYSICAL SIREN DOMAIN =================
// Owns Home siren command, confirmation, manual-mute and reconciliation
// state. Firebase/MQTT/cache access is injected by the composition root.
physicalSirenDomain = createPhysicalSirenDomain({
  db,
  client,
  accountCache,
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
  getFirebaseConnected: () => firebaseConnected,
  enqueueOfflineFirebaseUpdate,
  log: (...args) => console.log(...args),
});

const {
  getHomeSirenRuntimeKey,
  getHomeSirenRuntime,
  setPhysicalSirenForHome,
  mutePhysicalSirenForHome,
  reconcilePhysicalSirenForHome,
  requestPhysicalSirenForIncident,
  reconcileAllPhysicalSirens,
  startPhysicalSirenMonitor,
} = physicalSirenDomain;

// ================= ALARM INCIDENT LIFECYCLE =================
// Owns incident timers, stage progression, retry locks and deterministic
// Android/iOS delivery identities. Firebase validation and the final
// resolve/merge orchestration remain injected by the composition root.
const {
  clearAlarmIncidentTimers,
  rescheduleAlarmIncidentExpireTimer,
  queueAlarmIncidentAdvance,
  resetAlarmStageRetry,
  scheduleAlarmIncidentStageRetry,
  retryInitialAlarmIncidentPush,
  scheduleInitialAlarmIncidentPushRetry,
  withAlarmIncidentStartLock,
  getMaiYenAndroidAlarmCollapseKey,
  getMaiYenAlarmDeliveryId,
  getMaiYenIosAlarmCategory,
  getMaiYenIosAlarmThreadId,
  getMaiYenIosAlarmCollapseId,
  buildMaiYenAlarmApnsConfig,
  getActiveAlarmIncident,
  advanceAlarmIncidentToStage,
  scheduleAlarmIncidentStages,
} = createAlarmIncidentLifecycle({
  db,
  alarmIncidentTimerMap,
  alarmIncidentAdvanceInProgress,
  alarmIncidentStartPromiseMap,
  alarmIncidentQueuedStageMap,
  alarmIncidentStageRetryCountMap,
  getAlarmIncidentTimerKey,
  getAlarmStagePriority,
  getAlarmStageRetryKey,
  normalizeAlarmIncidentItems,
  getAlarmIncidentItemIdentity,
  getAlarmIncidentRuntimePreferences,
  setLocalActiveAlarmIncident,
  validateAndResolveSecurityIncident,
  sendAlarmStageSummary,
  isAlarmItemAllowedByCurrentHomeMode,
  requestPhysicalSirenForIncident,
  expireAlarmIncident,
  scheduleSecurityModeRepeatTimer,
  alarmStageRetryDelayMs: ALARM_STAGE_RETRY_DELAY_MS,
  alarmStageMaxRetryCount: ALARM_STAGE_MAX_RETRY_COUNT,
  alarmIncidentAutoExpireMs: ALARM_INCIDENT_AUTO_EXPIRE_MS,
  alarmIncidentCallDelayMs: ALARM_INCIDENT_CALL_DELAY_MS,
  emergencyCallDelayMs: EMERGENCY_CALL_DELAY_MS,
  iosTimeSensitiveAlertsEnabled: IOS_TIME_SENSITIVE_ALERTS_ENABLED,
  iosCriticalAlertsEnabled: IOS_CRITICAL_ALERTS_ENABLED,
});

// ================= ALARM INCIDENT PERSISTENCE =================
// Owns Firebase start/merge/resume/resolve orchestration for Alarm incidents.
// Thin wrappers remain in index.js because local runtime is created earlier and
// receives these callbacks before this domain is initialized.
alarmIncidentPersistenceDomain = createAlarmIncidentPersistence({
  db,
  normalizeAlarmIncidentItems,
  getAlarmIncidentFlowType,
  getAlarmIncidentTargetKey,
  withAlarmIncidentStartLock,
  normalizePreferredSecurityIncidentItems,
  evaluateSecurityIncident,
  isAlarmItemAllowedByCurrentHomeMode,
  isScheduledAlarmSource,
  canReceiveAlarm,
  getActiveAlarmIncident,
  getAlarmIncidentItemIdentity,
  normalizeRepeatMinutes,
  buildStandardIncidentFields,
  markAlarmItemsTriggered,
  ensureSecurityModeRepeatForIncident,
  deliverSecurityAlarmChannelsImmediately,
  isPersistentEmergencyIncidentItem,
  getAlarmIncidentExpireDelayMs,
  rescheduleAlarmIncidentExpireTimer,
  sendAlarmStageSummary,
  scheduleInitialAlarmIncidentPushRetry,
  reconcilePhysicalSirenForHome,
  clearAlarmIncidentTimers,
  removeLocalActiveAlarmIncident,
  filterNewAlarmItemsByEventControl,
  setLocalActiveAlarmIncident,
  getSecurityModeItems,
  getCachedHomeData,
  normalizeSecurityModeRepeatMinutes,
  applySecurityModeRepeatToItems,
  getLegacyIncidentSeverity,
  getStandardIncidentEventCategory,
  getStandardIncidentAlarmLevel,
  getEmergencyIncidentTitle,
  addHomeNotificationFromBackend,
  resetAlarmStageRetry,
  advanceAlarmIncidentToStage,
  scheduleAlarmIncidentStages,
  getCachedAccountsObject,
  isHomeUnprotected,
  validateAndResolveSecurityIncident,
  getIncidentResolutionType,
  markAlarmItemsAcknowledged,
  hasLocalActiveAlarmIncidentForReceiver,
  sendAlarmResolvedPush,
  getAlarmReceiverUidsForHome,
  getCachedAccountData,
  alarmIncidentSchemaVersion: ALARM_INCIDENT_SCHEMA_VERSION,
  emergencyMergeWindowMs: EMERGENCY_MERGE_WINDOW_MS,
  alarmIncidentCallDelayMs: ALARM_INCIDENT_CALL_DELAY_MS,
  emergencyCallDelayMs: EMERGENCY_CALL_DELAY_MS,
  log: (...args) => console.log(...args),
});

// ================= PRESENCE & SESSION DOMAIN =================
// Owns session freshness, active-session recovery, monitoring health and
// platform-specific continuity for Home Presence.
const presenceSessionCoordinator =
  createPresenceSessionCoordinator({
    sendPushToUser,
  });

// ================= AUTO AWAY DOMAIN =================
// Presence aggregation, participant selection and automatic security mode
// transitions are isolated from the composition root.
const {
  startAutoAwayMonitor,
} = createAutoAwayDomain({
  db,
  getCachedAccountsObject,
  getCachedSharedByHomeObject,
  sendPushToUser,
  addHomeNotificationToHomeRecipients,
  isSecurityDeviceType,
  normalizeHomeSecurityMode,
  presenceSessionCoordinator,
  log: (...args) => console.log(...args),
});

// ================= SECURITY MODE ORCHESTRATION DOMAIN =================
// Owns mode listeners, startup recovery, unsafe-state re-evaluation,
// unprotected cleanup and the transition back to protected operation.
securityModeOrchestrationDomain =
  createSecurityModeOrchestrationDomain({
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
    sensorEventSeverity: SENSOR_EVENT_SEVERITY,
    sensorEventCategory: SENSOR_EVENT_CATEGORY,
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
    unprotectedTransientReplayWindowMs:
      UNPROTECTED_TRANSIENT_REPLAY_WINDOW_MS,
    log: (...args) => console.log(...args),
  });

const {
  getKnownMode: getKnownSecurityMode,
  startSecurityModeOrchestration,
  stopSecurityModeOrchestration,
} = securityModeOrchestrationDomain;

function getCachedAccountsObject() {
  return Object.fromEntries(accountCache.entries());
}

function getCachedSharedByHomeObject() {
  return Object.fromEntries(sharedByHomeCache.entries());
}

function buildUserDirectoryData(rawUser) {
  const user = rawUser || {};
  const profile = user.profile || {};

  return {
    email: String(user.email || "")
      .trim()
      .toLowerCase(),
    name: String(
      profile.name ||
      user.name ||
      "",
    ).trim(),
    photoUrl: String(
      profile.photoUrl ||
      user.photoUrl ||
      "",
    ).trim(),
  };
}

async function syncUserDirectoryEntry(uid, rawUser) {
  if (!uid) {
    return;
  }

  const directoryData = buildUserDirectoryData(rawUser);
  const signature = JSON.stringify(directoryData);

  if (userDirectoryCache[uid] === signature) {
    return;
  }

  userDirectoryCache[uid] = signature;

  await db.ref(`userDirectory/${uid}`).set({
    ...directoryData,
    updatedAt: Date.now(),
  });
}

async function removeUserDirectoryEntry(uid) {
  if (!uid) {
    return;
  }

  delete userDirectoryCache[uid];
  await db.ref(`userDirectory/${uid}`).remove();
}

async function startBackendDataCache() {
  if (backendDataCacheStarted) {
    return;
  }

  backendDataCacheStarted = true;

  const accountsRef = db.ref("accounts");
  const sharedRef = db.ref("sharedByHome");

  const upsertAccount = (snap) => {
    const uid = String(snap.key || "").trim();

    if (!uid) {
      return;
    }

    const account = snap.val() || {};
    const previousAccount = accountCache.get(uid) || null;

    accountCache.set(uid, account);
    scheduleLocalRuntimeSnapshotSave();

    if (previousAccount) {
      void handleAlarmRelevantAccountChange(
        uid,
        previousAccount,
        account,
      );
    }

    void syncUserDirectoryEntry(uid, account).catch((error) => {
      console.log(
        "USER DIRECTORY SYNC ERROR:",
        uid,
        error.message,
      );
    });
  };

  const removeAccount = (snap) => {
    const uid = String(snap.key || "").trim();

    if (!uid) {
      return;
    }

    accountCache.delete(uid);
    scheduleLocalRuntimeSnapshotSave();

    for (const key of Array.from(
      localActiveAlarmIncidentMap.keys(),
    )) {
      if (key.startsWith(`${uid}|`)) {
        localActiveAlarmIncidentMap.delete(key);
      }
    }

    void removeUserDirectoryEntry(uid).catch((error) => {
      console.log(
        "USER DIRECTORY REMOVE ERROR:",
        uid,
        error.message,
      );
    });
  };

  const upsertSharedHome = (snap) => {
    const homeId = String(snap.key || "").trim();

    if (homeId) {
      sharedByHomeCache.set(homeId, snap.val() || {});
      scheduleLocalRuntimeSnapshotSave();
    }
  };

  const removeSharedHome = (snap) => {
    const homeId = String(snap.key || "").trim();

    if (homeId) {
      sharedByHomeCache.delete(homeId);
      scheduleLocalRuntimeSnapshotSave();
    }
  };

  accountsRef.on("child_added", upsertAccount);
  accountsRef.on("child_changed", upsertAccount);
  accountsRef.on("child_removed", removeAccount);

  sharedRef.on("child_added", upsertSharedHome);
  sharedRef.on("child_changed", upsertSharedHome);
  sharedRef.on("child_removed", removeSharedHome);

  // Bootstrap đúng một lần để các tác vụ khởi động có dữ liệu đầy đủ.
  const [accountsSnap, sharedSnap, deviceIndexSnap] =
    await Promise.all([
      accountsRef.once("value"),
      sharedRef.once("value"),
      db.ref("system/devices_by_ieee").once("value"),
    ]);

  const accounts = accountsSnap.val() || {};
  const sharedByHome = sharedSnap.val() || {};
  const deviceIndex = deviceIndexSnap.val() || {};

  const directorySyncTasks = [];

  for (const [uid, account] of Object.entries(accounts)) {
    const safeAccount = account || {};
    accountCache.set(uid, safeAccount);
    directorySyncTasks.push(
      syncUserDirectoryEntry(uid, safeAccount),
    );

    // Giữ tương thích với thiết bị cũ chưa có bản ghi trong
    // system/devices_by_ieee. Các thiết bị mới vẫn được cập nhật
    // realtime từ device index listener ở trên.
    const homes = safeAccount.homes || {};

    for (const [homeId, rawHome] of Object.entries(homes)) {
      const devices = rawHome?.devices || {};

      for (const deviceId of Object.keys(devices)) {
        if (!deviceMap[deviceId]) {
          deviceMap[deviceId] = { uid, homeId };
        }
      }
    }
  }

  for (const [homeId, members] of Object.entries(sharedByHome)) {
    sharedByHomeCache.set(homeId, members || {});
  }

  for (const [deviceId, rawEntry] of Object.entries(deviceIndex)) {
    const entry = rawEntry || {};
    const uid = String(entry.uid || "").trim();
    const homeId = String(entry.homeId || "").trim();

    if (uid && homeId) {
      deviceMap[deviceId] = { uid, homeId };
    }
  }

  await Promise.all(directorySyncTasks);
  persistLocalRuntimeSnapshotNow();

  console.log(
    "🗂️ BACKEND DATA CACHE READY:",
    `accounts=${accountCache.size}`,
    `homes=${sharedByHomeCache.size}`,
    `devices=${Object.keys(deviceMap).length}`,
  );
}
// ================= PUSH PAYLOADS =================
// Token selection, localization and Firebase Messaging transport are owned by
// domains/notifications/fcm_delivery.js. Payload builders remain close to the
// business workflows that create them.

// Scheduled Reminder payloads, summary batching, dedupe and schedule scans
// are owned by domains/notifications/scheduled_reminder.js.

function getTodayKey() {
  return getDateKeyFromTimestamp(Date.now());
}

function getDateKeyFromTimestamp(timestamp) {
  const date = new Date(Number(timestamp || 0));
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);

  return Number.isFinite(timestamp) && timestamp > 0
    ? timestamp
    : 0;
}

function resolveAlarmPauseTimeRange(pause) {
  const directStartAt = normalizeTimestamp(pause?.startAt);
  const directEndAt = normalizeTimestamp(pause?.endAt);

  if (directStartAt > 0 && directEndAt > directStartAt) {
    return { startAt: directStartAt, endAt: directEndAt };
  }

  const dateMatch = String(pause?.date || "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const start = String(pause?.start || "").trim();
  const end = String(pause?.end || "").trim();

  if (!dateMatch || !isValidHHMM(start) || !isValidHHMM(end)) {
    return { startAt: 0, endAt: 0 };
  }

  const year = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const day = Number.parseInt(dateMatch[3], 10);
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const startDate = new Date(
    year,
    month - 1,
    day,
    startHour,
    startMinute,
    0,
    0,
  );
  const endDate = new Date(
    year,
    month - 1,
    day,
    endHour,
    endMinute,
    0,
    0,
  );

  if (
    startDate.getFullYear() !== year ||
    startDate.getMonth() !== month - 1 ||
    startDate.getDate() !== day
  ) {
    return { startAt: 0, endAt: 0 };
  }

  if (endDate.getTime() <= startDate.getTime()) {
    endDate.setDate(endDate.getDate() + 1);
  }

  return {
    startAt: startDate.getTime(),
    endAt: endDate.getTime(),
  };
}

function isTimeInPauseRange(startTime, endTime) {
  if (!startTime || !endTime) return false;
  return isNowInRange(startTime, endTime);
}

function getAlarmPauseExpiryTimerKey(ownerUid, homeId) {
  return `${ownerUid}|${homeId}`;
}

function cancelAlarmPauseExpiryTimer(ownerUid, homeId) {
  const key = getAlarmPauseExpiryTimerKey(ownerUid, homeId);
  const timer = alarmPauseExpiryTimerMap.get(key);
  if (timer) {
    clearTimeout(timer);
    alarmPauseExpiryTimerMap.delete(key);
  }
}

function scheduleAlarmPauseExpiry(
  ownerUid,
  homeId,
  pauseData,
) {
  cancelAlarmPauseExpiryTimer(ownerUid, homeId);
  const { endAt } = resolveAlarmPauseTimeRange(pauseData);
  if (endAt <= 0) return;

  const key = getAlarmPauseExpiryTimerKey(ownerUid, homeId);
  const delayMs = Math.max(0, endAt - Date.now());
  const timer = setTimeout(async () => {
    alarmPauseExpiryTimerMap.delete(key);
    try {
      await clearHomeAlarmPause(
        ownerUid,
        homeId,
        null,
        pauseData,
      );
      console.log(
        "🧹 ALARM PAUSE EXPIRED ON TIME:",
        ownerUid,
        homeId,
      );
    } catch (error) {
      console.log(
        "ALARM PAUSE EXPIRY TIMER ERROR:",
        ownerUid,
        homeId,
        error.message,
      );
    }
  }, delayMs + 120);
  alarmPauseExpiryTimerMap.set(key, timer);
}

async function clearHomeAlarmPause(
  ownerUid,
  homeId,
  sharedUsers = null,
  pauseData = null,
) {
  cancelAlarmPauseExpiryTimer(ownerUid, homeId);
  const cachedHome = getCachedHomeData(ownerUid, homeId) || {};
  let resolvedPause =
    pauseData && typeof pauseData === "object"
      ? pauseData
      : cachedHome.alarmPauseToday;

  if (!resolvedPause) {
    try {
      const pauseSnap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}/alarmPauseToday`)
        .once("value");
      resolvedPause = pauseSnap.val();
    } catch (_) {
      resolvedPause = null;
    }
  }

  const updates = {
    [`accounts/${ownerUid}/homes/${homeId}/alarmPauseToday`]:
      null,
  };

  let resolvedSharedUsers = sharedUsers;

  if (!resolvedSharedUsers) {
    try {
      const sharedSnap = await db
        .ref(`sharedByHome/${homeId}`)
        .once("value");

      resolvedSharedUsers = sharedSnap.val() || {};
    } catch (_) {
      resolvedSharedUsers = {};
    }
  }

  for (const sharedUid of Object.keys(resolvedSharedUsers || {})) {
    if (sharedUid === ownerUid) {
      continue;
    }

    updates[
      `accounts/${sharedUid}/sharedHomes/${homeId}/alarmPauseToday`
    ] = null;
  }

  await db.ref().update(updates);

  if (resolvedPause) {
    const recipients = new Set([
      ownerUid,
      ...Object.keys(resolvedSharedUsers || {}),
    ]);
    const pauseMarker = String(
      resolvedPause.endAt ||
      `${resolvedPause.date || ""}|${resolvedPause.end || ""}`,
    );
    const notificationKey =
      `alarm_pause_ended|${ownerUid}|${homeId}|${pauseMarker}`;
    const homeName = String(cachedHome.name || homeId).trim() || homeId;

    await addHomeNotificationToHomeRecipients({
      ownerUid,
      homeId,
      homeName,
      type: "alarm_pause_ended",
      category: "alarm",
      severity: "success",
      title: "Báo động đã hoạt động trở lại",
      message: "Thời gian tạm dừng báo động đã kết thúc.",
      entityType: "home",
      entityId: homeId,
      recipientUids: [...recipients],
      dedupeKey: notificationKey,
      dedupeMs: 24 * 60 * 60 * 1000,
      data: {
        pauseEndedAt: Date.now(),
      },
    });
  }
}

async function isHomeAlarmPausedToday(ownerUid, homeId) {
  try {
    const cachedHome = getCachedHomeData(ownerUid, homeId);
    let pause = cachedHome?.alarmPauseToday;

    if (!cachedHome) {
      const snap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}/alarmPauseToday`)
        .once("value");

      pause = snap.val();
    }

    if (!pause) return false;

    const now = Date.now();
    const { startAt, endAt } = resolveAlarmPauseTimeRange(pause);

    if (startAt > 0 && endAt > startAt) {
      if (now >= startAt && now < endAt) {
        return true;
      }

      if (now >= endAt) {
        try {
          await clearHomeAlarmPause(ownerUid, homeId, null, pause);

          console.log(
            "🧹 ALARM PAUSE REMOVED:",
            ownerUid,
            homeId,
          );
        } catch (_) { }
      }

      return false;
    }

    // Dữ liệu không đủ ngày/giờ hợp lệ: dùng kiểm tra cũ làm dự phòng.
    const today = getTodayKey();

    if (pause.date !== today) {
      try {
        await clearHomeAlarmPause(ownerUid, homeId, null, pause);
      } catch (_) { }

      return false;
    }

    const paused = isTimeInPauseRange(
      pause.start,
      pause.end,
    );

    if (paused) {
      return true;
    }

    const current = toMin(getCurrentHHMM());
    const start = toMin(pause.start);
    const end = toMin(pause.end);

    let pauseFinished = false;

    if (start > end) {
      pauseFinished =
        current > end &&
        current < start;
    } else {
      pauseFinished =
        current > end;
    }

    if (pauseFinished) {
      try {
        await clearHomeAlarmPause(ownerUid, homeId, null, pause);

        console.log(
          "🧹 ALARM PAUSE REMOVED:",
          ownerUid,
          homeId,
        );
      } catch (_) { }
    }

    return false;
  } catch (err) {
    console.log("ALARM PAUSE CHECK ERROR:", err.message);
    return false;
  }
}

async function canReceiveAlarm(
  uid,
  homeId,
  ownerUid = uid,
  options = {},
) {
  try {
    const respectPause = options?.respectPause !== false;

    // Công tắc Alarm cấp user cũ không còn tham gia quyết định Alarm.
    // Mode nhà là nguồn điều khiển duy nhất; Pause Today chỉ chặn Alarm theo lịch.
    if (respectPause) {
      const paused = await isHomeAlarmPausedToday(ownerUid, homeId);

      if (paused) {
        console.log("⏸️ HOME ALARM PAUSED:", ownerUid, homeId);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.log("ALARM PAUSE CHECK ERROR:", err.message);
    return true;
  }
}
async function sendAlarmPauseNotification(
  uid,
  homeId,
  homeName,
  text,
) {
  try {
    const pushResult = await sendPushToUser(
      uid,
      {
        data: {
          type: "schedule_notification",
          forceShow: "true",
          reason: text,
          severity: "warning",
          isSafe: "false",
          title: homeName || "Nhà",
          body: text,
          homeId: homeId || "",
          uid: uid || "",
          clickAction: "schedule_SCREEN",
        },

        // Data-only để app dùng đúng một notification Reminder
        // ID 999998 và channel ưu tiên mới.
        android: {
          priority: "high",
        },

        apns: {
          headers: {
            "apns-priority": "10",
          },
          payload: {
            aps: {
              alert: {
                title: homeName || "Nhà",
                body: text,
              },
              sound: "default",
              category: "SAFEHOME_REMINDER",
              "thread-id": "safehome_reminder",
            },
          },
        },
      },
      "ALARM PAUSE",
    );

    if (pushResult.sent === 0) {
      return;
    }

    console.log(
      "⏸️ ALARM PAUSE WARNING SENT:",
      uid,
      homeId,
      `devices=${pushResult.sent}`,
    );
  } catch (err) {
    console.log(
      "ALARM PAUSE NOTIFICATION ERROR:",
      err.message,
    );
  }
}
async function sendUnprotectedSensorNotification(
  receiverUid,
  {
    ownerUid,
    homeId,
    homeName,
    deviceId,
    deviceName,
    deviceType,
    reason,
    eventCategory,
  },
) {
  const title = String(homeName || "Nhà").trim() || "Nhà";
  const body = String(reason || "Có sự kiện cảm biến").trim();
  const notificationKey = [
    "unprotected",
    receiverUid,
    homeId,
    deviceId,
    body,
  ].join("|");
  const now = Date.now();

  if (
    lastNotificationMap[notificationKey] &&
    now - lastNotificationMap[notificationKey] < 30 * 1000
  ) {
    return;
  }

  lastNotificationMap[notificationKey] = now;

  await addHomeNotificationFromBackend({
    uid: receiverUid,
    homeId,
    homeName: title,
    type: "sensor_notification",
    title,
    message: body,
    category: "sensor",
    severity: eventCategory === SENSOR_EVENT_CATEGORY.EMERGENCY
      ? "warning"
      : "info",
    eventCategory,
    alarmLevel: "warning",
    entityType: "device",
    entityId: deviceId,
  });

  const data = {
    type: "sensor_notification",
    title,
    body,
    ownerUid: String(ownerUid || ""),
    homeId: String(homeId || ""),
    homeName: title,
    deviceId: String(deviceId || ""),
    deviceName: String(deviceName || ""),
    deviceType: String(deviceType || ""),
    reason: body,
    eventCategory: String(eventCategory || ""),
    alarmLevel: "warning",
    securityMode: "unprotected",
    clickAction: "sensor_notification",
  };

  await sendPushToUser(
    receiverUid,
    {
      data,
      notification: {
        title,
        body,
      },
      android: {
        priority: "high",
        notification: {
          channelId: "safehome_sensor_notification_v1",
          sound: "default",
          tag: `safehome_sensor_${homeId}_${deviceId}`,
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: { title, body },
            sound: "default",
            threadId: `safehome_sensor_${homeId}`,
          },
        },
      },
    },
    "UNPROTECTED SENSOR NOTIFICATION",
  );
}










// ================= INCIDENT VALIDATION =================
// Incident an ninh được hủy theo sự kiện thay vì polling dày.
// Tất cả kiểm tra thường dùng cache; Firebase chỉ được đọc bù khi
// event đến quá sớm và cache chưa kịp nhận incident vừa tạo.
const alarmHomeValidationTimerMap = new Map();

function getCachedAccountData(uid) {
  return accountCache.get(String(uid || "").trim()) || null;
}

function getCachedHomeData(ownerUid, homeId) {
  const ownerAccount = getCachedAccountData(ownerUid);

  if (!ownerAccount) {
    return null;
  }

  return ownerAccount?.homes?.[homeId] || null;
}


// Một nguồn duy nhất cho danh sách người nhận Alarm của Home:
// Chủ nhà + các UID đang có trong sharedByHome/{homeId}.
function getAlarmReceiverUidsForHome(ownerUid, homeId) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();

  if (!cleanOwnerUid || !cleanHomeId) {
    return [];
  }

  const receiverUids = new Set([cleanOwnerUid]);
  const sharedMembers =
    sharedByHomeCache.get(cleanHomeId) || {};

  for (const sharedUid of Object.keys(sharedMembers)) {
    const cleanUid = String(sharedUid || "").trim();

    // Không ghi incident vào một UID đã bị xóa khỏi /accounts.
    if (cleanUid && getCachedAccountData(cleanUid)) {
      receiverUids.add(cleanUid);
    }
  }

  return Array.from(receiverUids);
}


function isAlarmPauseActiveFromData(pause) {
  if (!pause || typeof pause !== "object") {
    return false;
  }

  const now = Date.now();
  const { startAt, endAt } = resolveAlarmPauseTimeRange(pause);

  if (startAt > 0 && endAt > startAt) {
    return now >= startAt && now < endAt;
  }

  if (
    String(pause.date || "") !== getTodayKey() ||
    !isValidHHMM(pause.start) ||
    !isValidHHMM(pause.end)
  ) {
    return false;
  }

  return isNowInRange(pause.start, pause.end);
}

function getIncidentDeviceContext(home, item) {
  const devices = home?.devices || {};
  const requestedDeviceId = String(
    item?.deviceId || "",
  ).trim();

  if (
    requestedDeviceId &&
    devices[requestedDeviceId]
  ) {
    return {
      deviceId: requestedDeviceId,
      device: devices[requestedDeviceId],
    };
  }

  const requestedName = String(
    item?.deviceName || "",
  ).trim();
  const requestedType = String(
    item?.type || "",
  ).trim();

  for (const [deviceId, rawDevice] of Object.entries(devices)) {
    const device = rawDevice || {};
    const deviceName = String(
      device.name || deviceId,
    ).trim();
    const deviceType = String(
      device.type || "",
    ).trim();

    if (
      requestedName &&
      deviceName === requestedName &&
      (!requestedType || deviceType === requestedType)
    ) {
      return { deviceId, device };
    }
  }

  return null;
}

function isSecurityIncidentItemStillUnsafe(
  home,
  item,
) {
  const context = getIncidentDeviceContext(home, item);

  // Không tự hủy khi không định danh được thiết bị của incident cũ.
  // Watchdog sẽ thử lại sau; đây là fail-safe để không bỏ sót Alarm thật.
  if (!context) {
    return true;
  }

  const device = context.device || {};
  const deviceType = String(
    item?.type || device.type || "",
  ).trim();
  const reason = String(item?.reason || "")
    .trim()
    .toLowerCase();

  const isTamperIncident =
    reason.includes("bị tháo") ||
    reason.includes("tamper") ||
    reason.includes("cạy");

  if (isTamperIncident) {
    return device.tamper === true;
  }

  if (
    deviceType === "door" ||
    deviceType === "window" ||
    deviceType === "gate"
  ) {
    return device.contact === false;
  }

  if (
    deviceType === "door_lock" ||
    deviceType === "lock"
  ) {
    return normalizeLockState(device) === "unlocked";
  }

  if (
    deviceType === "motion" ||
    deviceType === "presence"
  ) {
    return (
      isActiveSignal(device.occupancy) ||
      isActiveSignal(device.motion) ||
      isActiveSignal(device.presence)
    );
  }

  // Rung và kính vỡ là event tức thời, không có trạng thái clear đáng tin cậy.
  // Chúng chỉ bị hủy khi Mode/lịch không còn hiệu lực hoặc người dùng xử lý.
  if (
    deviceType === "vibration" ||
    deviceType === "glass_break"
  ) {
    return true;
  }

  return Boolean(
    getUnsafeSecurityReason(
      String(item?.deviceName || context.deviceId),
      deviceType,
      device,
    ),
  );
}

async function isSecurityIncidentSourceActive({
  receiverUid,
  ownerUid,
  homeId,
  item,
  home,
  receiverAccount,
}) {
  const originalSource = String(
    item?.alarmSource || "scheduled_alarm",
  ).trim();
  const homeMode = normalizeHomeSecurityMode(home?.securityMode);

  if (homeMode === "unprotected") {
    return {
      active: false,
      reason: "home_unprotected",
    };
  }

  const context = getIncidentDeviceContext(home, item);

  // Không đủ dữ liệu để xác định thiết bị: chỉ giữ tạm incident ở Mode Bảo vệ.
  // Ở Bình thường không được giả định lịch còn hiệu lực vì sẽ gây Alarm mơ hồ.
  if (!context) {
    if (homeMode === "armed") {
      return {
        active: true,
        reason: "device_unavailable",
        normalizedSource: "security_mode",
        modeRepeatMinutes: normalizeSecurityModeRepeatMinutes(
          home?.securityModeRepeatMinutes,
        ),
      };
    }

    return {
      active: false,
      reason: "device_unavailable",
    };
  }

  const configuration =
    await resolveDeviceAlarmConfigurationForReceiver(
      receiverUid,
      homeId,
      context.deviceId,
      home,
      receiverAccount || {},
      ownerUid,
    );
  const policy = configuration?.policy || {};
  const activeSchedule =
    homeMode === "armed"
      ? null
      : resolveActiveDeviceSchedule(configuration);
  const alarmPaused =
    homeMode !== "armed" &&
    isAlarmPauseActiveFromData(home?.alarmPauseToday);
  const activation = resolveAlarmActivationPriority({
    deviceType: String(
      context.device?.type || item?.type || "unknown",
    ).trim(),
    homeMode,
    policyEnabled: policy.enabled === true,
    activeSchedule,
    alarmPaused,
    modeRepeatMinutes: home?.securityModeRepeatMinutes,
  });

  if (!activation.active) {
    return {
      active: false,
      reason: activation.reason,
      configuration,
    };
  }

  // Mode Bảo vệ luôn thắng nguồn lịch hiện có. Nhờ vậy lịch kết thúc hoặc
  // Pause Today không thể đóng incident trong khi nhà vẫn đang được bảo vệ.
  if (activation.source === "security_mode") {
    return {
      active: true,
      reason: "",
      configuration,
      normalizedSource: "security_mode",
      modeRepeatMinutes: activation.repeatMinutes,
    };
  }

  if (originalSource === "security_mode") {
    const scheduleKey = getScheduleAlarmKey(
      receiverUid,
      ownerUid,
      homeId,
      context.deviceId,
      activeSchedule?.alarm,
      "scheduled_alarm",
    );

    // Bàn giao Mode -> lịch đang chạy là cùng một incident liên tục,
    // không phải một lần kích hoạt mới cần bật lại fullscreen.
    lastScheduleAlarmMap[scheduleKey] = Date.now();
  }

  return {
    active: true,
    reason: "",
    configuration,
    activeSchedule,
    normalizedSource: "scheduled_alarm",
  };
}

async function evaluateSecurityIncident(
  receiverUid,
  incident,
  { homeOverride = null } = {},
) {
  const normalizedItems = incident?.flowType === "emergency"
    ? normalizeAlarmIncidentItems(incident?.items)
    : normalizePreferredSecurityIncidentItems(incident?.items);

  if (incident?.flowType === "emergency") {
    return {
      active: true,
      items: normalizedItems,
      reason: "",
    };
  }

  const ownerUid = String(
    incident?.ownerUid || receiverUid,
  ).trim();
  const homeId = String(incident?.homeId || "").trim();
  const ownerAccount = getCachedAccountData(ownerUid);
  const receiverAccount =
    getCachedAccountData(receiverUid);

  if (!homeId) {
    return {
      active: false,
      items: [],
      reason: "home_missing",
    };
  }

  if (receiverUid !== ownerUid) {
    const sharedMembers =
      sharedByHomeCache.get(homeId) || {};

    if (!sharedMembers?.[receiverUid]) {
      return {
        active: false,
        items: [],
        reason: "home_access_removed",
      };
    }
  }

  let home = homeOverride;

  if (!home) {
    home = ownerAccount?.homes?.[homeId] || null;
  }

  if (!home) {
    // Tài khoản đã có trong cache nhưng nhà không còn tồn tại.
    if (ownerAccount) {
      return {
        active: false,
        items: [],
        reason: "home_removed",
      };
    }

    // Cache chưa sẵn sàng: giữ Alarm để tránh hủy nhầm.
    return {
      active: true,
      items: normalizedItems,
      reason: "home_unavailable",
    };
  }

  if (normalizedItems.length === 0) {
    return {
      active: false,
      items: [],
      reason: "incident_items_empty",
    };
  }

  const validItems = [];
  let firstInactiveReason = "condition_cleared";

  for (const item of normalizedItems) {
    const sourceResult =
      await isSecurityIncidentSourceActive({
        receiverUid,
        ownerUid,
        homeId,
        item,
        home,
        receiverAccount: receiverAccount || {},
      });

    if (!sourceResult.active) {
      firstInactiveReason =
        sourceResult.reason || firstInactiveReason;
      continue;
    }

    if (!isSecurityIncidentItemStillUnsafe(home, item)) {
      firstInactiveReason = "device_state_resolved";
      continue;
    }

    const context = getIncidentDeviceContext(home, item);
    const configuration = sourceResult.configuration || null;
    const activeSchedule = sourceResult.activeSchedule || null;
    const policy = configuration?.policy || null;
    const normalizedSource = String(
      sourceResult.normalizedSource || item.alarmSource || "scheduled_alarm",
    ).trim();
    const isSecurityModeSource =
      normalizedSource === "security_mode";
    const refreshedRepeatMinutes = isSecurityModeSource
      ? normalizeSecurityModeRepeatMinutes(
          sourceResult.modeRepeatMinutes ??
          home?.securityModeRepeatMinutes,
        )
      : normalizeRepeatMinutes(
          activeSchedule?.alarm?.repeatMinutes,
        );

    validItems.push({
      ...item,
      deviceId:
        String(item.deviceId || "").trim() ||
        String(context?.deviceId || "").trim(),
      alarmSource: normalizedSource,
      repeatMinutes: refreshedRepeatMinutes,
      nextAlarm: getNextAlarmTimeText(refreshedRepeatMinutes),
      notificationEnabled: isSecurityModeSource
        ? policy?.notificationEnabled !== false
        : activeSchedule?.notificationAllowed === true,
      fullscreenEnabled: isSecurityModeSource
        ? configuration?.fullscreenEnabled === true
        : activeSchedule?.fullscreenAllowed === true,
      physicalSirenEnabled: isSecurityModeSource
        ? policy?.physicalSirenEnabled !== false
        : activeSchedule?.physicalSirenAllowed === true,
    });
  }

  const preferredValidItems =
    normalizePreferredSecurityIncidentItems(validItems);

  return {
    active: preferredValidItems.length > 0,
    items: preferredValidItems,
    reason:
      preferredValidItems.length > 0
        ? ""
        : firstInactiveReason,
  };
}

async function validateAndResolveSecurityIncident(
  receiverUid,
  incidentId,
  incident,
  {
    homeOverride = null,
    reasonHint = "condition_changed",
  } = {},
) {
  const lockKey = `${receiverUid}|${incidentId}`;
  const existingPromise =
    alarmIncidentValidationPromiseMap.get(lockKey);

  if (existingPromise) {
    return existingPromise;
  }

  if (
    !incident ||
    incident.status !== "active" ||
    incident.flowType === "emergency"
  ) {
    return {
      active: incident?.status === "active",
      items: normalizeAlarmIncidentItems(
        incident?.items,
      ),
    };
  }

  const validationPromise = (async () => {
    try {
      const result = await evaluateSecurityIncident(
        receiverUid,
        incident,
        { homeOverride },
      );

      if (result.active) {
        const runtimePreferences =
          getAlarmIncidentRuntimePreferences(result.items);
        const itemsChanged = haveAlarmIncidentItemsChanged(
          incident.items,
          result.items,
        );
        const preferencesChanged =
          incident.notificationEnabled !==
            runtimePreferences.notificationEnabled ||
          incident.fullscreenEnabled !==
            runtimePreferences.fullscreenEnabled ||
          incident.physicalSirenEnabled !==
            runtimePreferences.physicalSirenEnabled;
        const updatedAt = Date.now();
        const updateData = {
          items: result.items,
          reasons: result.items.map(
            (item) => item.reason,
          ),
          notificationEnabled:
            runtimePreferences.notificationEnabled,
          fullscreenEnabled:
            runtimePreferences.fullscreenEnabled,
          physicalSirenEnabled:
            runtimePreferences.physicalSirenEnabled,
          updatedAt,
        };
        let updatedIncident = {
          ...incident,
          ...updateData,
        };

        if (itemsChanged || preferencesChanged) {
          await db
            .ref(
              `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
            )
            .update(updateData);
        }

        // Nếu incident đã ở cấp còi nhưng chưa từng gửi Fullscreen,
        // gửi bù ngay khi cài đặt hiện tại cho phép. Không phụ thuộc cờ cũ
        // trong incident vì cờ đó có thể đã bị chụp trước khi người dùng bật
        // Đánh thức màn hình hoặc trước khi backend được nâng cấp.
        const currentStage = String(
          incident.stage || "detected",
        ).trim();
        const shouldSendMissingFullscreen =
          runtimePreferences.fullscreenEnabled === true &&
          !Number(incident.presentationSuppressedAt || 0) &&
          !Number(incident.fullscreenSentAt || 0) &&
          (currentStage === "siren" || currentStage === "calling");

        if (shouldSendMissingFullscreen) {
          const sent = await sendAlarmStageSummary(
            receiverUid,
            result.items,
            {
              incidentId,
              stage: "siren",
              flowType: "security",
            },
          );

          if (sent) {
            const fullscreenSentAt = Date.now();

            await db
              .ref(
                `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
              )
              .update({
                fullscreenSentAt,
                updatedAt: fullscreenSentAt,
              });

            updatedIncident = {
              ...updatedIncident,
              fullscreenSentAt,
              updatedAt: fullscreenSentAt,
            };
          }
        }

        setLocalActiveAlarmIncident(
          receiverUid,
          incidentId,
          updatedIncident,
        );

        // Nguồn incident có thể đổi giữa security_mode và scheduled_alarm.
        // Đồng bộ/huỷ timer Mode ngay trong cùng lượt validate để không còn
        // báo lại theo Mode cũ sau khi nhà đã về Bình thường.
        updatedIncident =
          await ensureSecurityModeRepeatForIncident(
            receiverUid,
            incidentId,
            updatedIncident,
            { homeOverride },
          );

        return {
          ...result,
          items: result.items,
          incident: updatedIncident,
        };
      }

      const ownerUid = String(
        incident.ownerUid || receiverUid,
      ).trim();
      const homeId = String(incident.homeId || "").trim();
      const action = String(
        result.reason || reasonHint || "condition_cleared",
      ).trim();

      await resolveAlarmIncidentForReceiver({
        receiverUid,
        incidentId,
        ownerUid,
        homeId,
        resolvedBy: "safehome_backend",
        action,
      });

      console.log(
        "🧹 ALARM INCIDENT AUTO RESOLVED:",
        receiverUid,
        incidentId,
        ownerUid,
        homeId,
        action,
      );

      return {
        active: false,
        items: [],
        reason: action,
      };
    } catch (error) {
      console.log(
        "ALARM INCIDENT VALIDATION ERROR:",
        receiverUid,
        incidentId,
        error.message,
      );

      // Khi không kiểm tra được, giữ incident thay vì bỏ Alarm thật.
      return {
        active: true,
        items: normalizeAlarmIncidentItems(
          incident?.items,
        ),
      };
    }
  })();

  alarmIncidentValidationPromiseMap.set(
    lockKey,
    validationPromise,
  );

  try {
    return await validationPromise;
  } finally {
    if (
      alarmIncidentValidationPromiseMap.get(lockKey) ===
      validationPromise
    ) {
      alarmIncidentValidationPromiseMap.delete(lockKey);
    }
  }
}

async function loadActiveSecurityIncidentForReceiver(
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
  const localKey = getLocalActiveAlarmIncidentKey(
    receiverUid,
    targetKey,
  );
  const localActive =
    localActiveAlarmIncidentMap.get(localKey);

  if (
    localActive?.incident?.status === "active" &&
    localActive?.incident?.flowType !== "emergency"
  ) {
    return localActive;
  }

  const account = getCachedAccountData(receiverUid);
  let incidentId = String(
    account?.activeAlarmIncidentByTarget?.[targetKey] ||
    "",
  ).trim();
  let incident = incidentId
    ? account?.alarmIncidents?.[incidentId]
    : null;

  if (
    incident?.status === "active" &&
    incident?.flowType !== "emergency"
  ) {
    const result = { incidentId, incident };
    localActiveAlarmIncidentMap.set(localKey, result);
    return result;
  }

  // Khi tài khoản đã có trong cache và không có index active,
  // không đọc Firebase thêm. Incident vừa tạo đã được ghi vào local map.
  if (account) {
    return null;
  }

  // Chỉ đọc bù trong giai đoạn cache chưa sẵn sàng.
  const incidentIdSnap = await db
    .ref(
      `accounts/${receiverUid}/activeAlarmIncidentByTarget/${targetKey}`,
    )
    .once("value");

  incidentId = String(incidentIdSnap.val() || "").trim();

  if (!incidentId) {
    return null;
  }

  const incidentSnap = await db
    .ref(
      `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
    )
    .once("value");

  incident = incidentSnap.val();

  if (
    !incident ||
    incident.status !== "active" ||
    incident.flowType === "emergency"
  ) {
    return null;
  }

  const result = { incidentId, incident };
  localActiveAlarmIncidentMap.set(localKey, result);
  return result;
}

async function validateSecurityIncidentsForHome(
  ownerUid,
  homeId,
  reasonHint,
  {
    receiverUid = "",
    homeOverride = null,
  } = {},
) {
  const receiverUids = new Set();
  const cleanReceiverUid = String(receiverUid || "").trim();

  if (cleanReceiverUid) {
    receiverUids.add(cleanReceiverUid);
  } else {
    receiverUids.add(ownerUid);

    const sharedMembers =
      sharedByHomeCache.get(homeId) || {};

    for (const sharedUid of Object.keys(sharedMembers)) {
      const cleanUid = String(sharedUid || "").trim();

      if (cleanUid) {
        receiverUids.add(cleanUid);
      }
    }
  }

  for (const targetReceiverUid of receiverUids) {
    try {
      const active =
        await loadActiveSecurityIncidentForReceiver(
          targetReceiverUid,
          ownerUid,
          homeId,
        );

      if (!active) {
        continue;
      }

      await validateAndResolveSecurityIncident(
        targetReceiverUid,
        active.incidentId,
        active.incident,
        {
          homeOverride,
          reasonHint,
        },
      );
    } catch (error) {
      console.log(
        "HOME INCIDENT VALIDATION ERROR:",
        targetReceiverUid,
        ownerUid,
        homeId,
        error.message,
      );
    }
  }
}

function queueSecurityIncidentValidationForHome(
  ownerUid,
  homeId,
  reasonHint,
  {
    receiverUid = "",
    delayMs = 250,
  } = {},
) {
  const key = [
    ownerUid,
    homeId,
    receiverUid || "all",
  ].join("|");
  const oldTimer = alarmHomeValidationTimerMap.get(key);

  if (oldTimer) {
    clearTimeout(oldTimer);
  }

  const timer = setTimeout(() => {
    alarmHomeValidationTimerMap.delete(key);

    void validateSecurityIncidentsForHome(
      ownerUid,
      homeId,
      reasonHint,
      { receiverUid },
    );
  }, Math.max(0, delayMs));

  alarmHomeValidationTimerMap.set(key, timer);
}

function getOwnedHomeAlarmControlSignature(home) {
  const deviceAlarms = {};

  for (const [deviceId, device] of Object.entries(
    home?.devices || {},
  )) {
    if (device?.alarmSchedules) {
      deviceAlarms[deviceId] = {
        alarmSchedules: device.alarmSchedules,
      };
    }
  }

  return JSON.stringify({
    securityMode: normalizeHomeSecurityMode(
      home?.securityMode,
    ),
    securityModeRepeatMinutes:
      normalizeSecurityModeRepeatMinutes(
        home?.securityModeRepeatMinutes,
      ),
    alarmPauseToday: home?.alarmPauseToday || null,
    deviceAlarms,
  });
}

function getReceiverHomeAlarmControlSignature(
  account,
  homeId,
) {
  const customHome = account?.customRules?.[homeId] || {};
  const customDeviceAlarmControls = {};

  for (const [deviceId, deviceRule] of Object.entries(
    customHome?.devices || {},
  )) {
    if (
      deviceRule?.alarmSchedules ||
      deviceRule?.alarmPreferences
    ) {
      customDeviceAlarmControls[deviceId] = {
        alarmSchedules: deviceRule?.alarmSchedules || null,
        alarmPreferences: deviceRule?.alarmPreferences || null,
      };
    }
  }

  return JSON.stringify({
    customDeviceAlarmControls,
  });
}

function queueScheduledAlarmConfigurationRefresh(
  reason = "configuration_changed",
) {
  if (scheduledAlarmConfigurationRefreshTimer) {
    clearTimeout(scheduledAlarmConfigurationRefreshTimer);
  }

  scheduledAlarmConfigurationRefreshTimer = setTimeout(() => {
    scheduledAlarmConfigurationRefreshTimer = null;

    if (!firebaseConnected) {
      return;
    }

    void checkScheduledAlarms().catch((error) => {
      console.log(
        "SCHEDULED ALARM CONFIG REFRESH ERROR:",
        reason,
        error.message,
      );
    });
  }, 400);
}

async function handleAlarmRelevantAccountChange(
  uid,
  previousAccount,
  nextAccount,
) {
  try {
    const previousHomes = previousAccount?.homes || {};
    const nextHomes = nextAccount?.homes || {};
    const ownedHomeIds = new Set([
      ...Object.keys(previousHomes),
      ...Object.keys(nextHomes),
    ]);

    for (const homeId of ownedHomeIds) {
      const previousSignature =
        getOwnedHomeAlarmControlSignature(
          previousHomes[homeId],
        );
      const nextSignature =
        getOwnedHomeAlarmControlSignature(
          nextHomes[homeId],
        );

      if (previousSignature !== nextSignature) {
        queueSecurityIncidentValidationForHome(
          uid,
          homeId,
          "home_alarm_control_changed",
        );
        queueScheduledAlarmConfigurationRefresh(
          "home_alarm_control_changed",
        );
      }

      const previousRepeatMinutes =
        normalizeSecurityModeRepeatMinutes(
          previousHomes[homeId]?.securityModeRepeatMinutes,
        );
      const nextRepeatMinutes =
        normalizeSecurityModeRepeatMinutes(
          nextHomes[homeId]?.securityModeRepeatMinutes,
        );

      if (previousRepeatMinutes !== nextRepeatMinutes) {
        await syncSecurityModeRepeatForHome(
          uid,
          homeId,
          nextHomes[homeId] || null,
        );
      }
    }

    const receiverHomeIds = new Set([
      ...Object.keys(previousAccount?.alarmSettings || {}),
      ...Object.keys(nextAccount?.alarmSettings || {}),
      ...Object.keys(previousAccount?.customRules || {}),
      ...Object.keys(nextAccount?.customRules || {}),
      ...Object.keys(previousAccount?.sharedHomes || {}),
      ...Object.keys(nextAccount?.sharedHomes || {}),
    ]);

    for (const homeId of receiverHomeIds) {
      const previousSignature =
        getReceiverHomeAlarmControlSignature(
          previousAccount,
          homeId,
        );
      const nextSignature =
        getReceiverHomeAlarmControlSignature(
          nextAccount,
          homeId,
        );

      if (previousSignature === nextSignature) {
        continue;
      }

      const ownerUid = String(
        nextAccount?.sharedHomes?.[homeId]?.ownerUid ||
        previousAccount?.sharedHomes?.[homeId]?.ownerUid ||
        (nextAccount?.homes?.[homeId] ||
        previousAccount?.homes?.[homeId]
          ? uid
          : ""),
      ).trim();

      if (!ownerUid) {
        continue;
      }

      queueSecurityIncidentValidationForHome(
        ownerUid,
        homeId,
        "receiver_alarm_control_changed",
        { receiverUid: uid },
      );
      queueScheduledAlarmConfigurationRefresh(
        "receiver_alarm_control_changed",
      );
    }
  } catch (error) {
    console.log(
      "ACCOUNT ALARM CONTROL CHANGE ERROR:",
      uid,
      error.message,
    );
  }
}

async function runAlarmIncidentWatchdog() {
  try {
    let checked = 0;
    const accounts = getCachedAccountsObject();

    for (const [receiverUid, account] of Object.entries(accounts)) {
      const incidents = account?.alarmIncidents || {};

      for (const [incidentId, incident] of Object.entries(incidents)) {
        if (
          incident?.status !== "active" ||
          incident?.flowType === "emergency"
        ) {
          continue;
        }

        checked++;

        await validateAndResolveSecurityIncident(
          receiverUid,
          incidentId,
          incident,
          { reasonHint: "watchdog_validation" },
        );
      }
    }

    if (checked > 0) {
      console.log(
        "🧭 ALARM INCIDENT WATCHDOG:",
        `checked=${checked}`,
      );
    }
  } catch (error) {
    console.log(
      "ALARM INCIDENT WATCHDOG ERROR:",
      error.message,
    );
  }
}

function startAlarmIncidentWatchdog() {
  if (alarmIncidentWatchdogTimer) {
    return;
  }

  alarmIncidentWatchdogTimer = setInterval(
    () => {
      void runAlarmIncidentWatchdog();
    },
    ALARM_INCIDENT_WATCHDOG_INTERVAL_MS,
  );

  console.log(
    "🧭 ALARM INCIDENT WATCHDOG STARTED:",
    `interval=${ALARM_INCIDENT_WATCHDOG_INTERVAL_MS / 1000}s`,
  );
}







async function isAlarmItemAllowedByCurrentHomeMode(item) {
  const ownerUid = String(
    item?.ownerUid || "",
  ).trim();
  const homeId = String(
    item?.homeId || "",
  ).trim();

  if (!ownerUid || !homeId) {
    // Thiếu định danh: không tự chặn một Alarm thật.
    return true;
  }

  const listenerMode = getKnownSecurityMode(ownerUid, homeId);

  if (listenerMode === "unprotected") {
    return false;
  }

  const cachedHome = getCachedHomeData(ownerUid, homeId);

  if (
    cachedHome &&
    normalizeHomeSecurityMode(cachedHome.securityMode) === "unprotected"
  ) {
    return false;
  }

  if (!firebaseConnected) {
    return true;
  }

  try {
    // Đọc trực tiếp Mode ở điểm gửi cuối để không dùng snapshot cache cũ
    // trong đúng khoảnh khắc người dùng vừa chuyển sang Không bảo vệ.
    const modeSnap = await db
      .ref(`accounts/${ownerUid}/homes/${homeId}/securityMode`)
      .once("value");

    return normalizeHomeSecurityMode(
      modeSnap.val(),
    ) !== "unprotected";
  } catch (error) {
    console.log(
      "ALARM HOME MODE CHECK ERROR:",
      ownerUid,
      homeId,
      error.message,
    );

    // Mất kết nối Firebase: fail-open để không bỏ sót Alarm thật.
    return true;
  }
}

async function sendAlarmStageSummary(
  uid,
  items,
  {
    incidentId = "",
    stage = "alarm",
    flowType = "security",
  } = {},
) {
  try {
    let uniqueItems = normalizeAlarmIncidentItems(items);

    if (uniqueItems.length === 0) {
      return false;
    }

    const isEmergency = flowType === "emergency";

    // Notification Alarm có thể được gửi lại sau 15/30/60 phút. Trước mỗi
    // lần gửi phải đối chiếu incident hiện tại và chỉ giữ đúng những điều
    // kiện vẫn còn nguy hiểm. Không dùng lại danh sách đã chụp ở lần
    // Fullscreen trước vì một cửa/khóa có thể đã được xử lý trong lúc
    // incident của Home vẫn còn active do điều kiện khác.
    if (!isEmergency && stage === "alarm" && incidentId) {
      const incidentRef = db.ref(
        `accounts/${uid}/alarmIncidents/${incidentId}`,
      );
      const incidentSnap = await incidentRef.once("value");
      const currentIncident = incidentSnap.val();

      if (!currentIncident || currentIncident.status !== "active") {
        return false;
      }

      const validation = await validateAndResolveSecurityIncident(
        uid,
        incidentId,
        currentIncident,
        { reasonHint: "before_alarm_notification_delivery" },
      );

      if (!validation.active) {
        return false;
      }

      uniqueItems = filterCurrentSecurityAlarmDeliveryItems(
        uniqueItems,
        validation.items,
      );

      if (uniqueItems.length === 0) {
        console.log(
          "🔕 ALARM NOTIFICATION SKIPPED, CONDITION CLEARED:",
          uid,
          incidentId,
        );
        return false;
      }
    }

    const allowedItems = [];

    for (const item of uniqueItems) {
      // Emergency bỏ qua lịch/Pause nhưng vẫn phải tôn trọng Mode
      // Không bảo vệ, kể cả khi Mode đổi đúng lúc incident đang advance.
      if (isEmergency) {
        if (await isAlarmItemAllowedByCurrentHomeMode(item)) {
          allowedItems.push(item);
        }
        continue;
      }

      const enabled = await canReceiveAlarm(
        uid,
        item.homeId,
        item.ownerUid || uid,
        {
          respectPause:
            isScheduledAlarmSource(
              item.alarmSource || "scheduled_alarm",
            ),
        },
      );

      if (enabled) {
        allowedItems.push(item);
      }
    }

    if (allowedItems.length === 0) {
      console.log(
        "🔕 ALARM INCIDENT MUTED:",
        uid,
        incidentId,
        stage,
      );
      return false;
    }

    const lines = getAlarmIncidentLines(allowedItems);
    const body = lines.join("\n");

    let type = "alarm";
    let title = "🚨 MAIYEN";
    let clickAction = "alarm_SCREEN";
    let apnsSound = "default";

    if (
      isEmergency &&
      stage === "notification"
    ) {
      type = "emergency_notification";
      title = getEmergencyIncidentTitle(allowedItems);
      clickAction = "emergency_NOTIFICATION";
      apnsSound = "default";
    } else if (
      isEmergency &&
      stage === "fullscreen_siren"
    ) {
      type = "alarm_siren";
      title = getEmergencyIncidentTitle(allowedItems);
      clickAction = "alarm_SIREN_SCREEN";
      apnsSound = "default";
    } else if (stage === "detected") {
      type = "alarm_detected";
      title = "MaiYen phát hiện bất thường";
      clickAction = "alarm_detected";
      apnsSound = null;
    } else if (stage === "siren") {
      type = "alarm_siren";
      title = "🚨 CẢNH BÁO KHẨN CẤP";
      clickAction = "alarm_SIREN_SCREEN";
      apnsSound = "default";
    }

    // Incident được nhóm theo từng nhà, nên dù có nhiều sensor
    // thì homeId/ownerUid vẫn phải luôn có để app xác nhận đúng sự cố.
    const incidentHomeId = String(
      allowedItems[0]?.homeId || "",
    );

    const incidentOwnerUid = String(
      allowedItems[0]?.ownerUid || "",
    );

    const payloadItems = allowedItems.map((item) => ({
      ...item,
      incidentId: String(incidentId || ""),
      eventCategory: getStandardIncidentEventCategory(flowType),
      alarmLevel: getStandardIncidentAlarmLevel(flowType),
    }));
    const sentAt = Date.now();
    const alarmDeliveryId = getMaiYenAlarmDeliveryId({
      uid,
      incidentId,
      stage,
      flowType,
      items: payloadItems,
    });
    const androidCollapseKey = getMaiYenAndroidAlarmCollapseKey({
      uid,
      incidentId,
      homeId: incidentHomeId,
      flowType,
    });

    const message = {
      data: {
        type,
        title,
        body,
        alarmItems: JSON.stringify(payloadItems),
        incidentId: String(incidentId || ""),
        receiverUid: String(uid || ""),
        alarmStage: stage,
        alarmFlowType: flowType,
        incidentSchemaVersion: String(ALARM_INCIDENT_SCHEMA_VERSION),
        eventCategory: getStandardIncidentEventCategory(flowType),
        alarmLevel: getStandardIncidentAlarmLevel(flowType),
        incidentStatus: "active",
        homeId: incidentHomeId,
        ownerUid: incidentOwnerUid,
        alarmDeliveryId,
        sentAt: String(sentAt),
        clickAction,
      },
      android: {
        priority: "high",
        collapseKey: androidCollapseKey,
      },
      apns: buildMaiYenAlarmApnsConfig({
        uid,
        incidentId,
        homeId: incidentHomeId,
        flowType,
        stage,
        title,
        body,
        playSound: Boolean(apnsSound),
      }),
    };

    const pushResult = await sendPushToUser(
      uid,
      message,
      `ALARM INCIDENT ${flowType}/${stage}`,
    );

    if (pushResult.sent === 0) {
      return false;
    }

    console.log(
      "🚨 ALARM INCIDENT PUSH:",
      uid,
      incidentId,
      flowType,
      stage,
      allowedItems.length,
      `devices=${pushResult.sent}`,
    );

    return true;
  } catch (err) {
    console.log(
      "ALARM INCIDENT PUSH ERROR:",
      uid,
      incidentId,
      flowType,
      stage,
      err.message,
    );
    return false;
  }
}

async function sendAlarmResolvedPush({
  uid,
  incidentId,
  homeId,
  resolvedBy,
  action,
  flowType = "security",
  status = "resolved",
  hasRemainingActiveIncidents = false,
}) {
  try {
    const sentAt = Date.now();
    const androidCollapseKey = getMaiYenAndroidAlarmCollapseKey({
      uid,
      incidentId,
      homeId,
      flowType,
    });

    await sendPushToUser(
      uid,
      {
        data: {
          type: "alarm_resolved",
          incidentId: String(incidentId || ""),
          homeId: String(homeId || ""),
          resolvedBy: String(resolvedBy || ""),
          action: String(action || "resolved"),
          resolutionAction: String(action || "resolved"),
          resolutionType: getIncidentResolutionType(resolvedBy),
          incidentSchemaVersion: String(ALARM_INCIDENT_SCHEMA_VERSION),
          eventCategory: getStandardIncidentEventCategory(flowType),
          alarmLevel: getStandardIncidentAlarmLevel(flowType),
          incidentStatus: String(status || "resolved"),
          hasRemainingActiveIncidents: String(
            hasRemainingActiveIncidents === true,
          ),
          alarmDeliveryId: getMaiYenAlarmDeliveryId({
            uid,
            incidentId,
            stage: "resolved",
            flowType,
            items: [],
          }),
          sentAt: String(sentAt),
          clickAction: "alarm_RESOLVED",
        },
        android: {
          priority: "high",
          collapseKey: androidCollapseKey,
        },
        apns: {
          headers: {
            "apns-priority": "5",
            "apns-push-type": "background",
            "apns-collapse-id": getMaiYenIosAlarmCollapseId({
              uid,
              incidentId,
              homeId,
              flowType,
            }),
          },
          payload: {
            aps: {
              "content-available": 1,
            },
          },
        },
      },
      "ALARM RESOLVED",
    );
  } catch (err) {
    console.log(
      "ALARM RESOLVED PUSH ERROR:",
      uid,
      incidentId,
      err.message,
    );
  }
}



function isEmergencyIncidentItemStillUnsafe(
  home,
  item,
) {
  const context = getIncidentDeviceContext(home, item);

  if (!context) {
    return null;
  }

  const device = context.device || {};
  const type = String(
    item?.type || device.type || "",
  ).trim();
  const reason = String(item?.reason || "")
    .trim()
    .toLowerCase();

  if (
    reason.includes("bị tháo") ||
    reason.includes("tamper") ||
    reason.includes("cạy")
  ) {
    return device.tamper === true;
  }

  if (type === "smoke") {
    return isActiveSignal(device.smoke);
  }

  if (type === "heat") {
    return (
      isActiveSignal(device.heat) ||
      isActiveSignal(device.heat_alarm) ||
      isActiveSignal(
        device.high_temperature_alarm,
      )
    );
  }

  if (type === "carbon_monoxide") {
    return (
      isActiveSignal(device.carbon_monoxide) ||
      isActiveSignal(device.co_alarm)
    );
  }

  if (type === "gas") {
    return (
      isActiveSignal(device.gas) ||
      isActiveSignal(device.gas_alarm)
    );
  }

  if (
    type === "water_leak" ||
    type === "flood"
  ) {
    return (
      isActiveSignal(device.water_leak) ||
      isActiveSignal(device.leak) ||
      isActiveSignal(device.water)
    );
  }

  return false;
}

async function evaluatePersistentEmergencyIncident(
  incident,
  {
    homeOverride = null,
    forceDatabase = false,
  } = {},
) {
  const items = normalizeAlarmIncidentItems(
    incident?.items,
  );
  const persistentItems = items.filter(
    isPersistentEmergencyIncidentItem,
  );

  if (persistentItems.length === 0) {
    return {
      hasPersistentItems: false,
      activeItems: [],
      unknownItems: [],
    };
  }

  const ownerUid = String(
    incident?.ownerUid || "",
  ).trim();
  const homeId = String(
    incident?.homeId || "",
  ).trim();

  let home = homeOverride;

  if (!home && !forceDatabase) {
    home = getCachedHomeData(ownerUid, homeId);
  }

  if ((!home || forceDatabase) && ownerUid && homeId) {
    try {
      const homeSnap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}`)
        .once("value");
      home = homeSnap.val();
    } catch (_) { }
  }

  if (!home) {
    return {
      hasPersistentItems: true,
      activeItems: [],
      unknownItems: persistentItems,
    };
  }

  const activeItems = [];
  const unknownItems = [];

  for (const item of persistentItems) {
    const unsafe = isEmergencyIncidentItemStillUnsafe(
      home,
      item,
    );

    if (unsafe === true) {
      activeItems.push(item);
    } else if (unsafe === null) {
      unknownItems.push(item);
    }
  }

  return {
    hasPersistentItems: true,
    activeItems,
    unknownItems,
  };
}

// Đồng bộ ngay các incident Emergency duy trì (khói/CO/gas/ngập...) khi
// sensor trở lại an toàn. Nhờ vậy còi vật lý và fullscreen Alarm không phải
// chờ tới mốc auto-expire 30 phút mới được dừng.
async function resolveClearedPersistentEmergencyIncidents(
  ownerUid,
  homeId,
  {
    homeOverride = null,
    reason = "persistent_emergency_cleared",
  } = {},
) {
  const receiverUids = getAlarmReceiverUidsForHome(
    ownerUid,
    homeId,
  );

  for (const receiverUid of receiverUids) {
    const incidentsSnap = await db
      .ref(`accounts/${receiverUid}/alarmIncidents`)
      .once("value");
    const incidents = incidentsSnap.val() || {};

    for (const [incidentId, incident] of Object.entries(incidents)) {
      if (
        incident?.status !== "active" ||
        incident?.flowType !== "emergency" ||
        String(incident?.ownerUid || "").trim() !==
          String(ownerUid || "").trim() ||
        String(incident?.homeId || "").trim() !==
          String(homeId || "").trim()
      ) {
        continue;
      }

      const allItems = normalizeAlarmIncidentItems(
        incident.items,
      );
      const nonPersistentItems = allItems.filter((item) => {
        return !isPersistentEmergencyIncidentItem(item);
      });
      const validation = await evaluatePersistentEmergencyIncident(
        incident,
        {
          homeOverride,
          forceDatabase: !homeOverride,
        },
      );

      if (!validation.hasPersistentItems) {
        continue;
      }

      const keptItems = normalizeAlarmIncidentItems([
        ...nonPersistentItems,
        ...validation.activeItems,
        ...validation.unknownItems,
      ]);

      if (keptItems.length === 0) {
        await resolveAlarmIncidentForReceiver({
          receiverUid,
          incidentId,
          ownerUid: String(ownerUid || ""),
          homeId: String(homeId || ""),
          resolvedBy: "safehome_backend",
          action: reason,
        });
        continue;
      }

      if (JSON.stringify(keptItems) !== JSON.stringify(allItems)) {
        const now = Date.now();

        await db
          .ref(`accounts/${receiverUid}/alarmIncidents/${incidentId}`)
          .update({
            items: keptItems,
            reasons: keptItems.map((item) => item.reason),
            updatedAt: now,
          });

        setLocalActiveAlarmIncident(
          receiverUid,
          incidentId,
          {
            ...incident,
            items: keptItems,
            reasons: keptItems.map((item) => item.reason),
            updatedAt: now,
          },
        );
      }
    }
  }
}

async function expireAlarmIncident(
  receiverUid,
  incidentId,
) {
  try {
    const incidentRef = db.ref(
      `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
    );

    const snap = await incidentRef.once("value");
    const incident = snap.val();

    if (!incident || incident.status !== "active") {
      clearAlarmIncidentTimers(receiverUid, incidentId);
      return;
    }

    const targetKey = String(
      incident.targetKey || "",
    ).trim();

    // Incident an ninh chỉ kết thúc khi điều kiện thực tế đã hết,
    // Mode/lịch không còn hiệu lực hoặc người dùng xử lý. Không để
    // auto-expire tạo incident mới trong khi cùng một cửa vẫn đang mở.
    if (incident.flowType !== "emergency") {
      const validation =
        await validateAndResolveSecurityIncident(
          receiverUid,
          incidentId,
          incident,
          { reasonHint: "auto_expire_validation" },
        );

      if (!validation.active) {
        return;
      }

      const now = Date.now();
      const nextExpireAt =
        now + ALARM_INCIDENT_AUTO_EXPIRE_MS;

      await incidentRef.update({
        items: validation.items,
        reasons: validation.items.map(
          (item) => item.reason,
        ),
        expireAt: nextExpireAt,
        updatedAt: now,
      });

      const key = getAlarmIncidentTimerKey(
        receiverUid,
        incidentId,
      );
      const timers = alarmIncidentTimerMap[key] || {};

      if (timers.expire) {
        clearTimeout(timers.expire);
      }

      timers.expire = setTimeout(
        () => {
          void expireAlarmIncident(
            receiverUid,
            incidentId,
          );
        },
        ALARM_INCIDENT_AUTO_EXPIRE_MS,
      );

      alarmIncidentTimerMap[key] = timers;

      setLocalActiveAlarmIncident(
        receiverUid,
        incidentId,
        {
          ...incident,
          items: validation.items,
          reasons: validation.items.map(
            (item) => item.reason,
          ),
          expireAt: nextExpireAt,
          updatedAt: now,
        },
      );

      console.log(
        "⏳ SECURITY INCIDENT KEPT ACTIVE:",
        receiverUid,
        incidentId,
      );
      return;
    }

    const emergencyValidation =
      await evaluatePersistentEmergencyIncident(
        incident,
      );

    if (
      emergencyValidation.hasPersistentItems &&
      (
        emergencyValidation.activeItems.length > 0 ||
        emergencyValidation.unknownItems.length > 0
      )
    ) {
      const keptItems = normalizeAlarmIncidentItems([
        ...emergencyValidation.activeItems,
        ...emergencyValidation.unknownItems,
      ]);
      const now = Date.now();
      const nextExpireAt =
        now + ALARM_INCIDENT_AUTO_EXPIRE_MS;

      await incidentRef.update({
        items: keptItems,
        reasons: keptItems.map(
          (item) => item.reason,
        ),
        expireAt: nextExpireAt,
        updatedAt: now,
      });

      const key = getAlarmIncidentTimerKey(
        receiverUid,
        incidentId,
      );
      const timers = alarmIncidentTimerMap[key] || {};

      if (timers.expire) {
        clearTimeout(timers.expire);
      }

      timers.expire = setTimeout(
        () => {
          void expireAlarmIncident(
            receiverUid,
            incidentId,
          );
        },
        ALARM_INCIDENT_AUTO_EXPIRE_MS,
      );

      alarmIncidentTimerMap[key] = timers;

      console.log(
        "⏳ EMERGENCY INCIDENT KEPT ACTIVE:",
        receiverUid,
        incidentId,
        `active=${emergencyValidation.activeItems.length}`,
        `unknown=${emergencyValidation.unknownItems.length}`,
      );
      return;
    }

    if (
      emergencyValidation.hasPersistentItems &&
      emergencyValidation.activeItems.length === 0 &&
      emergencyValidation.unknownItems.length === 0
    ) {
      await resolveAlarmIncidentForReceiver({
        receiverUid,
        incidentId,
        ownerUid: String(
          incident.ownerUid || receiverUid,
        ),
        homeId: String(incident.homeId || ""),
        resolvedBy: "safehome_backend",
        action: "emergency_condition_cleared",
      });
      return;
    }

    // SOS và các event tức thời không có trạng thái duy trì sẽ hết hạn
    // theo thời gian như cũ.
    const flowType = String(
      incident.flowType || incident.eventCategory || "emergency",
    ) === "emergency"
      ? "emergency"
      : "security";
    const updates = {
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/schemaVersion`]:
        ALARM_INCIDENT_SCHEMA_VERSION,
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/eventCategory`]:
        getStandardIncidentEventCategory(flowType),
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/alarmLevel`]:
        getStandardIncidentAlarmLevel(flowType),
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/severity`]:
        getLegacyIncidentSeverity(flowType),
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/statusReason`]:
        "auto_expired",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/resolutionAction`]:
        "auto_expired",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/resolutionType`]:
        "automatic",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/status`]:
        "expired",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/stage`]:
        "expired",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/expiredAt`]:
        Date.now(),
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/updatedAt`]:
        Date.now(),
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/homeSirenStatus`]:
        "stop_requested",
    };

    if (targetKey) {
      updates[
        `accounts/${receiverUid}/activeAlarmIncidentByTarget/${targetKey}`
      ] = null;
    }

    await db.ref().update(updates);

    await reconcilePhysicalSirenForHome(
      String(incident.ownerUid || receiverUid),
      String(incident.homeId || ""),
      {
        useDatabase: true,
        reason: "incident_expired",
      },
    );

    removeLocalActiveAlarmIncident(
      receiverUid,
      targetKey,
    );
    const hasRemainingActiveIncidents =
      hasLocalActiveAlarmIncidentForReceiver(receiverUid);
    clearAlarmIncidentTimers(receiverUid, incidentId);

    await sendAlarmResolvedPush({
      uid: receiverUid,
      incidentId,
      homeId: String(incident.homeId || ""),
      resolvedBy: "safehome_backend",
      action: "auto_expired",
      flowType,
      status: "expired",
      hasRemainingActiveIncidents,
    });

    console.log(
      "⌛ ALARM INCIDENT EXPIRED:",
      receiverUid,
      incidentId,
    );
  } catch (err) {
    console.log(
      "ALARM INCIDENT EXPIRE ERROR:",
      receiverUid,
      incidentId,
      err.message,
    );
  }
}


function getSecurityModeItems(items) {
  return normalizeAlarmIncidentItems(items).filter((item) => {
    return String(item.alarmSource || "") === "security_mode";
  });
}

function applySecurityModeRepeatToItems(
  items,
  repeatMinutes,
) {
  const normalizedRepeat =
    normalizeSecurityModeRepeatMinutes(repeatMinutes);
  const nextAlarm = getNextAlarmTimeText(normalizedRepeat);

  return normalizeAlarmIncidentItems(items).map((item) => {
    if (String(item.alarmSource || "") !== "security_mode") {
      return item;
    }

    return {
      ...item,
      repeatMinutes: normalizedRepeat,
      nextAlarm,
    };
  });
}

function clearSecurityModeRepeatTimer(
  receiverUid,
  incidentId,
) {
  const key = getAlarmIncidentTimerKey(
    receiverUid,
    incidentId,
  );
  const timers = alarmIncidentTimerMap[key];

  if (!timers?.repeat) {
    return;
  }

  clearTimeout(timers.repeat);
  delete timers.repeat;

  if (Object.keys(timers).length === 0) {
    delete alarmIncidentTimerMap[key];
  } else {
    alarmIncidentTimerMap[key] = timers;
  }
}

function scheduleSecurityModeRepeatTimer(
  receiverUid,
  incidentId,
  incident,
) {
  clearSecurityModeRepeatTimer(receiverUid, incidentId);

  if (
    !incident ||
    incident.status !== "active" ||
    incident.flowType === "emergency" ||
    getSecurityModeItems(incident.items).length === 0
  ) {
    return;
  }

  const repeatMinutes =
    normalizeSecurityModeRepeatMinutes(
      incident.repeatMinutes,
    );
  const nextRepeatAt = Number(incident.nextRepeatAt || 0);

  if (repeatMinutes <= 0 || nextRepeatAt <= 0) {
    return;
  }

  const key = getAlarmIncidentTimerKey(
    receiverUid,
    incidentId,
  );
  const timers = alarmIncidentTimerMap[key] || {};

  timers.repeat = setTimeout(
    () => {
      void handleSecurityModeRepeatDue(
        receiverUid,
        incidentId,
      );
    },
    Math.max(0, nextRepeatAt - Date.now()),
  );

  alarmIncidentTimerMap[key] = timers;
}

async function loadHomeForSecurityModeRepeat(
  ownerUid,
  homeId,
  homeOverride = null,
) {
  if (homeOverride) {
    return homeOverride;
  }

  const cachedHome = getCachedHomeData(ownerUid, homeId);

  if (cachedHome) {
    return cachedHome;
  }

  const homeSnap = await db
    .ref(`accounts/${ownerUid}/homes/${homeId}`)
    .once("value");

  return homeSnap.val();
}

async function ensureSecurityModeRepeatForIncident(
  receiverUid,
  incidentId,
  incident,
  {
    resetFromNow = false,
    homeOverride = null,
    scheduleTimer = true,
  } = {},
) {
  if (
    !incident ||
    incident.status !== "active" ||
    incident.flowType === "emergency"
  ) {
    clearSecurityModeRepeatTimer(receiverUid, incidentId);
    return incident;
  }

  const securityItems = getSecurityModeItems(incident.items);

  if (securityItems.length === 0) {
    clearSecurityModeRepeatTimer(receiverUid, incidentId);

    const hadModeRepeat =
      normalizeSecurityModeRepeatMinutes(incident.repeatMinutes) > 0 ||
      Number(incident.nextRepeatAt || 0) > 0;

    if (!hadModeRepeat) {
      return incident;
    }

    const clearedAt = Date.now();
    const clearedIncident = {
      ...incident,
      repeatMinutes: 0,
      nextRepeatAt: null,
      repeatConfiguredAt: clearedAt,
      updatedAt: clearedAt,
    };

    await db
      .ref(
        `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
      )
      .update({
        repeatMinutes: 0,
        nextRepeatAt: null,
        repeatConfiguredAt: clearedAt,
        updatedAt: clearedAt,
      });

    setLocalActiveAlarmIncident(
      receiverUid,
      incidentId,
      clearedIncident,
    );

    return clearedIncident;
  }

  const ownerUid = String(
    incident.ownerUid || receiverUid,
  ).trim();
  const homeId = String(incident.homeId || "").trim();
  const home = await loadHomeForSecurityModeRepeat(
    ownerUid,
    homeId,
    homeOverride,
  );

  if (!home) {
    console.log(
      "SECURITY MODE REPEAT HOME UNAVAILABLE:",
      receiverUid,
      incidentId,
      ownerUid,
      homeId,
    );
    return incident;
  }

  const modeArmed =
    normalizeHomeSecurityMode(home.securityMode) === "armed";
  const repeatMinutes = modeArmed
    ? normalizeSecurityModeRepeatMinutes(
        home.securityModeRepeatMinutes,
      )
    : 0;
  const now = Date.now();
  const currentRepeatMinutes =
    normalizeSecurityModeRepeatMinutes(
      incident.repeatMinutes,
    );
  const currentNextRepeatAt = Number(
    incident.nextRepeatAt || 0,
  );
  const updatedItems = applySecurityModeRepeatToItems(
    incident.items,
    repeatMinutes,
  );

  let nextRepeatAt = null;

  if (repeatMinutes > 0) {
    const canKeepCurrentDueAt =
      !resetFromNow &&
      currentRepeatMinutes === repeatMinutes &&
      currentNextRepeatAt > 0;

    nextRepeatAt = canKeepCurrentDueAt
      ? currentNextRepeatAt
      : now + repeatMinutes * 60 * 1000;
  }

  const itemsChanged =
    JSON.stringify(updatedItems) !==
    JSON.stringify(normalizeAlarmIncidentItems(incident.items));
  const repeatChanged =
    currentRepeatMinutes !== repeatMinutes;
  const dueAtChanged =
    Number(currentNextRepeatAt || 0) !==
    Number(nextRepeatAt || 0);
  const updateData = {};

  if (itemsChanged) {
    updateData.items = updatedItems;
    updateData.reasons = updatedItems.map(
      (item) => item.reason,
    );
  }

  if (repeatChanged || dueAtChanged || resetFromNow) {
    updateData.repeatMinutes = repeatMinutes;
    updateData.nextRepeatAt = nextRepeatAt;
    updateData.repeatConfiguredAt = now;
  }

  let updatedIncident = {
    ...incident,
    items: updatedItems,
    reasons: updatedItems.map((item) => item.reason),
    repeatMinutes,
    nextRepeatAt,
  };

  if (Object.keys(updateData).length > 0) {
    updateData.updatedAt = now;

    await db
      .ref(
        `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
      )
      .update(updateData);

    updatedIncident = {
      ...updatedIncident,
      ...updateData,
    };

    setLocalActiveAlarmIncident(
      receiverUid,
      incidentId,
      updatedIncident,
    );
  }

  if (repeatMinutes > 0 && scheduleTimer) {
    scheduleSecurityModeRepeatTimer(
      receiverUid,
      incidentId,
      updatedIncident,
    );
  } else if (repeatMinutes === 0) {
    clearSecurityModeRepeatTimer(
      receiverUid,
      incidentId,
    );
  }

  return updatedIncident;
}

async function syncSecurityModeRepeatForHome(
  ownerUid,
  homeId,
  homeOverride = null,
) {
  const receiverUids = getAlarmReceiverUidsForHome(
    ownerUid,
    homeId,
  );

  for (const receiverUid of receiverUids) {
    try {
      const active =
        await loadActiveSecurityIncidentForReceiver(
          receiverUid,
          ownerUid,
          homeId,
        );

      if (!active) {
        continue;
      }

      await ensureSecurityModeRepeatForIncident(
        receiverUid,
        active.incidentId,
        active.incident,
        {
          resetFromNow: true,
          homeOverride,
        },
      );

      console.log(
        "🔁 SECURITY MODE REPEAT UPDATED:",
        receiverUid,
        ownerUid,
        homeId,
        normalizeSecurityModeRepeatMinutes(
          homeOverride?.securityModeRepeatMinutes,
        ),
      );
    } catch (error) {
      console.log(
        "SECURITY MODE REPEAT SYNC ERROR:",
        receiverUid,
        ownerUid,
        homeId,
        error.message,
      );
    }
  }
}

async function handleSecurityModeRepeatDue(
  receiverUid,
  incidentId,
) {
  const lockKey = `${receiverUid}_${incidentId}`;

  if (securityModeRepeatInProgress.has(lockKey)) {
    return;
  }

  securityModeRepeatInProgress.add(lockKey);
  clearSecurityModeRepeatTimer(receiverUid, incidentId);

  try {
    const incidentRef = db.ref(
      `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
    );
    const incidentSnap = await incidentRef.once("value");
    const incident = incidentSnap.val();

    if (!incident || incident.status !== "active") {
      return;
    }

    const validation =
      await validateAndResolveSecurityIncident(
        receiverUid,
        incidentId,
        incident,
        { reasonHint: "security_mode_repeat" },
      );

    if (!validation.active) {
      return;
    }

    let updatedIncident = {
      ...incident,
      items: validation.items,
      reasons: validation.items.map(
        (item) => item.reason,
      ),
    };

    updatedIncident =
      await ensureSecurityModeRepeatForIncident(
        receiverUid,
        incidentId,
        updatedIncident,
        { scheduleTimer: false },
      );

    const repeatMinutes =
      normalizeSecurityModeRepeatMinutes(
        updatedIncident.repeatMinutes,
      );
    const nextRepeatAt = Number(
      updatedIncident.nextRepeatAt || 0,
    );

    if (repeatMinutes <= 0 || nextRepeatAt <= 0) {
      return;
    }

    if (nextRepeatAt > Date.now() + 500) {
      scheduleSecurityModeRepeatTimer(
        receiverUid,
        incidentId,
        updatedIncident,
      );
      return;
    }

    const repeatedItems = getSecurityModeItems(
      updatedIncident.items,
    );

    if (repeatedItems.length === 0) {
      return;
    }

    // presentationSuppressedAt chỉ dùng để đóng lần hiển thị hiện tại.
    // Lịch báo lại 15/30/60 phút vẫn phải gửi notification khi
    // trạng thái nguy hiểm còn tồn tại.
    const repeatNotificationItems = repeatedItems.filter(
      (item) => item.notificationEnabled !== false,
    );
    const repeatPhysicalSirenItems = repeatedItems.filter(
      (item) => item.physicalSirenEnabled !== false,
    );
    let sent = false;

    if (repeatNotificationItems.length > 0) {
      sent = await sendAlarmStageSummary(
        receiverUid,
        repeatNotificationItems,
        {
          incidentId,
          stage: "alarm",
          flowType: "security",
        },
      );
    }

    if (repeatPhysicalSirenItems.length > 0) {
      await requestPhysicalSirenForIncident(
        receiverUid,
        incidentId,
        {
          ...updatedIncident,
          physicalSirenEnabled: true,
        },
        "security_mode_repeat",
      );
      sent = true;
    }

    const completedAt = Date.now();
    const followingRepeatAt =
      completedAt + repeatMinutes * 60 * 1000;
    const updateData = {
      items: applySecurityModeRepeatToItems(
        updatedIncident.items,
        repeatMinutes,
      ),
      nextRepeatAt: followingRepeatAt,
      lastRepeatAttemptAt: completedAt,
      updatedAt: completedAt,
    };

    updateData.reasons = updateData.items.map(
      (item) => item.reason,
    );

    if (sent) {
      updateData.lastRepeatedAt = completedAt;
      updateData.repeatCount =
        Number(updatedIncident.repeatCount || 0) + 1;
    }

    await incidentRef.update(updateData);

    updatedIncident = {
      ...updatedIncident,
      ...updateData,
    };

    setLocalActiveAlarmIncident(
      receiverUid,
      incidentId,
      updatedIncident,
    );

    scheduleSecurityModeRepeatTimer(
      receiverUid,
      incidentId,
      updatedIncident,
    );

    console.log(
      sent
        ? "🔁 SECURITY MODE ALARM REPEATED:"
        : "⚠️ SECURITY MODE REPEAT PUSH FAILED:",
      receiverUid,
      incidentId,
      `minutes=${repeatMinutes}`,
      `next=${followingRepeatAt}`,
    );
  } catch (error) {
    console.log(
      "SECURITY MODE REPEAT ERROR:",
      receiverUid,
      incidentId,
      error.message,
    );
  } finally {
    securityModeRepeatInProgress.delete(lockKey);
  }
}


async function deliverSecurityAlarmChannelsImmediately({
  uid,
  incidentId,
  incident,
  items,
  allowFullscreenRedelivery = true,
}) {
  const normalizedItems = normalizeAlarmIncidentItems(items);

  if (normalizedItems.length === 0) {
    return;
  }

  const presentationSuppressed = Number(
    incident?.presentationSuppressedAt || 0,
  ) > 0;
  const notificationItems = presentationSuppressed
    ? []
    : normalizedItems.filter(
        (item) => item.notificationEnabled !== false,
      );
  const fullscreenItems = presentationSuppressed
    ? []
    : normalizedItems.filter(
        (item) => item.fullscreenEnabled !== false,
      );
  const physicalSirenItems = normalizedItems.filter(
    (item) => item.physicalSirenEnabled !== false,
  );
  const needsSirenStage =
    fullscreenItems.length > 0 || physicalSirenItems.length > 0;
  const stageRank = Math.max(
    0,
    getSecurityIncidentStageRank(incident?.stage),
  );

  // Incident mới chưa qua cấp alarm: để Alarm Engine tiến thẳng tới cấp cao
  // nhất cần dùng. Các cấp ở giữa cũng chạy ngay và tôn trọng từng channel.
  if (stageRank < 1) {
    await advanceAlarmIncidentToStage(
      uid,
      incidentId,
      needsSirenStage ? "siren" : "alarm",
    );
    return;
  }

  // Incident đã qua cấp alarm: notification mới/lặp phải được gửi riêng,
  // không chờ hoặc phụ thuộc vào trạng thái còi/fullscreen hiện tại.
  if (notificationItems.length > 0) {
    const sent = await sendAlarmStageSummary(
      uid,
      notificationItems,
      {
        incidentId,
        stage: "alarm",
        flowType: "security",
      },
    );

    if (!sent) {
      scheduleInitialAlarmIncidentPushRetry(
        uid,
        incidentId,
        "alarm",
        "security",
      );
    }
  }

  if (!needsSirenStage) {
    return;
  }

  // Nếu incident chưa qua cấp siren, advance một lần sẽ vừa bật còi vật lý
  // vừa gửi fullscreen theo đúng cấu hình đã hợp nhất.
  if (stageRank < 2) {
    await advanceAlarmIncidentToStage(
      uid,
      incidentId,
      "siren",
    );
    return;
  }

  // Incident đã ở cấp siren: lặp lại đúng các channel được chọn mà không
  // hạ stage hoặc tạo incident mới.
  if (physicalSirenItems.length > 0) {
    await requestPhysicalSirenForIncident(
      uid,
      incidentId,
      {
        ...incident,
        physicalSirenEnabled: true,
      },
      "security_schedule_immediate_delivery",
    );
  }

  const fullscreenAlreadySent =
    Number(incident?.fullscreenSentAt || 0) > 0;

  if (
    fullscreenItems.length > 0 &&
    (!fullscreenAlreadySent || allowFullscreenRedelivery)
  ) {
    const sent = await sendAlarmStageSummary(
      uid,
      fullscreenItems,
      {
        incidentId,
        stage: "siren",
        flowType: "security",
      },
    );

    if (!sent) {
      scheduleInitialAlarmIncidentPushRetry(
        uid,
        incidentId,
        "siren",
        "security",
      );
    } else if (!fullscreenAlreadySent) {
      const fullscreenSentAt = Date.now();

      await db
        .ref(`accounts/${uid}/alarmIncidents/${incidentId}`)
        .update({
          fullscreenSentAt,
          updatedAt: fullscreenSentAt,
        });

      setLocalActiveAlarmIncident(
        uid,
        incidentId,
        {
          ...incident,
          fullscreenSentAt,
          updatedAt: fullscreenSentAt,
        },
      );
    }
  }
}

async function startOrMergeAlarmIncidents(...args) {
  if (!alarmIncidentPersistenceDomain) {
    throw new Error("Alarm Incident Persistence not initialized");
  }

  return alarmIncidentPersistenceDomain.startOrMergeAlarmIncidents(
    ...args
  );
}

async function resumeActiveAlarmIncidents(...args) {
  if (!alarmIncidentPersistenceDomain) {
    throw new Error("Alarm Incident Persistence not initialized");
  }

  return alarmIncidentPersistenceDomain.resumeActiveAlarmIncidents(
    ...args
  );
}

async function resolveAlarmIncidentForReceiver(...args) {
  if (!alarmIncidentPersistenceDomain) {
    throw new Error("Alarm Incident Persistence not initialized");
  }

  return alarmIncidentPersistenceDomain.resolveAlarmIncidentForReceiver(
    ...args
  );
}

async function resolveAlarmIncidentGroupForHome(...args) {
  if (!alarmIncidentPersistenceDomain) {
    throw new Error("Alarm Incident Persistence not initialized");
  }

  return alarmIncidentPersistenceDomain.resolveAlarmIncidentGroupForHome(
    ...args
  );
}

async function acknowledgeAlarmIncidentForReceiver({
  receiverUid,
  incidentId,
  acknowledgedBy,
}) {
  const cleanReceiverUid = String(receiverUid || "").trim();
  const cleanIncidentId = String(incidentId || "").trim();
  const cleanAcknowledgedBy = String(acknowledgedBy || "").trim();

  if (
    !cleanReceiverUid ||
    !cleanIncidentId ||
    cleanAcknowledgedBy !== cleanReceiverUid
  ) {
    return false;
  }

  const incidentRef = db.ref(
    `accounts/${cleanReceiverUid}/alarmIncidents/${cleanIncidentId}`,
  );
  const incidentSnap = await incidentRef.once("value");
  const incident = incidentSnap.val();

  if (!incident || incident.status !== "active") {
    return false;
  }

  const acknowledgedAt = Date.now();
  const items = normalizeAlarmIncidentItems(incident.items);
  const ownerUid = String(incident.ownerUid || "").trim();
  const homeId = String(incident.homeId || "").trim();
  const flowType = String(
    incident.flowType || incident.eventCategory || "security",
  ) === "emergency"
    ? "emergency"
    : "security";
  const repeatMinutes =
    flowType === "security"
      ? normalizeSecurityModeRepeatMinutes(incident.repeatMinutes)
      : 0;
  const currentNextRepeatAt = Number(incident.nextRepeatAt || 0);
  const nextRepeatAt =
    repeatMinutes > 0
      ? (currentNextRepeatAt > acknowledgedAt
          ? currentNextRepeatAt
          : acknowledgedAt + repeatMinutes * 60 * 1000)
      : null;
  const updateData = {
    presentationSuppressedAt: acknowledgedAt,
    presentationSuppressedBy: cleanAcknowledgedBy,
    lastCheckedAt: acknowledgedAt,
    lastCheckedBy: cleanAcknowledgedBy,
    nextRepeatAt,
    updatedAt: acknowledgedAt,
  };

  await incidentRef.update(updateData);

  await markAlarmItemsAcknowledged(
    cleanReceiverUid,
    items,
    cleanAcknowledgedBy,
    acknowledgedAt,
  );

  const updatedIncident = {
    ...incident,
    ...updateData,
  };

  if (repeatMinutes > 0 && nextRepeatAt) {
    scheduleSecurityModeRepeatTimer(
      cleanReceiverUid,
      cleanIncidentId,
      updatedIncident,
    );
  } else {
    clearSecurityModeRepeatTimer(
      cleanReceiverUid,
      cleanIncidentId,
    );
  }

  setLocalActiveAlarmIncident(
    cleanReceiverUid,
    cleanIncidentId,
    updatedIncident,
  );

  await sendAlarmResolvedPush({
    uid: cleanReceiverUid,
    incidentId: cleanIncidentId,
    homeId,
    resolvedBy: cleanAcknowledgedBy,
    action: "check_home",
    flowType,
    status: "acknowledged",
    hasRemainingActiveIncidents: true,
  });

  console.log(
    "👀 ALARM INCIDENT ACKNOWLEDGED FOR RECEIVER:",
    cleanReceiverUid,
    cleanIncidentId,
    ownerUid,
    homeId,
  );

  return true;
}

function queueEventAlarm(uid, item) {
  if (!firebaseConnected) {
    registerOfflineAlarmDemand(uid, item);
    enqueueOfflineAlarmItem(uid, item);
    return;
  }

  // Không gom chờ 1,2 giây: sự kiện an ninh hợp lệ được đưa thẳng vào
  // Alarm Engine. startOrMergeAlarmIncidents đã có khóa chống chạy song song.
  void startOrMergeAlarmIncidents(
    uid,
    [item],
  ).catch((error) => {
    console.log(
      "ALARM INCIDENT START ERROR:",
      uid,
      error.message,
    );
    registerOfflineAlarmDemand(uid, item);
    enqueueOfflineAlarmItem(uid, item);
  });
}


async function cleanupExpiredAlarmPause() {
  try {
    const accounts = getCachedAccountsObject();
    const now = Date.now();

    for (const [uid, user] of Object.entries(accounts)) {
      const homes = user.homes || {};

      for (const [homeId, home] of Object.entries(homes)) {
        const pause = home.alarmPauseToday;

        if (!pause) continue;

        const { startAt, endAt } = resolveAlarmPauseTimeRange(pause);

        if (startAt > 0 && endAt > startAt) {
          if (now < endAt) {
            scheduleAlarmPauseExpiry(uid, homeId, pause);
            continue;
          }

          if (now >= endAt) {
            const sharedSnap = await db
              .ref(`sharedByHome/${homeId}`)
              .once("value");

            const sharedUsers = sharedSnap.val() || {};

            await clearHomeAlarmPause(
              uid,
              homeId,
              sharedUsers,
              pause,
            );

            console.log(
              "🧹 EXPIRED ALARM PAUSE REMOVED:",
              uid,
              homeId,
            );
          }

          continue;
        }

        // Dữ liệu không đủ ngày/giờ hợp lệ: giữ cleanup theo ngày làm dự phòng.
        const today = getTodayKey();

        if (pause.date !== today) {
          const sharedSnap = await db
            .ref(`sharedByHome/${homeId}`)
            .once("value");

          const sharedUsers = sharedSnap.val() || {};

          await clearHomeAlarmPause(
            uid,
            homeId,
            sharedUsers,
            pause,
          );

          console.log("🧹 OLD ALARM PAUSE REMOVED:", uid, homeId);

          continue;
        }

        if (
          !isTimeInPauseRange(
            pause.start,
            pause.end,
          )
        ) {
          const start = toMin(pause.start);
          const end = toMin(pause.end);
          const current = toMin(getCurrentHHMM());

          let finished = false;

          if (start > end) {
            finished =
              current > end &&
              current < start;
          } else {
            finished =
              current > end;
          }

          if (finished) {
            const sharedSnap = await db
              .ref(`sharedByHome/${homeId}`)
              .once("value");

            const sharedUsers = sharedSnap.val() || {};

            await clearHomeAlarmPause(
              uid,
              homeId,
              sharedUsers,
              pause,
            );

            console.log(
              "🧹 EXPIRED ALARM PAUSE REMOVED:",
              uid,
              homeId,
            );
          }
        }
      }
    }
  } catch (err) {
    console.log(
      "ALARM PAUSE CLEANUP ERROR:",
      err.message,
    );
  }
}
// Scheduled Reminder checks are extracted to the Reminder domain.

// ================= DEVICE NOTIFICATION LOG =================
async function addHomeEvent(
  uid,
  homeId,
  deviceId,
  deviceName,
  text,
  type = "status",
) {
  try {
    const now = Date.now();
    const eventsRef = db.ref(
      `accounts/${uid}/homes/${homeId}/events`,
    );
    const eventRef = eventsRef.push();

    await eventRef.set({
      time: now,
      deviceId,
      deviceName,
      text,
      type,
    });

    queueOrderedListCleanup(
      `home_events:${uid}:${homeId}`,
      eventsRef,
      HOME_EVENT_STORAGE_LIMIT,
    );

    console.log(
      "🏠 HOME EVENT:",
      homeId,
      deviceName,
      text,
    );
  } catch (err) {
    console.log("HOME EVENT ERROR:", err.message);
  }
}
async function addDeviceNotification(
  uid,
  homeId,
  deviceId,
  text,
  type = "status",
) {
  try {
    const now = Date.now();

    const deviceRef = db.ref(
      `accounts/${uid}/homes/${homeId}/devices/${deviceId}`,
    );

    const deviceSnap = await deviceRef.once("value");
    const deviceData = deviceSnap.val() || {};
    const deviceName = deviceData.name || deviceId;

    const notificationsRef =
      deviceRef.child("notifications");
    const notifRef = notificationsRef.push();

    await notifRef.set({
      time: now,
      text,
      type,
    });

    await addHomeEvent(
      uid,
      homeId,
      deviceId,
      deviceName,
      text,
      type,
    );

    queueOrderedListCleanup(
      `device_notifications:${uid}:${homeId}:${deviceId}`,
      notificationsRef,
      DEVICE_NOTIFICATION_STORAGE_LIMIT,
    );

    console.log("📝 NOTIFICATION:", text);
  } catch (err) {
    console.log("NOTIFICATION ERROR:", err.message);
  }
}

// ================= ALARM LOGIC =================


// ================= CENTRAL ALARM ENGINE =================
// Mọi packet cảm biến được chuẩn hóa thành một quyết định duy nhất trước khi
// tạo incident. Firebase chỉ lưu/đồng bộ trạng thái; quyết định Alarm nằm ở Hub.
// Sensor Alarm Engine logic is implemented in domains/alarm/sensor_alarm_engine.js.
function doesPauseOverlapEnabledAlarm(
  home,
  pauseStartAt,
  pauseEndAt,
) {
  const devices = home?.devices || {};

  for (const device of Object.values(devices)) {
    const policy = normalizeDeviceAlarmPolicy(
      device || {},
      String(device?.type || "unknown"),
    );
    const schedules = normalizeDeviceAlarmScheduleCollection(
      device?.alarmSchedules,
      { scope: "home" },
    );

    for (const alarm of schedules) {
      if (
        alarmInstanceOverlapsPause(
          alarm,
          pauseStartAt,
          pauseEndAt,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

// Quyết định ưu tiên Alarm duy nhất cho mọi luồng backend.
// Thứ tự cố định:
// 1) Không bảo vệ: tắt toàn bộ Alarm.
// 2) Thiết bị Nguy hiểm: luôn hoạt động ở normal/armed.
// 3) Mode Bảo vệ: thiết bị An ninh tham gia Alarm, bỏ qua lịch/Pause.
// 4) Mode Bình thường: thiết bị An ninh chỉ hoạt động trong lịch và không Pause.
function getSecurityModeAlarmKey(
  receiverUid,
  ownerUid,
  homeId,
  deviceId,
) {
  return [
    "security_mode",
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
  ].join("_");
}

function getScheduleAlarmRuntimePrefix(
  receiverUid,
  ownerUid,
  homeId,
  deviceId,
) {
  return [
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
  ].join("_") + "_";
}

function clearScheduleAlarmRuntimeForDevice(
  receiverUid,
  ownerUid,
  homeId,
  deviceId,
) {
  const prefix = getScheduleAlarmRuntimePrefix(
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
  );

  for (const key of Object.keys(lastScheduleAlarmMap)) {
    if (key.startsWith(prefix)) {
      delete lastScheduleAlarmMap[key];
    }
  }
}

function clearScheduleAlarmRuntimeForHome(
  ownerUid,
  homeId,
) {
  const home = getCachedHomeData(ownerUid, homeId) || {};
  const devices = home?.devices || {};

  for (const receiverUid of getAlarmReceiverUidsForHome(
    ownerUid,
    homeId,
  )) {
    for (const deviceId of Object.keys(devices)) {
      clearScheduleAlarmRuntimeForDevice(
        receiverUid,
        ownerUid,
        homeId,
        deviceId,
      );
    }
  }
}

function getScheduleAlarmKey(
  receiverUid,
  ownerUid,
  homeId,
  deviceId,
  alarm,
  alarmSource = "scheduled_alarm",
) {
  const scheduleIdentity = String(
    alarm?.scheduleIdentity || "",
  ).trim();
  const occurrenceIdentity =
    getActiveScheduleOccurrenceIdentity(alarm);

  return [
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
    String(alarmSource || "scheduled_alarm"),
    scheduleIdentity || String(alarm?.start || ""),
    scheduleIdentity ? "" : String(alarm?.end || ""),
    scheduleIdentity
      ? ""
      : normalizeAlarmDays(alarm?.days).join("-"),
    occurrenceIdentity,
  ].join("_");
}

function alarmIncidentContainsSecurityCondition(
  incident,
  item,
) {
  const expectedIdentity =
    getSecurityAlarmConditionIdentity(item);

  return normalizePreferredSecurityIncidentItems(
    incident?.items,
  ).some((incidentItem) => {
    return getSecurityAlarmConditionIdentity(
      incidentItem,
    ) === expectedIdentity;
  });
}

async function repairScheduledSecurityIncidentStage(
  receiverUid,
  incidentId,
  incident,
) {
  if (
    !incident ||
    incident.status !== "active" ||
    incident.flowType === "emergency"
  ) {
    return null;
  }

  const validation =
    await validateAndResolveSecurityIncident(
      receiverUid,
      incidentId,
      incident,
      { reasonHint: "scheduled_alarm_delivery_repair" },
    );

  if (!validation.active) {
    return null;
  }

  const refreshedIncident = {
    ...incident,
    items: validation.items,
    ...getAlarmIncidentRuntimePreferences(
      validation.items,
    ),
  };
  const now = Date.now();
  const stage = String(
    refreshedIncident.stage || "detected",
  ).trim();
  const stageOrder = [
    "detected",
    "alarm",
    "siren",
    "calling",
  ];
  const stageRank = Math.max(
    0,
    stageOrder.indexOf(stage),
  );
  const sirenDueAt = Number(
    refreshedIncident.sirenDueAt || 0,
  );
  const alarmDueAt = Number(
    refreshedIncident.alarmDueAt || 0,
  );

  // Tự phục hồi incident bị mất timer hoặc được tạo từ cấu hình Fullscreen
  // cũ. Đây là điểm khiến Owner có incident nhưng không bao giờ tới màn hình.
  if (
    stageRank < stageOrder.indexOf("siren") &&
    sirenDueAt > 0 &&
    now >= sirenDueAt &&
    (
      refreshedIncident.fullscreenEnabled !== false ||
      refreshedIncident.physicalSirenEnabled !== false
    )
  ) {
    await advanceAlarmIncidentToStage(
      receiverUid,
      incidentId,
      "siren",
    );
  } else if (
    stageRank < stageOrder.indexOf("alarm") &&
    alarmDueAt > 0 &&
    now >= alarmDueAt
  ) {
    await advanceAlarmIncidentToStage(
      receiverUid,
      incidentId,
      "alarm",
    );
  }

  return refreshedIncident;
}

async function resolveDeviceAlarmConfigurationForReceiver(
  receiverUid,
  homeId,
  deviceId,
  homeData,
  receiverAccount = null,
  ownerUid = "",
) {
  const device = homeData.devices?.[deviceId] || {};
  const policy = normalizeDeviceAlarmPolicy(
    device,
    String(device?.type || "unknown").trim(),
  );
  const homeSchedules = normalizeDeviceAlarmScheduleCollection(
    device?.alarmSchedules,
    { scope: "home" },
  );

  let personalSchedules = [];
  let personalNotificationEnabled = true;
  let fullscreenEnabled = policy.fullscreenEnabled;
  let followHomeSchedule = true;
  let scheduleModelVersion = 1;
  const resolvedOwnerUid = String(
    ownerUid || homeData?._ownerUid || "",
  ).trim();
  const isOwnerReceiver = receiverUid === resolvedOwnerUid;

  try {
    let customHomeRules = null;

    if (receiverAccount) {
      customHomeRules =
        receiverAccount.customRules?.[homeId] || {};
    } else {
      const customRulesSnap = await db
        .ref(`accounts/${receiverUid}/customRules/${homeId}`)
        .once("value");
      customHomeRules = customRulesSnap.val() || {};
    }

    const customDevice =
      customHomeRules?.devices?.[deviceId] || {};
    const rawModelVersion = Number(
      customDevice?.alarmPreferences?.scheduleModelVersion || 1,
    );
    scheduleModelVersion = Number.isFinite(rawModelVersion)
      ? Math.max(1, Math.trunc(rawModelVersion))
      : 1;

    const hasPersonalNotificationPreference =
      typeof customDevice?.alarmPreferences?.notificationEnabled ===
      "boolean";
    const hasPersonalFullscreenPreference =
      typeof customDevice?.alarmPreferences?.fullscreenEnabled ===
      "boolean";
    const personalFullscreenEnabled =
      customDevice?.alarmPreferences?.fullscreenEnabled === true;

    if (
      typeof customDevice?.alarmPreferences?.followHomeSchedule ===
        "boolean"
    ) {
      followHomeSchedule =
        customDevice.alarmPreferences.followHomeSchedule === true;
    }

    if (hasPersonalNotificationPreference) {
      personalNotificationEnabled =
        customDevice.alarmPreferences.notificationEnabled === true;
    }

    // Khi theo lịch chung, thông báo cá nhân luôn đồng bộ với cấu hình
    // thông báo của thiết bị trong nhà. Giá trị cũ trong customRules chỉ còn
    // là dữ liệu tương thích và không được phép ghi đè cấu hình chung.
    if (followHomeSchedule) {
      personalNotificationEnabled =
        policy.notificationEnabled !== false;
    }

    // Fullscreen vẫn là lựa chọn cá nhân cho cả Owner và thành viên.
    if (hasPersonalFullscreenPreference) {
      fullscreenEnabled = personalFullscreenEnabled;
    }

    // Lịch cá nhân độc lập chỉ được đọc khi người dùng không theo lịch chung.
    // Điều này chặn dữ liệu lịch cũ chạy song song sau khi bật đồng bộ.
    if (
      !followHomeSchedule &&
      scheduleModelVersion >= 2
    ) {
      personalSchedules =
        normalizeDeviceAlarmScheduleCollection(
          customDevice?.alarmSchedules,
          { scope: "personal" },
        );
    }
  } catch (error) {
    console.log(
      "PERSONAL DEVICE ALARM LOAD ERROR:",
      receiverUid,
      homeId,
      deviceId,
      error.message,
    );
  }

  return {
    homeSchedules,
    personalSchedules,
    personalNotificationEnabled,
    fullscreenEnabled,
    followHomeSchedule,
    isOwnerReceiver,
    scheduleModelVersion,
    policy,
  };
}

function getUnsafeSecurityReason(
  deviceName,
  deviceType,
  device,
) {
  if (device.tamper === true) {
    return `${deviceName}: Thiết bị bị tháo`;
  }

  if (
    (
      deviceType === "motion" ||
      deviceType === "presence"
    ) &&
    (
      isActiveSignal(device.occupancy) ||
      isActiveSignal(device.motion) ||
      isActiveSignal(device.presence)
    )
  ) {
    return `${deviceName}: Phát hiện chuyển động`;
  }

  if (
    (
      deviceType === "door_lock" ||
      deviceType === "lock"
    ) &&
    normalizeLockState(device) === "unlocked"
  ) {
    return `${deviceName}: Khóa đang mở`;
  }

  if (
    (
      deviceType === "door" ||
      deviceType === "window" ||
      deviceType === "gate"
    ) &&
    device.contact === false
  ) {
    return `${deviceName}: Cửa đang mở`;
  }

  return "";
}

function getOfflineAlarmDemandKey(item) {
  return [
    String(item?.ownerUid || "").trim(),
    String(item?.homeId || "").trim(),
    String(item?.deviceId || "").trim(),
    getSensorAlarmEventCode(item?.type, item?.reason),
  ].join("|");
}

function getOfflineAlarmDemandExpiry(item, createdAt) {
  const type = String(item?.type || "").trim();

  if (type === "vibration") {
    return createdAt + VIBRATION_ACTIVE_WINDOW_MS + 5000;
  }

  if (
    type === "sos" ||
    type === "glass_break" ||
    type === "motion" ||
    type === "presence"
  ) {
    return createdAt + OFFLINE_TRANSIENT_ALARM_TTL_MS;
  }

  return createdAt + ALARM_INCIDENT_AUTO_EXPIRE_MS;
}

async function isOfflineAlarmDemandStillUnsafe(demand) {
  const item = demand?.item || {};
  const ownerUid = String(item.ownerUid || "").trim();
  const homeId = String(item.homeId || "").trim();
  const receiverUid = String(
    demand?.receiverUid || ownerUid,
  ).trim();
  const home = getCachedHomeData(ownerUid, homeId);

  if (!home) {
    // Không tự ý xóa demand khi snapshot chưa đọc được.
    return Date.now() < Number(demand.expiresAt || 0);
  }

  if (Date.now() >= Number(demand.expiresAt || 0)) {
    return false;
  }

  const type = String(item.type || "").trim();
  const homeMode = normalizeHomeSecurityMode(home.securityMode);

  if (homeMode === "unprotected") {
    return false;
  }

  if (isEmergencyDeviceType(type)) {
    if (isPersistentEmergencyIncidentItem(item)) {
      return isEmergencyIncidentItemStillUnsafe(home, item) === true;
    }

    // SOS là sự kiện tức thời và chỉ còn hiệu lực trong TTL offline.
    return type === "sos";
  }

  if (!isSecurityDeviceType(type)) {
    return false;
  }

  const device = home?.devices?.[item.deviceId] || {};
  const policy = normalizeDeviceAlarmPolicy(device, type);
  let conditionUnsafe = Boolean(
    getUnsafeSecurityReason(
      item.deviceName || item.deviceId,
      type,
      device,
    ),
  );

  if (type === "vibration" || type === "glass_break") {
    conditionUnsafe = true;
  }

  if (!conditionUnsafe) {
    return false;
  }

  const configuration =
    await resolveDeviceAlarmConfigurationForReceiver(
      receiverUid,
      homeId,
      item.deviceId,
      home,
      getCachedAccountData(receiverUid),
      ownerUid,
    );
  const activeSchedule = homeMode === "normal"
    ? resolveActiveDeviceSchedule(configuration)
    : null;
  const activation = resolveAlarmActivationPriority({
    deviceType: type,
    homeMode,
    policyEnabled: policy.enabled === true,
    activeSchedule,
    alarmPaused: isAlarmPauseActiveFromData(
      home?.alarmPauseToday,
    ),
    modeRepeatMinutes: home?.securityModeRepeatMinutes,
  });

  return activation.active;
}

async function activateOfflineAlarmDemand(demandKey) {
  const demand = offlineAlarmDemandMap.get(demandKey);

  if (
    !demand ||
    firebaseConnected ||
    demand.item?.physicalSirenEnabled === false ||
    !await isOfflineAlarmDemandStillUnsafe(demand)
  ) {
    return;
  }

  demand.sirenStarted = true;
  demand.sirenStartedAt = Date.now();
  offlineAlarmDemandMap.set(demandKey, demand);

  await setPhysicalSirenForHome(
    demand.item.ownerUid,
    demand.item.homeId,
    true,
    {
      force: false,
      reason: "offline_alarm_demand",
    },
  );
}

function clearOfflineAlarmDemand(demandKey) {
  const cleanKey = String(demandKey || "").trim();

  if (!cleanKey) {
    return false;
  }

  const expiryTimer = offlineAlarmExpiryTimerMap.get(cleanKey);

  if (expiryTimer) {
    clearTimeout(expiryTimer);
    offlineAlarmExpiryTimerMap.delete(cleanKey);
  }

  return offlineAlarmDemandMap.delete(cleanKey);
}

function registerOfflineAlarmDemand(receiverUid, item) {
  if (!item?.ownerUid || !item?.homeId || !item?.deviceId) {
    return;
  }

  const demandKey = getOfflineAlarmDemandKey(item);
  const now = Date.now();
  const flowType = getAlarmIncidentFlowType([item]);
  const existing = offlineAlarmDemandMap.get(demandKey);
  const demand = {
    ...(existing || {}),
    receiverUid: String(receiverUid || "").trim(),
    item,
    createdAt: Number(existing?.createdAt || now),
    expiresAt: getOfflineAlarmDemandExpiry(
      item,
      Number(existing?.createdAt || now),
    ),
    sirenStarted: existing?.sirenStarted === true,
  };

  offlineAlarmDemandMap.set(demandKey, demand);

  const oldExpiryTimer = offlineAlarmExpiryTimerMap.get(
    demandKey,
  );

  if (oldExpiryTimer) {
    clearTimeout(oldExpiryTimer);
  }

  const expiryTimer = setTimeout(() => {
    offlineAlarmExpiryTimerMap.delete(demandKey);
    void reconcileOfflineAlarmDemandsForHome(
      item.ownerUid,
      item.homeId,
    ).catch((error) => {
      console.log(
        "OFFLINE ALARM EXPIRY ERROR:",
        item.homeId,
        error.message,
      );
    });
  }, Math.max(100, demand.expiresAt - Date.now() + 100));

  offlineAlarmExpiryTimerMap.set(
    demandKey,
    expiryTimer,
  );

  if (
    demand.sirenStarted ||
    item.physicalSirenEnabled === false
  ) {
    return;
  }

  void activateOfflineAlarmDemand(demandKey).catch((error) => {
    console.log(
      "OFFLINE SIREN START ERROR:",
      item.homeId,
      error.message,
    );
  });

  console.log(
    "📴 OFFLINE ALARM ACTIVATED:",
    item.homeId,
    item.deviceId,
    flowType,
    "siren=immediate",
  );
}

async function reconcileOfflineAlarmDemandsForHome(
  ownerUid,
  homeId,
) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();
  let activeDemandCount = 0;
  let hadStartedDemand = false;

  for (const [key, demand] of offlineAlarmDemandMap.entries()) {
    const item = demand?.item || {};

    if (
      String(item.ownerUid || "").trim() !== cleanOwnerUid ||
      String(item.homeId || "").trim() !== cleanHomeId
    ) {
      continue;
    }

    if (await isOfflineAlarmDemandStillUnsafe(demand)) {
      activeDemandCount++;
      hadStartedDemand =
        hadStartedDemand || demand.sirenStarted === true;
      continue;
    }

    const expiryTimer = offlineAlarmExpiryTimerMap.get(key);

    if (expiryTimer) {
      clearTimeout(expiryTimer);
      offlineAlarmExpiryTimerMap.delete(key);
    }

    hadStartedDemand =
      hadStartedDemand || demand.sirenStarted === true;
    offlineAlarmDemandMap.delete(key);
  }

  if (
    !firebaseConnected &&
    activeDemandCount === 0 &&
    hadStartedDemand
  ) {
    await setPhysicalSirenForHome(
      cleanOwnerUid,
      cleanHomeId,
      false,
      {
        force: true,
        reason: "offline_alarm_cleared",
      },
    );
  }
}

function getCurrentEmergencyReason(
  deviceName,
  deviceType,
  device,
  { transientEventCutoffAt = 0 } = {},
) {
  const name = String(deviceName || "Thiết bị").trim();

  if (
    deviceType === "smoke" &&
    isActiveSignal(device?.smoke)
  ) {
    return `${name}: Phát hiện khói`;
  }

  if (
    deviceType === "heat" &&
    (
      isActiveSignal(device?.heat) ||
      isActiveSignal(device?.heat_alarm) ||
      isActiveSignal(device?.high_temperature_alarm)
    )
  ) {
    return `${name}: Phát hiện nhiệt độ nguy hiểm`;
  }

  if (
    deviceType === "carbon_monoxide" &&
    (
      isActiveSignal(device?.carbon_monoxide) ||
      isActiveSignal(device?.co_alarm)
    )
  ) {
    return `${name}: Phát hiện khí CO`;
  }

  if (
    deviceType === "gas" &&
    (
      isActiveSignal(device?.gas) ||
      isActiveSignal(device?.gas_alarm)
    )
  ) {
    return `${name}: Phát hiện rò rỉ gas`;
  }

  if (
    (
      deviceType === "water_leak" ||
      deviceType === "flood"
    ) &&
    (
      isActiveSignal(device?.water_leak) ||
      isActiveSignal(device?.leak) ||
      isActiveSignal(device?.water)
    )
  ) {
    return `${name}: Phát hiện ngập nước`;
  }

  if (deviceType === "sos") {
    const now = Date.now();
    const activeUntil = Number(device?.sos_active_until || 0);
    const lastTriggered = Math.max(
      Number(device?.last_triggered || 0),
      Number(device?.emergency_triggered_at || 0),
    );
    const cutoffAt = Number(transientEventCutoffAt || 0);

    // Khi vừa rời Mode Không bảo vệ, không dùng activeUntil 5 phút để
    // phát lại một SOS cũ. Chỉ thời điểm kích hoạt thật sự được xét và
    // phải nằm trong cửa sổ replay đã truyền vào.
    if (cutoffAt > 0) {
      if (
        lastTriggered >= cutoffAt &&
        lastTriggered <= now + 60 * 1000
      ) {
        return `${name}: SOS được kích hoạt`;
      }

      return "";
    }

    if (
      activeUntil > now ||
      (
        lastTriggered > 0 &&
        now - lastTriggered <
          OFFLINE_TRANSIENT_ALARM_TTL_MS
      )
    ) {
      return `${name}: SOS được kích hoạt`;
    }
  }

  return "";
}

async function resumeOfflineAlarmDemandsFromSnapshot() {
  if (firebaseConnected) {
    return;
  }

  const accounts = getCachedAccountsObject();
  let resumed = 0;

  for (const [ownerUid, account] of Object.entries(accounts)) {
    const homes = account?.homes || {};

    for (const [homeId, home] of Object.entries(homes)) {
      const homeMode = normalizeHomeSecurityMode(
        home?.securityMode,
      );

      if (homeMode === "unprotected") {
        continue;
      }

      const homeName = String(home?.name || homeId);
      const devices = home?.devices || {};
      const receiverUids = getAlarmReceiverUidsForHome(
        ownerUid,
        homeId,
      );
      const pauseActive = isAlarmPauseActiveFromData(
        home?.alarmPauseToday,
      );

      for (const [deviceId, device] of Object.entries(devices)) {
        const deviceType = String(
          device?.type || "unknown",
        ).trim();

        if (
          !isEmergencyDeviceType(deviceType) &&
          !isSecurityDeviceType(deviceType)
        ) {
          continue;
        }

        const deviceName = String(
          device?.name || deviceId,
        );
        const policy = normalizeDeviceAlarmPolicy(
          device,
          deviceType,
        );
        const isEmergency = isEmergencyDeviceType(deviceType);
        const unsafeReason = isEmergency
          ? getCurrentEmergencyReason(
              deviceName,
              deviceType,
              device,
            )
          : getUnsafeSecurityReason(
              deviceName,
              deviceType,
              device,
            );

        if (!unsafeReason) {
          continue;
        }

        for (const receiverUid of receiverUids) {
          const configuration =
            await resolveDeviceAlarmConfigurationForReceiver(
              receiverUid,
              homeId,
              deviceId,
              home,
              getCachedAccountData(receiverUid),
              ownerUid,
            );
          const activeSchedule =
            !isEmergency && homeMode === "normal"
              ? resolveActiveDeviceSchedule(configuration)
              : null;
          const activation = resolveAlarmActivationPriority({
            deviceType,
            homeMode,
            policyEnabled: policy.enabled === true,
            activeSchedule,
            alarmPaused: pauseActive,
            modeRepeatMinutes: home?.securityModeRepeatMinutes,
          });

          if (!activation.active) {
            continue;
          }

          const item = {
            ownerUid,
            homeId,
            homeName,
            deviceId,
            deviceName,
            type: deviceType,
            reason: unsafeReason,
            severity: isEmergency
              ? SENSOR_EVENT_SEVERITY.EMERGENCY
              : SENSOR_EVENT_SEVERITY.ALARM,
            eventCategory: isEmergency
              ? SENSOR_EVENT_CATEGORY.EMERGENCY
              : SENSOR_EVENT_CATEGORY.SECURITY,
            alarmLevel: isEmergency
              ? SENSOR_EVENT_SEVERITY.EMERGENCY
              : SENSOR_EVENT_SEVERITY.ALARM,
            repeatMinutes: activation.repeatMinutes,
            nextAlarm: isEmergency
              ? "ngay lập tức"
              : getNextAlarmTimeText(
                  activation.repeatMinutes,
                ),
            alarmSource: activation.source,
            notificationEnabled:
              isEmergency || activation.source === "security_mode"
                ? policy.notificationEnabled
                : activeSchedule?.notificationAllowed === true,
            physicalSirenEnabled:
              isEmergency || activation.source === "security_mode"
                ? policy.physicalSirenEnabled
                : activeSchedule?.physicalSirenAllowed === true,
            fullscreenEnabled:
              isEmergency || activation.source === "security_mode"
                ? configuration.fullscreenEnabled
                : activeSchedule?.fullscreenAllowed === true,
          };

          registerOfflineAlarmDemand(receiverUid, item);
          enqueueOfflineAlarmItem(receiverUid, item);
          resumed++;
        }
      }
    }
  }

  if (resumed > 0) {
    console.log(
      "📴 OFFLINE ALARMS RESUMED FROM SNAPSHOT:",
      resumed,
    );
  }
}

async function processSensorEventThroughAlarmEngine(
  receiverUid,
  ownerUid,
  homeId,
  homeName,
  deviceId,
  deviceName,
  deviceType,
  homeData,
  updateData,
) {
  const normalizedDeviceType = String(
    deviceType || "unknown",
  ).trim();
  const oldDevice =
    homeData.devices?.[deviceId] || {};
  const nextDevice = {
    ...oldDevice,
    ...(updateData || {}),
  };

  await releaseAlarmEventControlsForDeviceState({
    receiverUid,
    ownerUid,
    homeId,
    deviceId,
    device: nextDevice,
  });

  const category = getSensorEventCategory(
    normalizedDeviceType,
  );

  if (category === SENSOR_EVENT_CATEGORY.SYSTEM_WARNING) {
    // Pin yếu, offline, Hub offline... thuộc luồng sức khỏe hệ thống,
    // không được biến thành Alarm an ninh/khẩn cấp.
    return;
  }

  const trigger = buildAlarmTriggerFromSensorEvent({
    deviceType: normalizedDeviceType,
    deviceName,
    oldDevice,
    updateData,
  });

  if (!trigger) {
    return;
  }

  if (
    !shouldAcceptSensorAlarmTrigger({
      receiverUid,
      ownerUid,
      homeId,
      deviceId,
      deviceType: normalizedDeviceType,
      reason: trigger.reason,
    })
  ) {
    console.log(
      "🧯 SENSOR ALARM PACKET DEBOUNCED:",
      receiverUid,
      homeId,
      deviceId,
      normalizedDeviceType,
    );
    return;
  }

  const homeMode = normalizeHomeSecurityMode(
    homeData.securityMode,
  );
  const alarmPolicy = normalizeDeviceAlarmPolicy(
    oldDevice,
    normalizedDeviceType,
  );
  const alarmConfiguration =
    await resolveDeviceAlarmConfigurationForReceiver(
      receiverUid,
      homeId,
      deviceId,
      homeData,
      getCachedAccountData(receiverUid),
      ownerUid,
    );
  const activeSchedule =
    trigger.category === SENSOR_EVENT_CATEGORY.SECURITY &&
    homeMode === "normal"
      ? resolveActiveDeviceSchedule(alarmConfiguration)
      : null;
  const activation = resolveAlarmActivationPriority({
    deviceType: normalizedDeviceType,
    homeMode,
    policyEnabled: alarmPolicy.enabled === true,
    activeSchedule,
    alarmPaused: false,
    modeRepeatMinutes: homeData.securityModeRepeatMinutes,
  });

  if (!activation.active) {
    // Không bảo vệ là trạng thái im lặng hoàn toàn. Không gửi thêm một
    // notification phụ vì người dùng đã chủ động tắt mọi Alarm của nhà.
    console.log(
      "🔕 SENSOR ALARM SUPPRESSED:",
      receiverUid,
      homeId,
      deviceId,
      activation.reason,
    );
    return;
  }

  if (activation.source === "scheduled_alarm") {
    const canReceiveScheduledAlarm = await canReceiveAlarm(
      receiverUid,
      homeId,
      ownerUid,
      { respectPause: true },
    );

    if (!canReceiveScheduledAlarm) {
      return;
    }
  }

  const repeatMinutes = activation.repeatMinutes;
  const isEmergency =
    activation.flowType === "emergency";
  const alarmItem = {
    ownerUid,
    homeId,
    homeName,
    deviceId,
    deviceName,
    type: normalizedDeviceType,
    reason: trigger.reason,
    severity: trigger.severity,
    eventCategory: trigger.category,
    repeatMinutes,
    nextAlarm: isEmergency
      ? "ngay lập tức"
      : getNextAlarmTimeText(repeatMinutes),
    alarmSource: activation.source,
    alarmLevel: trigger.severity,
    notificationEnabled: isEmergency || activation.source === "security_mode"
      ? alarmPolicy.notificationEnabled
      : activeSchedule?.notificationAllowed === true,
    physicalSirenEnabled: isEmergency || activation.source === "security_mode"
      ? alarmPolicy.physicalSirenEnabled
      : activeSchedule?.physicalSirenAllowed === true,
    fullscreenEnabled: isEmergency || activation.source === "security_mode"
      ? alarmConfiguration.fullscreenEnabled
      : activeSchedule?.fullscreenAllowed === true,
  };

  if (activation.source === "scheduled_alarm") {
    const alarmKey = getScheduleAlarmKey(
      receiverUid,
      ownerUid,
      homeId,
      deviceId,
      activeSchedule?.alarm,
      activation.source,
    );

    lastScheduleAlarmMap[alarmKey] = Date.now();
  }

  if (!firebaseConnected) {
    registerOfflineAlarmDemand(receiverUid, alarmItem);
  }

  queueEventAlarm(receiverUid, alarmItem);
}

// Giữ tên hàm cũ để các luồng CO fast-path và MQTT hiện tại không cần đổi
// đồng loạt. Mọi lời gọi đều được chuyển qua Alarm Engine trung tâm.
async function processScheduleAlarmsForOwner(
  receiverUid,
  ownerUid,
  homeId,
  homeName,
  deviceId,
  deviceName,
  deviceType,
  homeData,
  updateData,
) {
  return processSensorEventThroughAlarmEngine(
    receiverUid,
    ownerUid,
    homeId,
    homeName,
    deviceId,
    deviceName,
    deviceType,
    homeData,
    updateData,
  );
}

async function checkScheduledAlarms({
  ownerUidFilter = "",
  homeIdFilter = "",
  reason = "periodic",
} = {}) {
  console.log(
    "🚨 CHECK PER-DEVICE ALARM SCHEDULE:",
    reason,
    ownerUidFilter || "all",
    homeIdFilter || "all",
  );

  try {
    const accounts = getCachedAccountsObject();
    const now = Date.now();
    const pendingByUser = new Map();

    function getPending(receiverUid) {
      if (!pendingByUser.has(receiverUid)) {
        pendingByUser.set(receiverUid, {
          firstOccurrence: [],
          recurring: [],
        });
      }

      return pendingByUser.get(receiverUid);
    }

    for (const [ownerUid, ownerAccount] of Object.entries(accounts)) {
      if (ownerUidFilter && ownerUid !== ownerUidFilter) {
        continue;
      }

      const homes = ownerAccount?.homes || {};

      for (const [homeId, home] of Object.entries(homes)) {
        if (homeIdFilter && homeId !== homeIdFilter) {
          continue;
        }

        const homeMode = normalizeHomeSecurityMode(home?.securityMode);

        // Khi armed, Mode Bảo vệ là nguồn duy nhất. Khi unprotected,
        // mọi Alarm đều bị tắt. Scheduler tuyệt đối không chạy song song.
        if (homeMode !== "normal") {
          continue;
        }

        const receiverUids = getAlarmReceiverUidsForHome(
          ownerUid,
          homeId,
        );
        const devices = home?.devices || {};
        const pauseActive = isAlarmPauseActiveFromData(
          home?.alarmPauseToday,
        );

        for (const receiverUid of receiverUids) {
          const receiverAccount = accounts[receiverUid] || {};

          for (const [deviceId, device] of Object.entries(devices)) {
            const deviceType = String(
              device?.type || "unknown",
            ).trim();

            if (!isSecurityDeviceType(deviceType)) {
              continue;
            }

            delete lastScheduleAlarmMap[
              getSecurityModeAlarmKey(
                receiverUid,
                ownerUid,
                homeId,
                deviceId,
              )
            ];

            const policy = normalizeDeviceAlarmPolicy(
              device,
              deviceType,
            );

            if (policy.enabled !== true) {
              clearScheduleAlarmRuntimeForDevice(
                receiverUid,
                ownerUid,
                homeId,
                deviceId,
              );
              continue;
            }

            const configuration =
              await resolveDeviceAlarmConfigurationForReceiver(
                receiverUid,
                homeId,
                deviceId,
                home,
                receiverAccount,
                ownerUid,
              );
            const activeSchedule =
              resolveActiveDeviceSchedule(configuration);
            const activation = resolveAlarmActivationPriority({
              deviceType,
              homeMode,
              policyEnabled: policy.enabled === true,
              activeSchedule,
              alarmPaused: pauseActive,
              modeRepeatMinutes: home?.securityModeRepeatMinutes,
            });

            if (!activation.active) {
              clearScheduleAlarmRuntimeForDevice(
                receiverUid,
                ownerUid,
                homeId,
                deviceId,
              );
              continue;
            }

            const deviceName = String(
              device?.name || deviceId,
            );
            const unsafeReason = getUnsafeSecurityReason(
              deviceName,
              deviceType,
              device || {},
            );

            if (!unsafeReason) {
              // Sensor đã an toàn: nhả runtime để lần chuyển trạng thái mới
              // trong cùng lịch vẫn được Alarm ngay.
              clearScheduleAlarmRuntimeForDevice(
                receiverUid,
                ownerUid,
                homeId,
                deviceId,
              );
              continue;
            }

            const deviceAlarm = activeSchedule.alarm;
            const repeatMinutes = activation.repeatMinutes;
            const alarmItem = {
              ownerUid,
              homeId,
              homeName: home?.name || homeId,
              deviceId,
              deviceName,
              type: deviceType,
              reason: unsafeReason,
              severity: SENSOR_EVENT_SEVERITY.ALARM,
              eventCategory: SENSOR_EVENT_CATEGORY.SECURITY,
              alarmLevel: SENSOR_EVENT_SEVERITY.ALARM,
              repeatMinutes,
              nextAlarm: getNextAlarmTimeText(repeatMinutes),
              alarmSource: activation.source,
              notificationEnabled:
                activeSchedule.notificationAllowed === true,
              physicalSirenEnabled:
                activeSchedule.physicalSirenAllowed === true,
              fullscreenEnabled:
                activeSchedule.fullscreenAllowed === true,
            };
            const alarmKey = getScheduleAlarmKey(
              receiverUid,
              ownerUid,
              homeId,
              deviceId,
              deviceAlarm,
              activation.source,
            );
            const runtimePrefix = getScheduleAlarmRuntimePrefix(
              receiverUid,
              ownerUid,
              homeId,
              deviceId,
            );
            const previousRuntimeTimes = Object.entries(
              lastScheduleAlarmMap,
            )
              .filter(([key]) => key.startsWith(runtimePrefix))
              .map(([, value]) => Number(value || 0))
              .filter((value) => value > 0);
            const lastTime = Math.max(
              Number(lastScheduleAlarmMap[alarmKey] || 0),
              ...previousRuntimeTimes,
              0,
            );
            const firstOccurrence = lastTime <= 0;

            if (repeatMinutes === 0 && !firstOccurrence) {
              continue;
            }

            if (
              repeatMinutes > 0 &&
              !firstOccurrence &&
              now - lastTime < repeatMinutes * 60 * 1000
            ) {
              continue;
            }

            const pending = getPending(receiverUid);
            const entry = { item: alarmItem, alarmKey };

            if (firstOccurrence) {
              pending.firstOccurrence.push(entry);
            } else {
              pending.recurring.push(entry);
            }

            console.log(
              "🕒 SCHEDULED ALARM READY:",
              receiverUid,
              ownerUid,
              homeId,
              deviceId,
              `first=${firstOccurrence}`,
              `repeat=${repeatMinutes}`,
              `home=${activeSchedule.homeActive === true}`,
              `personal=${activeSchedule.personalActive === true}`,
              `fullscreen=${activeSchedule.fullscreenAllowed === true}`,
            );
          }
        }
      }
    }

    for (const [receiverUid, pending] of pendingByUser.entries()) {
      if (pending.firstOccurrence.length > 0) {
        try {
          await startOrMergeAlarmIncidents(
            receiverUid,
            pending.firstOccurrence.map((entry) => entry.item),
            {
              bypassEventControl: true,
              forceSecurityRedelivery: true,
            },
          );

          for (const entry of pending.firstOccurrence) {
            lastScheduleAlarmMap[entry.alarmKey] = now;
          }
        } catch (error) {
          console.log(
            "SCHEDULED ALARM FIRST OCCURRENCE ERROR:",
            receiverUid,
            error.message,
          );
        }
      }

      if (pending.recurring.length > 0) {
        try {
          await startOrMergeAlarmIncidents(
            receiverUid,
            pending.recurring.map((entry) => entry.item),
          );

          for (const entry of pending.recurring) {
            lastScheduleAlarmMap[entry.alarmKey] = now;
          }
        } catch (error) {
          console.log(
            "SCHEDULED ALARM REPEAT ERROR:",
            receiverUid,
            error.message,
          );
        }
      }
    }
  } catch (error) {
    console.log(
      "PER-DEVICE ALARM SCHEDULE ERROR:",
      error.message,
    );
  }
}

async function cleanupLegacySecurityScheduleState() {
  try {
    const accounts = getCachedAccountsObject();
    const updates = {};

    for (const [ownerUid, account] of Object.entries(accounts)) {
      const homes = account?.homes || {};

      for (const [homeId, home] of Object.entries(homes)) {
        if (home?.securityModeSource === "schedule") {
          updates[
            `accounts/${ownerUid}/homes/${homeId}/securityMode`
          ] = "normal";

          updates[
            `accounts/${ownerUid}/homes/${homeId}/securityModeSource`
          ] = null;
        }

        if (
          Object.prototype.hasOwnProperty.call(
            home || {},
            "securityScheduleActive",
          )
        ) {
          updates[
            `accounts/${ownerUid}/homes/${homeId}/securityScheduleActive`
          ] = null;
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    await db.ref().update(updates);

    console.log(
      "🧹 LEGACY SECURITY SCHEDULE STATE CLEARED:",
      Object.keys(updates).length,
    );
  } catch (error) {
    console.log(
      "LEGACY SECURITY SCHEDULE CLEANUP ERROR:",
      error.message,
    );
  }
}


// Security Mode transition and recovery orchestration is extracted to
// domains/security/security_mode_orchestration.js.

// ================= CHAT PUSH =================
async function migrateLegacyChatUnreadCounters() {
  const markerRef = db.ref(
    "system/migrations/chatUnreadCounterV1",
  );

  const markerSnap = await markerRef.once("value");
  const marker = asObject(markerSnap.val());

  if (marker.completed === true) {
    return;
  }

  const chatsSnap = await db
    .ref("homeChats")
    .once("value");

  const accounts = asObject(getCachedAccountsObject());
  const chats = asObject(chatsSnap.val());
  const sharedByHome = asObject(
    getCachedSharedByHomeObject(),
  );
  const homeOwners = new Map();

  for (const [ownerUid, rawAccount] of Object.entries(accounts)) {
    const account = asObject(rawAccount);
    const ownedHomes = asObject(account.homes);

    for (const homeId of Object.keys(ownedHomes)) {
      homeOwners.set(homeId, ownerUid);
    }
  }

  const updates = {};
  const now = Date.now();
  let migratedHomes = 0;
  let migratedCounters = 0;

  for (const [homeId, rawChat] of Object.entries(chats)) {
    const ownerUid = String(
      homeOwners.get(homeId) || "",
    ).trim();

    if (!ownerUid) {
      continue;
    }

    const chat = asObject(rawChat);
    const lastReadMap = asObject(chat.lastRead);
    const messages = Object.entries(
      asObject(chat.messages),
    ).map(([messageId, rawMessage]) => {
      const message = asObject(rawMessage);

      return {
        messageId,
        senderUid: String(message.uid || "").trim(),
        time: Number(message.time || 0),
      };
    }).filter((message) => {
      return (
        message.senderUid &&
        Number.isFinite(message.time) &&
        message.time > 0
      );
    });

    const migratedThroughAt = messages.reduce(
      (latest, message) => Math.max(latest, message.time),
      0,
    );

    const recipients = new Set([ownerUid]);
    const sharedMembers = asObject(sharedByHome[homeId]);

    for (const sharedUid of Object.keys(sharedMembers)) {
      const cleanUid = String(sharedUid || "").trim();

      if (cleanUid) {
        recipients.add(cleanUid);
      }
    }

    for (const receiverUid of recipients) {
      const lastReadAt = Number(
        lastReadMap[receiverUid] || 0,
      );

      let count = 0;
      let lastMessageAt = 0;
      let lastMessageId = "";

      for (const message of messages) {
        if (
          message.senderUid === receiverUid ||
          message.time <= lastReadAt
        ) {
          continue;
        }

        count++;

        if (message.time >= lastMessageAt) {
          lastMessageAt = message.time;
          lastMessageId = message.messageId;
        }
      }

      updates[
        `accounts/${receiverUid}/chatUnread/${homeId}`
      ] = {
        count,
        lastReadAt:
          Number.isFinite(lastReadAt) && lastReadAt > 0
            ? lastReadAt
            : 0,
        lastMessageAt,
        lastMessageId,
        lastIncrementedMessageId: "",
        migratedThroughAt,
        updatedAt: now,
      };

      migratedCounters++;
    }

    migratedHomes++;
  }

  updates["system/migrations/chatUnreadCounterV1"] = {
    completed: true,
    completedAt: now,
    migratedHomes,
    migratedCounters,
  };

  await db.ref().update(updates);

  console.log(
    "💬 CHAT UNREAD MIGRATION COMPLETED:",
    `homes=${migratedHomes}`,
    `counters=${migratedCounters}`,
  );
}

function ensureChatUnreadCounterMigration() {
  if (!chatUnreadMigrationPromise) {
    chatUnreadMigrationPromise =
      migrateLegacyChatUnreadCounters().catch((error) => {
        chatUnreadMigrationPromise = null;

        console.log(
          "CHAT UNREAD MIGRATION ERROR:",
          error.message,
        );
      });
  }

  return chatUnreadMigrationPromise;
}

async function incrementChatUnreadCounter({
  receiverUid,
  homeId,
  messageId,
  messageTime,
}) {
  await ensureChatUnreadCounterMigration();

  const cleanMessageId = String(messageId || "").trim();
  const normalizedMessageTime = Number(messageTime || 0);

  if (
    !receiverUid ||
    !homeId ||
    !cleanMessageId ||
    !Number.isFinite(normalizedMessageTime) ||
    normalizedMessageTime <= 0
  ) {
    return 0;
  }

  const counterRef = db.ref(
    `accounts/${receiverUid}/chatUnread/${homeId}`,
  );

  let incremented = false;

  const result = await counterRef.transaction(
    (rawCurrent) => {
      incremented = false;

      const current = rawCurrent &&
        typeof rawCurrent === "object"
          ? rawCurrent
          : {};

      const currentCount = Number(
        typeof rawCurrent === "number"
          ? rawCurrent
          : current.count || 0,
      );

      const lastReadAt = Number(
        current.lastReadAt || 0,
      );

      const migratedThroughAt = Number(
        current.migratedThroughAt || 0,
      );

      const lastIncrementedMessageId = String(
        current.lastIncrementedMessageId || "",
      );

      if (
        cleanMessageId === lastIncrementedMessageId ||
        normalizedMessageTime <= lastReadAt ||
        normalizedMessageTime <= migratedThroughAt
      ) {
        return current;
      }

      incremented = true;

      return {
        ...current,
        count: Math.min(
          9999,
          Number.isFinite(currentCount) && currentCount > 0
            ? Math.floor(currentCount) + 1
            : 1,
        ),
        lastMessageAt: Math.max(
          Number(current.lastMessageAt || 0),
          normalizedMessageTime,
        ),
        lastMessageId: cleanMessageId,
        lastIncrementedMessageId: cleanMessageId,
        updatedAt: Date.now(),
      };
    },
  );

  if (!result.committed || !incremented) {
    return 0;
  }

  const counter = asObject(result.snapshot.val());
  const count = Number(counter.count || 0);

  return Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : 0;
}

async function sendChatNotificationPush({
  receiverUid,
  ownerUid,
  homeId,
  homeName,
  senderUid,
  senderName,
  messageId,
  text,
  unreadCount,
}) {
  if (unreadCount <= 0) {
    return;
  }

  const cleanHomeName =
    String(homeName || "").trim() || "HomeChat";

  const cleanSenderName =
    String(senderName || "").trim() ||
    "Một thành viên";

  const cleanText =
    String(text || "").trim();

  const title =
    unreadCount > 1
      ? `${cleanHomeName} · ${unreadCount} tin nhắn mới`
      : cleanHomeName;

  const body =
    `${cleanSenderName}: ${cleanText}`;

  const data = {
    type: "chat",
    title,
    body,
    ownerUid: String(ownerUid || ""),
    homeId: String(homeId || ""),
    homeName: cleanHomeName,
    senderUid: String(senderUid || ""),
    senderName: cleanSenderName,
    messageId: String(messageId || ""),
    unreadCount: String(unreadCount),
    clickAction: "home_chat",
  };

  const pushResult = await sendPushToUser(
    receiverUid,
    {
      data,

      android: {
        priority: "high",
      },

      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
            badge: unreadCount,
            threadId: `home_chat_${homeId}`,
          },
        },
      },
    },
    "CHAT",
  );

  if (pushResult.sent === 0) {
    return;
  }

  console.log(
    "💬 CHAT PUSH SENT:",
    receiverUid,
    homeId,
    unreadCount,
    `devices=${pushResult.sent}`,
  );
}

// ================= INIT =================
function awaitWithTimeout(promise, timeoutMs, label) {
  let timeout;

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label}_timeout`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => {
      clearTimeout(timeout);
    });
}

async function runCloudInitStep(
  label,
  task,
  timeoutMs = 2 * 1000,
) {
  try {
    await awaitWithTimeout(
      Promise.resolve().then(task),
      timeoutMs,
      label,
    );
  } catch (error) {
    console.log(`${label} DEFERRED:`, error.message);
  }
}

async function init() {
  loadLocalRuntimeState();
  startFirebaseConnectionMonitor();
  startOfflineQueueFlushTimer();

  await runCloudInitStep(
    "BACKEND DATA CACHE",
    startBackendDataCache,
    5 * 1000,
  );

  if (!firebaseConnected) {
    await resumeOfflineAlarmDemandsFromSnapshot();
  }

  await runCloudInitStep(
    "OLD PAIR REQUEST CLEANUP",
    () => deviceManagementDomain.cleanupOldPairRequests(),
  );

  try {
    startDeviceManagement();
  } catch (error) {
    console.log(
      "DEVICE MANAGEMENT START ERROR:",
      error.message,
    );
  }

  await runCloudInitStep(
    "LEGACY SECURITY SCHEDULE CLEANUP",
    cleanupLegacySecurityScheduleState,
  );

  await runCloudInitStep(
    "CHAT UNREAD MIGRATION",
    ensureChatUnreadCounterMigration,
  );

  await runCloudInitStep(
    "ACTIVE ALARM RESUME",
    resumeActiveAlarmIncidents,
  );

  await runCloudInitStep(
    "PHYSICAL SIREN STARTUP RECONCILE",
    async () => {
      await reconcileAllPhysicalSirens({
        force: true,
        reason: "backend_startup",
      });
    },
    15 * 1000,
  );

  startPhysicalSirenMonitor();
  startAlarmIncidentWatchdog();

  await runCloudInitStep(
    "SECURITY MODE ORCHESTRATION",
    startSecurityModeOrchestration,
  );

  try {
    startAutoAwayMonitor();
  } catch (error) {
    console.log(
      "AUTO AWAY MONITOR START ERROR:",
      error.message,
    );
  }

  try {
    hubUpdatePushCoordinator =
      createHubUpdatePushCoordinator({
        db,
        deviceId: DEVICE_ID,
        getLinkedHomes: getHomesLinkedToThisHub,
        getReceiverUids: getAlarmReceiverUidsForHome,
        getHomeData: getCachedHomeData,
        getLanguageCode: getUserLanguageCode,
        sendPushToUser,
      });

    hubUpdateBridge = createHubUpdateBridge({
      db,
      deviceId: DEVICE_ID,
      currentVersions: SYSTEM_VERSION,
      getLinkedHomes: getHomesLinkedToThisHub,
      onStateChanged: () => {
        void writeHubHeartbeat();
      },
      onReleaseChecked: (releaseState) => {
        return hubUpdatePushCoordinator
          .handleReleaseCheck(releaseState);
      },
    });
    hubUpdateBridge.start();
  } catch (error) {
    console.log(
      "HUB UPDATE BRIDGE START ERROR:",
      error.message,
    );
  }

  startHubHeartbeat();
  startSystemHealthMonitor();

  setInterval(cleanupExpiredAlarmPause, 60000);
  startScheduledReminderMonitor();
  // Kiểm tra lịch Alarm mỗi 10 giây để thời điểm bắt đầu lịch không bị
  // trễ tới gần một phút. Hàm chỉ dùng snapshot cache và gom theo receiver.
  setInterval(() => {
    if (firebaseConnected) {
      void checkScheduledAlarms({ reason: "interval" });
      return;
    }

    void resumeOfflineAlarmDemandsFromSnapshot().catch((error) => {
      console.log(
        "OFFLINE SCHEDULE CHECK ERROR:",
        error.message,
      );
    });
  }, 10000);

  console.log(
    "🛡️ MAIYEN BACKEND READY:",
    firebaseConnected ? "cloud" : "offline_local",
  );
}

startHomeActivityMonitor();
const transferOwnerAcceptInProgress = new Set();

function normalizeHomeOrder(rawOrder) {
  if (Array.isArray(rawOrder)) {
    return rawOrder
      .filter((value) => value != null)
      .map((value) => String(value))
      .filter((value) => value.length > 0);
  }

  if (
    rawOrder &&
    typeof rawOrder === "object"
  ) {
    return Object.keys(rawOrder)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => rawOrder[key])
      .filter((value) => value != null)
      .map((value) => String(value))
      .filter((value) => value.length > 0);
  }

  return [];
}

db.ref("transfer_owner_accept_requests").on(
  "child_added",
  async (snap) => {
    const req = snap.val();
    const requestId = snap.key;

    async function finishRequest(
      status,
      errorMessage = "",
    ) {
      try {
        const result = {
          status,
          processedAt: Date.now(),
        };

        if (errorMessage) {
          result.error = errorMessage;
        }

        await snap.ref.update(result);

        setTimeout(async () => {
          try {
            await snap.ref.remove();
          } catch (_) {}
        }, 30000);
      } catch (_) {}
    }

    try {
      if (!req || !requestId) {
        return;
      }

      if (
        transferOwnerAcceptInProgress.has(
          requestId,
        )
      ) {
        return;
      }

      transferOwnerAcceptInProgress.add(
        requestId,
      );

      const requestedByUid = String(
        req.requestedByUid || "",
      ).trim();

      const oldOwnerUid = String(
        req.oldOwnerUid || "",
      ).trim();

      const newOwnerUid = String(
        req.newOwnerUid || "",
      ).trim();

      const homeId = String(
        req.homeId || "",
      ).trim();

      const requestTime = Number(req.time);
      const now = Date.now();

      const invalidRequest =
        req.status !== "pending" ||
        requestedByUid.length === 0 ||
        oldOwnerUid.length === 0 ||
        newOwnerUid.length === 0 ||
        homeId.length === 0 ||
        requestedByUid !== newOwnerUid ||
        oldOwnerUid === newOwnerUid ||
        !Number.isFinite(requestTime) ||
        requestTime > now + 1000 ||
        requestTime < now - 5 * 60 * 1000;

      if (invalidRequest) {
        await finishRequest(
          "rejected",
          "INVALID DATA",
        );
        return;
      }

      const transferRequestKey =
        `transfer_${homeId}_${oldOwnerUid}`;

      const [
        oldHomeSnap,
        targetHomeSnap,
        transferRequestSnap,
        sharedByHomeSnap,
        oldShareListSnap,
        oldOwnerDirectorySnap,
        newOwnerAccountSnap,
        newOwnerOrderSnap,
      ] = await Promise.all([
        db
          .ref(
            `accounts/${oldOwnerUid}/homes/${homeId}`,
          )
          .once("value"),

        db
          .ref(
            `accounts/${newOwnerUid}/homes/${homeId}`,
          )
          .once("value"),

        db
          .ref(
            `accounts/${newOwnerUid}/shareRequests/${transferRequestKey}`,
          )
          .once("value"),

        db
          .ref(`sharedByHome/${homeId}`)
          .once("value"),

        db
          .ref(
            `accounts/${oldOwnerUid}/shareList/${homeId}`,
          )
          .once("value"),

        db
          .ref(
            `userDirectory/${oldOwnerUid}`,
          )
          .once("value"),

        db
          .ref(`accounts/${newOwnerUid}`)
          .once("value"),

        db
          .ref(
            `accounts/${newOwnerUid}/homeOrder`,
          )
          .once("value"),
      ]);

      if (
        !oldHomeSnap.exists() ||
        !newOwnerAccountSnap.exists()
      ) {
        await finishRequest(
          "rejected",
          "ACCOUNT OR HOME NOT FOUND",
        );
        return;
      }

      if (targetHomeSnap.exists()) {
        await finishRequest(
          "rejected",
          "TARGET HOME ALREADY EXISTS",
        );
        return;
      }

      const transferRequest =
        transferRequestSnap.val() || {};

      const validTransferRequest =
        transferRequest.type ===
          "transfer_owner_request" &&
        transferRequest.homeId === homeId &&
        transferRequest.oldOwnerUid ===
          oldOwnerUid &&
        transferRequest.newOwnerUid ===
          newOwnerUid;

      if (!validTransferRequest) {
        await finishRequest(
          "rejected",
          "TRANSFER REQUEST NOT FOUND",
        );
        return;
      }

      const homeData =
        oldHomeSnap.val() || {};

      const storedOwnerUid = String(
        homeData._ownerUid || "",
      ).trim();

      if (storedOwnerUid !== oldOwnerUid) {
        await finishRequest(
          "rejected",
          "OWNER MISMATCH",
        );
        return;
      }

      const migratedHome = {
        ...homeData,
        _ownerUid: newOwnerUid,
        _shared: false,
      };

      const sharedByHome =
        sharedByHomeSnap.val() || {};

      const oldShareList =
        oldShareListSnap.val() || {};

      const oldOwnerDirectory =
        oldOwnerDirectorySnap.val() || {};

      const oldOwnerMemberData = {
        role: "member",
        email: String(
          oldOwnerDirectory.email || "",
        ),
        name: String(
          oldOwnerDirectory.name || "",
        ),
        photoUrl: String(
          oldOwnerDirectory.photoUrl || "",
        ),
        sharedAt: Date.now(),
      };

      const oldOwnerSharedHome = {
        ownerUid: newOwnerUid,
        role: "member",
      };

      if (homeData.alarmPauseToday) {
        oldOwnerSharedHome.alarmPauseToday =
          homeData.alarmPauseToday;
      }

      const newShareList = {};

      for (
        const [memberUid, rawMember]
        of Object.entries(sharedByHome)
      ) {
        if (
          memberUid === newOwnerUid ||
          memberUid === oldOwnerUid
        ) {
          continue;
        }

        const memberData =
          rawMember &&
          typeof rawMember === "object"
            ? rawMember
            : {};

        const oldListData =
          oldShareList[memberUid] &&
          typeof oldShareList[memberUid] ===
            "object"
            ? oldShareList[memberUid]
            : {};

        newShareList[memberUid] = {
          ...memberData,
          ...oldListData,
          role:
            memberData.role ||
            oldListData.role ||
            "member",
        };
      }

      newShareList[oldOwnerUid] = {
        ...oldOwnerMemberData,
      };

      const newOwnerOrder =
        normalizeHomeOrder(
          newOwnerOrderSnap.val(),
        );

      if (!newOwnerOrder.includes(homeId)) {
        newOwnerOrder.push(homeId);
      }

      const updates = {
        [`accounts/${newOwnerUid}/homes/${homeId}`]:
          migratedHome,

        [`accounts/${oldOwnerUid}/homes/${homeId}`]:
          null,

        [`accounts/${newOwnerUid}/sharedHomes/${homeId}`]:
          null,

        [`accounts/${oldOwnerUid}/sharedHomes/${homeId}`]:
          oldOwnerSharedHome,

        [`sharedByHome/${homeId}/${newOwnerUid}`]:
          null,

        [`sharedByHome/${homeId}/${oldOwnerUid}`]:
          oldOwnerMemberData,

        [`accounts/${oldOwnerUid}/shareList/${homeId}`]:
          null,

        [`accounts/${newOwnerUid}/shareList/${homeId}`]:
          newShareList,

        [`accounts/${newOwnerUid}/homeOrder`]:
          newOwnerOrder,

        [`accounts/${newOwnerUid}/customRules/${homeId}`]:
          null,
      };

      for (
        const memberUid
        of Object.keys(sharedByHome)
      ) {
        if (
          memberUid === newOwnerUid ||
          memberUid === oldOwnerUid
        ) {
          continue;
        }

        updates[
          `accounts/${memberUid}/sharedHomes/${homeId}/ownerUid`
        ] = newOwnerUid;
      }

      const devices =
        homeData.devices &&
        typeof homeData.devices === "object"
          ? homeData.devices
          : {};

      for (
        const deviceId
        of Object.keys(devices)
      ) {
        updates[
          `system/devices_by_ieee/${deviceId}/uid`
        ] = newOwnerUid;

        updates[
          `system/devices_by_ieee/${deviceId}/homeId`
        ] = homeId;
      }

      await db.ref().update(updates);

      for (
        const deviceId
        of Object.keys(devices)
      ) {
        deviceMap[deviceId] = {
          uid: newOwnerUid,
          homeId,
        };
      }

      const transferHomeName =
        String(homeData.name || "").trim() || homeId;
      const newOwnerAccount =
        newOwnerAccountSnap.val() || {};
      const newOwnerProfile =
        newOwnerAccount.profile || {};
      const newOwnerName =
        String(
          newOwnerProfile.name ||
          newOwnerAccount.name ||
          newOwnerAccount.email ||
          "Chủ nhà mới",
        ).trim() || "Chủ nhà mới";
      const oldOwnerName =
        String(
          oldOwnerDirectory.name ||
          oldOwnerDirectory.email ||
          "Chủ nhà cũ",
        ).trim() || "Chủ nhà cũ";
      const transferMessage =
        `${newOwnerName} đã trở thành chủ nhà của "${transferHomeName}".`;
      const transferData = {
        oldOwnerUid,
        oldOwnerName,
        newOwnerUid,
        newOwnerName,
        actorName: newOwnerName,
        homeName: transferHomeName,
      };

      await Promise.all([
        addHomeNotificationFromBackend({
          uid: oldOwnerUid,
          ownerUid: newOwnerUid,
          homeId,
          homeName: transferHomeName,
          type: "transfer_owner_accepted",
          category: "member",
          severity: "success",
          title: "Yêu cầu chuyển quyền chủ nhà",
          message: transferMessage,
          actorUid: newOwnerUid,
          entityType: "home",
          entityId: homeId,
          data: transferData,
        }),
        addHomeNotificationFromBackend({
          uid: newOwnerUid,
          ownerUid: newOwnerUid,
          homeId,
          homeName: transferHomeName,
          type: "transfer_owner_accepted",
          category: "member",
          severity: "success",
          title: "Yêu cầu chuyển quyền chủ nhà",
          message: transferMessage,
          actorUid: newOwnerUid,
          entityType: "home",
          entityId: homeId,
          data: transferData,
        }),
      ]);

      await finishRequest("completed");

      console.log(
        "👑 TRANSFER OWNER COMPLETED:",
        oldOwnerUid,
        "→",
        newOwnerUid,
        homeId,
      );
    } catch (err) {
      console.log(
        "TRANSFER OWNER ACCEPT ERROR:",
        requestId,
        err.message,
      );

      try {
        const failedOldOwnerUid = String(
          req?.oldOwnerUid || "",
        ).trim();
        const failedNewOwnerUid = String(
          req?.newOwnerUid || "",
        ).trim();
        const failedHomeId = String(
          req?.homeId || "",
        ).trim();

        if (
          failedOldOwnerUid &&
          failedNewOwnerUid &&
          failedHomeId
        ) {
          const failedHome =
            getCachedHomeData(
              failedOldOwnerUid,
              failedHomeId,
            ) || {};
          const failedHomeName =
            String(failedHome.name || "").trim() ||
            failedHomeId;
          const failureData = {
            oldOwnerUid: failedOldOwnerUid,
            newOwnerUid: failedNewOwnerUid,
            homeName: failedHomeName,
            reason: String(err.message || "UNKNOWN ERROR").slice(0, 200),
          };

          await Promise.all([
            addHomeNotificationFromBackend({
              uid: failedOldOwnerUid,
              ownerUid: failedOldOwnerUid,
              homeId: failedHomeId,
              homeName: failedHomeName,
              type: "transfer_owner_failed",
              category: "member",
              severity: "warning",
              title: "Yêu cầu chuyển quyền chủ nhà",
              message: `Không thể hoàn tất chuyển quyền chủ nhà "${failedHomeName}".`,
              actorUid: failedNewOwnerUid,
              entityType: "home",
              entityId: failedHomeId,
              data: failureData,
            }),
            addHomeNotificationFromBackend({
              uid: failedNewOwnerUid,
              ownerUid: failedOldOwnerUid,
              homeId: failedHomeId,
              homeName: failedHomeName,
              type: "transfer_owner_failed",
              category: "member",
              severity: "warning",
              title: "Yêu cầu chuyển quyền chủ nhà",
              message: `Không thể hoàn tất chuyển quyền chủ nhà "${failedHomeName}".`,
              actorUid: failedNewOwnerUid,
              entityType: "home",
              entityId: failedHomeId,
              data: failureData,
            }),
          ]);
        }
      } catch (notificationError) {
        console.log(
          "TRANSFER OWNER FAILURE NOTIFICATION ERROR:",
          notificationError.message,
        );
      }

      await finishRequest(
        "rejected",
        err.message || "UNKNOWN ERROR",
      );
    } finally {
      if (requestId) {
        transferOwnerAcceptInProgress.delete(
          requestId,
        );
      }
    }
  },
);
db.ref("alarm_pause_requests").on("child_added", async (snap) => {
  const req = snap.val();
  const requestId = snap.key;

  async function reject(reason) {
    console.log(
      "❌ ALARM PAUSE REQUEST REJECTED:",
      requestId,
      reason,
    );

    try {
      await snap.ref.remove();
    } catch (_) { }
  }

  try {
    if (!req || !requestId) {
      return;
    }

    const ownerUid = String(
      req.ownerUid || "",
    ).trim();

    const homeId = String(
      req.homeId || "",
    ).trim();

    const createdByUid = String(
      req.createdByUid || "",
    ).trim();

    const action = String(
      req.action || "create",
    ).trim();

    const createdAt = Number(req.createdAt);
    const now = Date.now();

    if (
      req.status !== "pending" ||
      ownerUid.length === 0 ||
      homeId.length === 0 ||
      createdByUid.length === 0 ||
      !requestId.endsWith(`_${createdByUid}`) ||
      !Number.isFinite(createdAt) ||
      createdAt > now + 1000 ||
      createdAt < now - 5 * 60 * 1000 ||
      (action !== "create" && action !== "remove")
    ) {
      await reject("INVALID DATA");
      return;
    }

    const homeSnap = await db
      .ref(`accounts/${ownerUid}/homes/${homeId}`)
      .once("value");

    if (!homeSnap.exists()) {
      await reject("HOME NOT FOUND");
      return;
    }

    const home = homeSnap.val() || {};

    let hasPermission = createdByUid === ownerUid;

    if (!hasPermission) {
      const [sharedHomeSnap, sharedMemberSnap] =
        await Promise.all([
          db
            .ref(
              `accounts/${createdByUid}/sharedHomes/${homeId}`,
            )
            .once("value"),

          db
            .ref(
              `sharedByHome/${homeId}/${createdByUid}`,
            )
            .once("value"),
        ]);

      const sharedHome = sharedHomeSnap.val() || {};

      hasPermission =
        sharedHome.ownerUid === ownerUid &&
        sharedMemberSnap.exists();
    }

    if (!hasPermission) {
      await reject("NO PERMISSION");
      return;
    }

    const actorSnap = await db
      .ref(`accounts/${createdByUid}`)
      .once("value");

    const actor = actorSnap.val() || {};
    const actorProfile = actor.profile || {};

    const trustedActorName =
      String(
        actorProfile.name ||
        actor.name ||
        actor.email ||
        "Một thành viên",
      ).trim() || "Một thành viên";

    const sharedSnap = await db
      .ref(`sharedByHome/${homeId}`)
      .once("value");

    const sharedUsers = sharedSnap.val() || {};
    const trustedHomeName =
      String(home.name || "").trim() || homeId;

    if (action === "remove") {
      cancelAlarmPauseExpiryTimer(ownerUid, homeId);
      const updates = {
        [`accounts/${ownerUid}/homes/${homeId}/alarmPauseToday`]:
          null,

        [`alarm_pause_requests/${requestId}`]:
          null,
      };

      for (const sharedUid of Object.keys(sharedUsers)) {
        if (sharedUid === ownerUid) {
          continue;
        }

        updates[
          `accounts/${sharedUid}/sharedHomes/${homeId}/alarmPauseToday`
        ] = null;
      }

      await db.ref().update(updates);

      await addHomeNotificationToHomeRecipients({
        ownerUid,
        homeId,
        homeName: trustedHomeName,
        type: "alarm_pause_cancelled",
        category: "alarm",
        severity: "success",
        title: "Báo động đã hoạt động trở lại",
        message:
          `${trustedActorName} đã huỷ tạm dừng báo động.`,
        actorUid: createdByUid,
        entityType: "home",
        entityId: homeId,
        recipientUids: [
          ownerUid,
          ...Object.keys(sharedUsers),
        ],
        dedupeKey:
          `alarm_pause_cancelled|${requestId}`,
        dedupeMs: 60 * 1000,
        data: {
          actorName: trustedActorName,
          homeName: trustedHomeName,
          reason: "cancelled_early",
        },
      });

      console.log(
        "🧹 ALARM PAUSE REMOVED:",
        ownerUid,
        homeId,
        createdByUid,
      );

      return;
    }

    const date = String(req.date || "").trim();
    const start = String(req.start || "").trim();
    const end = String(req.end || "").trim();
    const reason = String(req.reason || "").trim();
    const startAt = normalizeTimestamp(req.startAt);
    const endAt = normalizeTimestamp(req.endAt);
    const maxPauseDurationMs = 24 * 60 * 60 * 1000;

    if (
      !isValidHHMM(start) ||
      !isValidHHMM(end) ||
      start === end ||
      reason.length > 120 ||
      startAt <= 0 ||
      endAt <= startAt ||
      endAt - startAt > maxPauseDurationMs ||
      startAt < now - 2 * 60 * 1000 ||
      date !== getDateKeyFromTimestamp(startAt)
    ) {
      await reject("INVALID PAUSE DATA");
      return;
    }

    if (
      !doesPauseOverlapEnabledAlarm(
        home,
        startAt,
        endAt,
      )
    ) {
      await reject("OUTSIDE ALARM RANGE");
      return;
    }

    const pauseData = {
      date,
      start,
      end,
      startAt,
      endAt,
      homeName: trustedHomeName,
      reason,
      createdByUid,
      createdByName: trustedActorName,
      createdAt: Date.now(),
    };

    const updates = {
      [`accounts/${ownerUid}/homes/${homeId}/alarmPauseToday`]:
        pauseData,

      [`alarm_pause_requests/${requestId}`]:
        null,
    };

    for (const sharedUid of Object.keys(sharedUsers)) {
      if (sharedUid === ownerUid) {
        continue;
      }

      updates[
        `accounts/${sharedUid}/sharedHomes/${homeId}/alarmPauseToday`
      ] = pauseData;
    }

    await db.ref().update(updates);
    scheduleAlarmPauseExpiry(
      ownerUid,
      homeId,
      pauseData,
    );

    console.log(
      "⏸️ ALARM PAUSE REQUEST APPLIED:",
      ownerUid,
      homeId,
      createdByUid,
    );
  } catch (err) {
    console.log(
      "ALARM PAUSE REQUEST ERROR:",
      err.message,
    );

    try {
      await snap.ref.remove();
    } catch (_) { }
  }
});
db.ref("accounts").on("child_changed", async (snap) => {
  try {
    const ownerUid = snap.key;
    const user = snap.val() || {};
    const homes = user.homes || {};

    for (const [homeId, home] of Object.entries(homes)) {
      const pause = home.alarmPauseToday;

      if (!pause) continue;

      const key =
        `${ownerUid}_${homeId}_${pause.createdAt || 0}`;

      if (lastNotificationMap[key]) {
        continue;
      }

      lastNotificationMap[key] = Date.now();

      const homeName =
        (pause.homeName && pause.homeName.trim()) ||
        (home.name && home.name.trim()) ||
        homeId;

      const actorName =
        pause.createdByName &&
          pause.createdByName.trim().length > 0
          ? pause.createdByName.trim()
          : "Một thành viên";

      const text =
        `Báo động đã được ${actorName} tạm tắt từ ${pause.start} tới ${pause.end}.

Nên trong khoảng thời gian này:
• Một số thiết bị an ninh sẽ tạm ngừng cảnh báo.
• Các cảnh báo nguy hiểm như cháy nổ, ngập nước, chạm chập v.v... vẫn được gửi bình thường.`;

      const sharedSnap = await db
        .ref(`sharedByHome/${homeId}`)
        .once("value");

      const sharedUsers = sharedSnap.val() || {};

      const recipientUids = new Set([
        ownerUid,
        ...Object.keys(sharedUsers),
      ]);

      const pauseReason =
        String(pause.reason || "").trim();

      const homeNotificationMessage =
        `${actorName} đã tạm dừng Báo động từ ${pause.start} đến ${pause.end}.` +
        (
          pauseReason.length > 0
            ? ` Lý do: ${pauseReason}.`
            : ""
        );

      for (const recipientUid of recipientUids) {
        await addHomeNotificationFromBackend({
          uid: recipientUid,
          homeId,
          homeName,
          type: "alarm_pause_started",
          category: "alarm",
          severity: "warning",
          title: "Báo động đã được tạm dừng",
          message: homeNotificationMessage,
          entityType: "home",
          entityId: homeId,
        });

        if (recipientUid === pause.createdByUid) {
          continue;
        }

        await sendAlarmPauseNotification(
          recipientUid,
          homeId,
          homeName,
          text,
        );
      }

      console.log(
        "⏸️ ALARM PAUSE BROADCAST:",
        homeId,
      );
    }
  } catch (err) {
    console.log(
      "ALARM PAUSE WATCH ERROR:",
      err.message,
    );
  }
});

// ================= HOME SIREN ACTION REQUEST =================
// Nút trong DeviceList chỉ tắt còi vật lý của Home. Incident, fullscreen và
// notification vẫn tiếp tục cho đến khi sự cố được xử lý hoặc tự kết thúc.
function scheduleHomeSirenActionRequestCleanup(requestRef) {
  setTimeout(() => {
    void requestRef.remove().catch(() => { });
  }, HOME_SIREN_ACTION_RESULT_TTL_MS);
}

async function finishHomeSirenActionRequest(
  requestRef,
  status,
  details = {},
) {
  await requestRef.update({
    status,
    ...details,
    completedAt: Date.now(),
  });

  scheduleHomeSirenActionRequestCleanup(requestRef);
}

db.ref("home_siren_action_requests").on(
  "child_added",
  async (snap) => {
    const req = snap.val();
    const requestId = snap.key;
    let ownsRequest = false;

    async function reject(reason) {
      console.log(
        "❌ HOME SIREN ACTION REJECTED:",
        requestId,
        reason,
      );

      try {
        await finishHomeSirenActionRequest(
          snap.ref,
          "failed",
          {
            reason,
            processingHubId: DEVICE_ID,
          },
        );
      } catch (_) { }
    }

    try {
      if (!req || !requestId) {
        return;
      }

      if (
        req.status === "succeeded" ||
        req.status === "failed" ||
        req.status === "rejected"
      ) {
        scheduleHomeSirenActionRequestCleanup(snap.ref);
        return;
      }

      if (req.status !== "pending") {
        return;
      }

      if (homeSirenActionInProgress.has(requestId)) {
        return;
      }

      homeSirenActionInProgress.add(requestId);

      const homeId = String(req.homeId || "").trim();
      const requestedHubId = String(req.hubId || "").trim();
      const requestedBy = String(
        req.requestedBy || "",
      ).trim();
      const action = String(req.action || "").trim();
      const createdAt = Number(req.createdAt);
      const now = Date.now();

      if (
        !homeId ||
        !requestedHubId ||
        !requestedBy ||
        action !== "mute" ||
        !Number.isFinite(createdAt) ||
        createdAt > now + 1000 ||
        createdAt < now - 5 * 60 * 1000
      ) {
        ownsRequest = true;
        await reject("invalid_request");
        return;
      }

      let requesterAccount =
        getCachedAccountData(requestedBy);

      if (!requesterAccount) {
        const accountSnap = await db
          .ref(`accounts/${requestedBy}`)
          .once("value");
        requesterAccount = accountSnap.val() || null;
      }

      let ownerUid = "";

      if (requesterAccount?.homes?.[homeId]) {
        ownerUid = requestedBy;
      } else {
        ownerUid = String(
          requesterAccount?.sharedHomes?.[homeId]?.ownerUid || "",
        ).trim();
      }

      if (!ownerUid) {
        ownsRequest = true;
        await reject("home_access_denied");
        return;
      }

      let home = getCachedHomeData(ownerUid, homeId);

      if (!home) {
        const homeSnap = await db
          .ref(`accounts/${ownerUid}/homes/${homeId}`)
          .once("value");
        home = homeSnap.val() || null;
      }

      if (!home) {
        ownsRequest = true;
        await reject("home_not_found");
        return;
      }

      // hubId lưu trong Home là nguồn hiện tại. hubId từ app chỉ là gợi ý để
      // request vẫn đi được khi cache UI vừa cũ hoặc heartbeat vừa đổi Hub.
      const homeHubId = String(home.hubId || "").trim();
      const targetHubId = homeHubId || requestedHubId;

      if (targetHubId !== DEVICE_ID) {
        return;
      }

      ownsRequest = true;

      await snap.ref.update({
        status: "processing",
        processingHubId: DEVICE_ID,
        startedAt: Date.now(),
      });

      const result = await mutePhysicalSirenForHome(
        ownerUid,
        homeId,
        requestedBy,
        { reason: "device_list_mute_button" },
      );

      const succeeded = result.status === "stopped";

      if (succeeded) {
        const actorName = getCachedUserDisplayName(requestedBy);
        const sirenHomeName = String(home.name || homeId).trim() || homeId;

        await addHomeNotificationToHomeRecipients({
          ownerUid,
          homeId,
          homeName: sirenHomeName,
          type: "physical_siren_muted",
          category: "alarm",
          severity: "warning",
          title: "Còi báo động đã được tắt",
          message: "Sự cố vẫn đang được theo dõi.",
          actorUid: requestedBy,
          entityType: "home",
          entityId: homeId,
          dedupeKey: `physical_siren_muted|${homeId}|${requestedBy}`,
          dedupeMs: 5000,
          data: { actorName, requestedBy },
        });
      }

      console.log(
        "🔕 HOME SIREN MUTED FROM DEVICE LIST:",
        requestId,
        requestedBy,
        ownerUid,
        homeId,
        result.status,
        `confirmed=${result.confirmedCount || 0}/${result.deviceCount || 0}`,
      );

      await finishHomeSirenActionRequest(
        snap.ref,
        succeeded ? "succeeded" : "failed",
        {
          resultStatus: result.status,
          ownerUid,
          homeId,
          hubId: DEVICE_ID,
          deviceCount: Number(result.deviceCount || 0),
          successCount: Number(result.successCount || 0),
          confirmedCount: Number(result.confirmedCount || 0),
          reason: succeeded ? "" : result.status,
        },
      );
    } catch (error) {
      console.log(
        "HOME SIREN ACTION ERROR:",
        requestId,
        error.message,
      );

      if (ownsRequest) {
        try {
          await finishHomeSirenActionRequest(
            snap.ref,
            "failed",
            {
              reason: "backend_error",
              error: String(error.message || "").slice(0, 300),
              processingHubId: DEVICE_ID,
            },
          );
        } catch (_) { }
      }
    } finally {
      if (requestId) {
        homeSirenActionInProgress.delete(requestId);
      }
    }
  },
);

// ================= ALARM INCIDENT ACTION REQUEST =================
db.ref("alarm_incident_action_requests").on(
  "child_added",
  async (snap) => {
    const req = snap.val();
    const requestId = snap.key;

    async function reject(reason) {
      console.log(
        "❌ ALARM INCIDENT ACTION REJECTED:",
        requestId,
        reason,
      );

      try {
        await snap.ref.remove();
      } catch (_) { }
    }

    try {
      if (!req || !requestId) {
        return;
      }

      if (alarmIncidentActionInProgress.has(requestId)) {
        return;
      }

      alarmIncidentActionInProgress.add(requestId);

      const receiverUid = String(
        req.receiverUid || "",
      ).trim();
      const incidentId = String(
        req.incidentId || "",
      ).trim();
      const requestedBy = String(
        req.requestedBy || "",
      ).trim();
      const action = String(
        req.action || "",
      ).trim();
      const createdAt = Number(req.createdAt);
      const now = Date.now();

      const allowedActions = new Set([
        "stop",
        "check_home",
        "resolve",
        "mute_siren",
      ]);

      if (
        req.status !== "pending" ||
        !receiverUid ||
        !incidentId ||
        !requestedBy ||
        !allowedActions.has(action) ||
        !Number.isFinite(createdAt) ||
        createdAt > now + 1000 ||
        createdAt < now - 5 * 60 * 1000
      ) {
        await reject("INVALID DATA");
        return;
      }

      const incidentSnap = await db
        .ref(
          `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
        )
        .once("value");

      const incident = incidentSnap.val();

      if (!incident) {
        await reject("INCIDENT NOT FOUND");
        return;
      }

      const ownerUid = String(
        incident.ownerUid || "",
      ).trim();
      const homeId = String(
        incident.homeId || "",
      ).trim();

      if (!ownerUid || !homeId) {
        await reject("INVALID INCIDENT");
        return;
      }

      // Mỗi tài khoản chỉ được xác nhận/tắt incident nằm trong
      // chính tài khoản đó. Một thành viên không được đóng Alarm của
      // thành viên khác trong cùng nhà.
      if (requestedBy !== receiverUid) {
        await reject("NO PERMISSION");
        return;
      }

      // "Kiểm tra nhà" chỉ xác nhận cho đúng tài khoản đang bấm.
      // Không đóng trạng thái nguy hiểm, không tắt còi vật lý và tuyệt đối
      // không dừng notification/fullscreen của Owner hoặc thành viên khác.
      // Cùng event trên tài khoản này chỉ được báo lại sau khi sensor trở về
      // an toàn và hết cooldown.
      if (action === "check_home" && incident.status === "active") {
        const isHomeParticipant =
          requestedBy === ownerUid ||
          Boolean(
            sharedByHomeCache.get(homeId)?.[requestedBy],
          );

        if (!isHomeParticipant) {
          await reject("NO HOME PERMISSION");
          return;
        }

        const acknowledged = await acknowledgeAlarmIncidentForReceiver({
          receiverUid,
          incidentId,
          acknowledgedBy: requestedBy,
        });

        if (!acknowledged) {
          await reject("INCIDENT NOT ACTIVE");
          return;
        }

        await snap.ref.remove();

        console.log(
          "👀 ALARM INCIDENT CHECKED FOR RECEIVER:",
          requestId,
          receiverUid,
          incidentId,
        );

        return;
      }

      // Tắt riêng còi vật lý của Home nhưng giữ nguyên incident, fullscreen
      // và notification. Mute được gắn với snapshot các incident active hiện
      // tại; sự cố mới sau đó vẫn có thể bật còi trở lại.
      if (action === "mute_siren") {
        if (incident.status === "active") {
          await mutePhysicalSirenForHome(
            ownerUid,
            homeId,
            requestedBy,
            { reason: "manual_mute_button" },
          );

          await db
            .ref(
              `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
            )
            .update({
              homeSirenStatus: "manual_muted",
              homeSirenMutedAt: now,
              homeSirenMutedBy: requestedBy,
              updatedAt: now,
            });

          const mutedHome = getCachedHomeData(ownerUid, homeId) || {};
          const mutedHomeName = String(
            mutedHome.name || incident.homeName || homeId,
          ).trim() || homeId;
          const actorName = getCachedUserDisplayName(requestedBy);

          await addHomeNotificationToHomeRecipients({
            ownerUid,
            homeId,
            homeName: mutedHomeName,
            type: "physical_siren_muted",
            category: "alarm",
            severity: "warning",
            title: "Còi báo động đã được tắt",
            message: "Sự cố vẫn đang được theo dõi.",
            actorUid: requestedBy,
            entityType: "home",
            entityId: homeId,
            dedupeKey: `physical_siren_muted|${homeId}|${requestedBy}`,
            dedupeMs: 5000,
            data: { actorName, requestedBy, incidentId },
          });
        }

        await snap.ref.remove();

        console.log(
          "🔕 ALARM HOME SIREN MUTED:",
          requestId,
          receiverUid,
          incidentId,
        );

        return;
      }

      // Idempotent: nếu thiết bị khác của cùng tài khoản hoặc một
      // request trước đó đã xử lý incident này, lần bấm sau vẫn được
      // coi là thành công và chỉ đóng Alarm của tài khoản hiện tại.
      if (incident.status !== "active") {
        await sendAlarmResolvedPush({
          uid: receiverUid,
          incidentId,
          homeId,
          resolvedBy: String(
            incident.resolvedBy || requestedBy,
          ),
          action: String(
            incident.resolutionAction ||
            incident.status ||
            "already_resolved",
          ),
          flowType: String(
            incident.flowType || incident.eventCategory || "security",
          ),
          status: String(incident.status || "resolved"),
          hasRemainingActiveIncidents:
            hasLocalActiveAlarmIncidentForReceiver(receiverUid),
        });

        await snap.ref.remove();

        console.log(
          "✅ ALARM ACTION ALREADY RESOLVED:",
          requestId,
          receiverUid,
          incidentId,
          incident.status,
        );

        return;
      }

      // "Tắt cảnh báo"/"Đã xử lý" là hành động cho cùng một sự cố vật lý
      // của Home. Sau khi xác thực người thao tác thuộc Home, đóng đồng thời
      // mọi bản sao incident của Owner và Member để các máy không còn hiển thị
      // trạng thái khác nhau hoặc nhận lại payload cũ của cùng sự cố.
      const isHomeParticipant =
        requestedBy === ownerUid ||
        Boolean(
          sharedByHomeCache.get(homeId)?.[requestedBy],
        );

      if (!isHomeParticipant) {
        await reject("NO HOME PERMISSION");
        return;
      }

      if (action === "stop") {
        await mutePhysicalSirenForHome(
          ownerUid,
          homeId,
          requestedBy,
          { reason: "stop_alarm_button" },
        );
      }

      const flowType = String(
        incident.flowType || incident.eventCategory || "security",
      ) === "emergency"
        ? "emergency"
        : "security";

      await resolveAlarmIncidentGroupForHome({
        ownerUid,
        homeId,
        flowType,
        resolvedBy: requestedBy,
        action,
      });

      await snap.ref.remove();
    } catch (err) {
      console.log(
        "ALARM INCIDENT ACTION ERROR:",
        requestId,
        err.message,
      );

      try {
        await snap.ref.remove();
      } catch (_) { }
    } finally {
      if (requestId) {
        alarmIncidentActionInProgress.delete(requestId);
      }
    }
  },
);

// ================= MQTT CONNECT =================
client.on("connect", () => {
  mqttConnected = true;

  console.log("MQTT CONNECTED");
  client.subscribe("zigbee2mqtt/#");

  // Cập nhật ngay để app biết MQTT đã hoạt động.
  void writeHubHeartbeat();

  // Nếu MQTT vừa mất kết nối trong lúc có Alarm, gửi lại trạng thái còi.
  setTimeout(() => {
    void reconcileAllPhysicalSirens({
      force: true,
      reason: "mqtt_connected",
    });
  }, 1000);
});

client.on("offline", () => {
  mqttConnected = false;
  void writeHubHeartbeat();
});

client.on("close", () => {
  mqttConnected = false;
});

// ================= MQTT DEVICE INGESTION DOMAIN =================
// Owns Zigbee device availability, CO fast-path throttling, telemetry
// persistence, sensor-state normalization and Alarm fanout.
const mqttDeviceIngestionDomain = createMqttDeviceIngestionDomain({
  client,
  db,
  deviceMap,
  getFirebaseConnected: () => firebaseConnected,
  getCachedHomeData,
  applyDeviceUpdateToLocalCache,
  enqueueOfflineFirebaseUpdate,
  buildDeviceFirebaseUpdate,
  firebaseUpdateContainsTelemetry,
  updatePersistedTelemetrySnapshot,
  isActiveSignal,
  isVibrationAction,
  isGlassBreakAction,
  normalizeLockState,
  inferDeviceTypeFromPayload,
  applyEmergencyStatusLatch,
  scheduleEmergencyStatusClear,
  scheduleSosStateClear,
  scheduleVibrationStateClear,
  cancelVibrationStateClear,
  getHomeSirenRuntime,
  setPhysicalSirenForHome,
  validateSecurityIncidentsForHome,
  isPersistentEmergencyIncidentItem,
  isEmergencyIncidentItemStillUnsafe,
  resolveClearedPersistentEmergencyIncidents,
  addDeviceNotification,
  getAlarmReceiverUidsForHome,
  processScheduleAlarmsForOwner,
  reconcileOfflineAlarmDemandsForHome,
  emergencyStatusHoldMs: EMERGENCY_STATUS_HOLD_MS,
  vibrationActiveWindowMs: VIBRATION_ACTIVE_WINDOW_MS,
  log: (...args) => console.log(...args),
});

const {
  forgetDeviceRuntime,
  startMqttDeviceIngestion,
  stopMqttDeviceIngestion,
} = mqttDeviceIngestionDomain;

// ================= DEVICE MANAGEMENT DOMAIN =================
// Owns the canonical device index, pairing authorization, permit-join,
// Zigbee interview persistence and guarded device deletion.
const deviceManagementDomain = createDeviceManagementDomain({
  client,
  db,
  deviceMap,
  deviceId: DEVICE_ID,
  getDeviceTypeFromModel,
  isSecurityDeviceType,
  getCachedHomeData,
  getSharedMembersForHome: (homeId) => {
    return sharedByHomeCache.get(homeId) || {};
  },
  addHomeNotificationToHomeRecipients,
  scheduleLocalRuntimeSnapshotSave,
  forgetDeviceRuntime,
  log: (...args) => console.log(...args),
});

const {
  startDeviceManagement,
  stopDeviceManagement,
} = deviceManagementDomain;

startMqttDeviceIngestion();

init().catch((error) => {
  console.log("BACKEND INIT ERROR:", error.message);
});

process.once("SIGTERM", async () => {
  hubUpdateBridge?.stop();
  await stopDeviceManagement();
  stopMqttDeviceIngestion();
  stopSecurityModeOrchestration();
  stopHomeActivityMonitor();
  stopScheduledReminderMonitor();
  persistRuntimeBeforeExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", async () => {
  hubUpdateBridge?.stop();
  await stopDeviceManagement();
  stopMqttDeviceIngestion();
  stopSecurityModeOrchestration();
  stopHomeActivityMonitor();
  stopScheduledReminderMonitor();
  persistRuntimeBeforeExit("SIGINT");
  process.exit(0);
});
