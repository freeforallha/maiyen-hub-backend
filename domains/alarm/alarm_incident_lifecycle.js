"use strict";

const crypto = require("crypto");

function createAlarmIncidentLifecycle({
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
  alarmStageRetryDelayMs,
  alarmStageMaxRetryCount,
  alarmIncidentAutoExpireMs,
  alarmIncidentCallDelayMs,
  emergencyCallDelayMs,
  iosTimeSensitiveAlertsEnabled = true,
  iosCriticalAlertsEnabled = false,
}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("db.ref is required");
  }

  const requiredFunctions = {
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
  };

  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }

  const requiredState = {
    alarmIncidentTimerMap,
    alarmIncidentAdvanceInProgress,
    alarmIncidentStartPromiseMap,
    alarmIncidentQueuedStageMap,
    alarmIncidentStageRetryCountMap,
  };

  for (const [name, value] of Object.entries(requiredState)) {
    if (!value || typeof value !== "object") {
      throw new TypeError(`${name} must be an object`);
    }
  }

  const ALARM_STAGE_RETRY_DELAY_MS = Number(alarmStageRetryDelayMs);
  const ALARM_STAGE_MAX_RETRY_COUNT = Number(alarmStageMaxRetryCount);
  const ALARM_INCIDENT_AUTO_EXPIRE_MS = Number(alarmIncidentAutoExpireMs);
  const ALARM_INCIDENT_CALL_DELAY_MS = Number(alarmIncidentCallDelayMs);
  const EMERGENCY_CALL_DELAY_MS = Number(emergencyCallDelayMs);
  const IOS_TIME_SENSITIVE_ALERTS_ENABLED =
    iosTimeSensitiveAlertsEnabled === true;
  const IOS_CRITICAL_ALERTS_ENABLED =
    iosCriticalAlertsEnabled === true;

  for (const [name, value] of Object.entries({
    ALARM_STAGE_RETRY_DELAY_MS,
    ALARM_STAGE_MAX_RETRY_COUNT,
    ALARM_INCIDENT_AUTO_EXPIRE_MS,
    ALARM_INCIDENT_CALL_DELAY_MS,
    EMERGENCY_CALL_DELAY_MS,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be non-negative`);
    }
  }

  function clearAlarmIncidentTimers(uid, incidentId) {
    const key = getAlarmIncidentTimerKey(uid, incidentId);
    const timers = alarmIncidentTimerMap[key] || {};

    for (const timer of Object.values(timers)) {
      if (timer) {
        clearTimeout(timer);
      }
    }

    delete alarmIncidentTimerMap[key];

    const retryPrefix = `${uid}_${incidentId}_`;

    for (const retryKey of Array.from(
      alarmIncidentStageRetryCountMap.keys(),
    )) {
      if (retryKey.startsWith(retryPrefix)) {
        alarmIncidentStageRetryCountMap.delete(retryKey);
      }
    }
  }

  function rescheduleAlarmIncidentExpireTimer(
    receiverUid,
    incidentId,
    expireAt,
  ) {
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
      Math.max(0, Number(expireAt || 0) - Date.now()),
    );

    alarmIncidentTimerMap[key] = timers;
  }

  function queueAlarmIncidentAdvance(
    receiverUid,
    incidentId,
    targetStage,
  ) {
    const lockKey = `${receiverUid}_${incidentId}`;
    const current = alarmIncidentQueuedStageMap.get(lockKey);

    if (
      !current ||
      getAlarmStagePriority(targetStage) >
        getAlarmStagePriority(current)
    ) {
      alarmIncidentQueuedStageMap.set(lockKey, targetStage);
    }
  }

  function resetAlarmStageRetry(
    receiverUid,
    incidentId,
    targetStage,
  ) {
    alarmIncidentStageRetryCountMap.delete(
      getAlarmStageRetryKey(
        receiverUid,
        incidentId,
        targetStage,
      ),
    );
  }

  function scheduleAlarmIncidentStageRetry(
    receiverUid,
    incidentId,
    targetStage,
  ) {
    const retryKey = getAlarmStageRetryKey(
      receiverUid,
      incidentId,
      targetStage,
    );
    const retryCount =
      Number(alarmIncidentStageRetryCountMap.get(retryKey) || 0) + 1;

    if (retryCount > ALARM_STAGE_MAX_RETRY_COUNT) {
      console.log(
        "⚠️ ALARM STAGE RETRY LIMIT:",
        receiverUid,
        incidentId,
        targetStage,
      );
      return;
    }

    alarmIncidentStageRetryCountMap.set(
      retryKey,
      retryCount,
    );

    const timerKey = getAlarmIncidentTimerKey(
      receiverUid,
      incidentId,
    );
    const timers = alarmIncidentTimerMap[timerKey] || {};
    const slot = `retry_${targetStage}`;

    if (timers[slot]) {
      clearTimeout(timers[slot]);
    }

    timers[slot] = setTimeout(() => {
      const latestTimers =
        alarmIncidentTimerMap[timerKey] || {};
      delete latestTimers[slot];
      alarmIncidentTimerMap[timerKey] = latestTimers;

      void advanceAlarmIncidentToStage(
        receiverUid,
        incidentId,
        targetStage,
      );
    }, ALARM_STAGE_RETRY_DELAY_MS);

    alarmIncidentTimerMap[timerKey] = timers;

    console.log(
      "🔁 ALARM STAGE RETRY SCHEDULED:",
      receiverUid,
      incidentId,
      targetStage,
      `attempt=${retryCount}`,
    );
  }

  async function retryInitialAlarmIncidentPush(
    receiverUid,
    incidentId,
    stage,
    flowType,
  ) {
    const incidentRef = db.ref(
      `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
    );
    const snap = await incidentRef.once("value");
    const incident = snap.val();

    if (!incident || incident.status !== "active") {
      resetAlarmStageRetry(
        receiverUid,
        incidentId,
        stage,
      );
      return;
    }

    if (Number(incident.presentationSuppressedAt || 0) > 0) {
      resetAlarmStageRetry(
        receiverUid,
        incidentId,
        stage,
      );
      return;
    }

    let items = normalizeAlarmIncidentItems(incident.items);

    if (flowType === "security") {
      const validation =
        await validateAndResolveSecurityIncident(
          receiverUid,
          incidentId,
          incident,
          { reasonHint: `retry_${stage}` },
        );

      if (!validation.active) {
        return;
      }

      items = validation.items;
    }

    const sent = await sendAlarmStageSummary(
      receiverUid,
      items,
      {
        incidentId,
        stage,
        flowType,
      },
    );

    if (!sent) {
      scheduleInitialAlarmIncidentPushRetry(
        receiverUid,
        incidentId,
        stage,
        flowType,
      );
      return;
    }

    resetAlarmStageRetry(
      receiverUid,
      incidentId,
      stage,
    );

    await incidentRef.update({
      initialPushSentAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  function scheduleInitialAlarmIncidentPushRetry(
    receiverUid,
    incidentId,
    stage,
    flowType,
  ) {
    const retryKey = getAlarmStageRetryKey(
      receiverUid,
      incidentId,
      stage,
    );
    const retryCount =
      Number(alarmIncidentStageRetryCountMap.get(retryKey) || 0) + 1;

    if (retryCount > ALARM_STAGE_MAX_RETRY_COUNT) {
      console.log(
        "⚠️ INITIAL ALARM PUSH RETRY LIMIT:",
        receiverUid,
        incidentId,
        stage,
      );
      return;
    }

    alarmIncidentStageRetryCountMap.set(
      retryKey,
      retryCount,
    );

    const timerKey = getAlarmIncidentTimerKey(
      receiverUid,
      incidentId,
    );
    const timers = alarmIncidentTimerMap[timerKey] || {};
    const slot = `retry_initial_${stage}`;

    if (timers[slot]) {
      clearTimeout(timers[slot]);
    }

    timers[slot] = setTimeout(() => {
      const latestTimers =
        alarmIncidentTimerMap[timerKey] || {};
      delete latestTimers[slot];
      alarmIncidentTimerMap[timerKey] = latestTimers;

      void retryInitialAlarmIncidentPush(
        receiverUid,
        incidentId,
        stage,
        flowType,
      );
    }, ALARM_STAGE_RETRY_DELAY_MS);

    alarmIncidentTimerMap[timerKey] = timers;
  }

  async function withAlarmIncidentStartLock(
    lockKey,
    callback,
  ) {
    const previous =
      alarmIncidentStartPromiseMap.get(lockKey) ||
      Promise.resolve();

    let releaseCurrent;
    const currentGate = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const currentTail = previous
      .catch(() => {})
      .then(() => currentGate);

    alarmIncidentStartPromiseMap.set(
      lockKey,
      currentTail,
    );

    await previous.catch(() => {});

    try {
      return await callback();
    } finally {
      releaseCurrent();

      if (
        alarmIncidentStartPromiseMap.get(lockKey) ===
        currentTail
      ) {
        alarmIncidentStartPromiseMap.delete(lockKey);
      }
    }
  }

  function getMaiYenAndroidAlarmCollapseKey({
    uid,
    incidentId,
    homeId,
    flowType = "security",
  }) {
    const identity = [
      "safehome_alarm",
      String(uid || ""),
      String(incidentId || homeId || "general"),
      String(flowType || "security"),
    ].join("|");

    return `safehome-${crypto
      .createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 40)}`;
  }

  function getMaiYenAlarmDeliveryId({
    uid,
    incidentId,
    stage,
    flowType = "security",
    items = [],
  }) {
    const itemKeys = normalizeAlarmIncidentItems(items)
      .map(getAlarmIncidentItemIdentity)
      .sort();
    const identity = [
      String(uid || ""),
      String(incidentId || ""),
      String(stage || "alarm"),
      String(flowType || "security"),
      ...itemKeys,
    ].join("|");

    return crypto
      .createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 32);
  }

  function getMaiYenIosAlarmCategory(flowType = "security") {
    return flowType === "emergency"
      ? "SAFEHOME_EMERGENCY_ALARM"
      : "SAFEHOME_SECURITY_ALARM";
  }

  function getMaiYenIosAlarmThreadId(homeId) {
    const cleanHomeId = String(homeId || "")
      .trim()
      .replace(/[^A-Za-z0-9_.-]/g, "_");

    return `safehome_alarm_${cleanHomeId || "all"}`;
  }

  function getMaiYenIosAlarmCollapseId({
    uid,
    incidentId,
    homeId,
    flowType,
  }) {
    const identity = [
      "safehome_alarm",
      String(uid || ""),
      String(incidentId || homeId || "general"),
      String(flowType || "security"),
    ].join("|");

    return `safehome-${crypto
      .createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 40)}`;
  }

  function buildMaiYenAlarmApnsConfig({
    uid,
    incidentId,
    homeId,
    flowType = "security",
    stage = "alarm",
    title,
    body,
    playSound = true,
  }) {
    const isEmergency = flowType === "emergency";
    const useCritical =
      isEmergency &&
      IOS_CRITICAL_ALERTS_ENABLED &&
      playSound;
    const useTimeSensitive = IOS_TIME_SENSITIVE_ALERTS_ENABLED;
    const aps = {
      alert: {
        title,
        body,
      },
      badge: 1,
      category: getMaiYenIosAlarmCategory(flowType),
      threadId: getMaiYenIosAlarmThreadId(homeId),
      contentAvailable: true,
    };

    // Firebase Admin cho phép custom keys trong aps. Apple đọc key này từ
    // iOS 15+; iOS 14 bỏ qua và vẫn hiện notification có âm thanh bình thường.
    if (useCritical) {
      aps["interruption-level"] = "critical";
    } else if (useTimeSensitive) {
      aps["interruption-level"] = "time-sensitive";
    }

    if (playSound) {
      aps.sound = useCritical
        ? {
            critical: true,
            name: "default",
            volume: 1.0,
          }
        : "default";
    }

    return {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-collapse-id": getMaiYenIosAlarmCollapseId({
          uid,
          incidentId,
          homeId,
          flowType,
        }),
      },
      payload: {
        aps,
      },
    };
  }

  async function getActiveAlarmIncident(
    receiverUid,
    targetKey,
  ) {
    const indexRef = db.ref(
      `accounts/${receiverUid}/activeAlarmIncidentByTarget/${targetKey}`,
    );

    const incidentIdSnap = await indexRef.once("value");
    const incidentId = String(
      incidentIdSnap.val() || "",
    ).trim();

    if (!incidentId) {
      return null;
    }

    const incidentRef = db.ref(
      `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
    );

    const incidentSnap = await incidentRef.once("value");
    const incident = incidentSnap.val();

    if (!incident || incident.status !== "active") {
      await indexRef.remove();
      return null;
    }

    setLocalActiveAlarmIncident(
      receiverUid,
      incidentId,
      incident,
    );

    return {
      incidentId,
      incident,
    };
  }

  async function advanceAlarmIncidentToStage(
    receiverUid,
    incidentId,
    targetStage,
  ) {
    const lockKey = `${receiverUid}_${incidentId}`;

    if (alarmIncidentAdvanceInProgress.has(lockKey)) {
      queueAlarmIncidentAdvance(
        receiverUid,
        incidentId,
        targetStage,
      );
      return;
    }

    alarmIncidentAdvanceInProgress.add(lockKey);

    try {
      const incidentRef = db.ref(
        `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
      );

      let incidentSnap = await incidentRef.once("value");
      let incident = incidentSnap.val();

      if (!incident || incident.status !== "active") {
        return;
      }

      const flowType =
        incident.flowType === "emergency"
          ? "emergency"
          : "security";

      const order = flowType === "emergency"
        ? [
            "notification",
            "fullscreen_siren",
            "calling",
          ]
        : [
            "detected",
            "alarm",
            "siren",
            "calling",
          ];

      const targetRank = order.indexOf(targetStage);

      if (targetRank < 1) {
        return;
      }

      let currentRank = order.indexOf(
        String(
          incident.stage ||
          (flowType === "emergency"
            ? "notification"
            : "detected"),
        ),
      );

      if (currentRank < 0) {
        currentRank = 0;
      }

      for (
        let nextRank = currentRank + 1;
        nextRank <= targetRank;
        nextRank++
      ) {
        incidentSnap = await incidentRef.once("value");
        incident = incidentSnap.val();

        if (!incident || incident.status !== "active") {
          return;
        }

        const nextStage = order[nextRank];
        let items = normalizeAlarmIncidentItems(
          incident.items,
        );

        if (flowType === "security") {
          const validation =
            await validateAndResolveSecurityIncident(
              receiverUid,
              incidentId,
              incident,
              {
                reasonHint: `before_${nextStage}`,
              },
            );

          if (!validation.active) {
            return;
          }

          items = validation.items;

          // validateAndResolveSecurityIncident có thể vừa làm mới cài đặt
          // Notification/fullscreen/còi theo dữ liệu hiện tại. Đồng bộ lại biến
          // incident trong chính lượt advance này để không tiếp tục dùng snapshot
          // cũ rồi bỏ qua Fullscreen của Owner.
          const runtimePreferences =
            getAlarmIncidentRuntimePreferences(items);
          incident = {
            ...incident,
            items,
            notificationEnabled:
              runtimePreferences.notificationEnabled,
            fullscreenEnabled:
              runtimePreferences.fullscreenEnabled,
            physicalSirenEnabled:
              runtimePreferences.physicalSirenEnabled,
          };
        } else {
          const allowedEmergencyItems = [];

          for (const item of items) {
            if (await isAlarmItemAllowedByCurrentHomeMode(item)) {
              allowedEmergencyItems.push(item);
            }
          }

          if (allowedEmergencyItems.length === 0) {
            return;
          }

          items = allowedEmergencyItems;
        }

        const now = Date.now();

        if (nextStage === "alarm") {
          const notificationItems = Number(
            incident.presentationSuppressedAt || 0,
          ) > 0
            ? []
            : items.filter(
                (item) => item.notificationEnabled !== false,
              );

          if (notificationItems.length === 0) {
            await incidentRef.update({
              stage: "alarm",
              alarmSentAt: now,
              updatedAt: now,
            });
            continue;
          }

          const sent = await sendAlarmStageSummary(
            receiverUid,
            notificationItems,
            {
              incidentId,
              stage: "alarm",
              flowType,
            },
          );

          if (!sent) {
            scheduleAlarmIncidentStageRetry(
              receiverUid,
              incidentId,
              "alarm",
            );
            return;
          }

          resetAlarmStageRetry(
            receiverUid,
            incidentId,
            "alarm",
          );

          await incidentRef.update({
            stage: "alarm",
            alarmSentAt: now,
            updatedAt: now,
          });
        } else if (nextStage === "siren") {
          if (incident.physicalSirenEnabled !== false) {
            await requestPhysicalSirenForIncident(
              receiverUid,
              incidentId,
              incident,
              "security_siren_stage",
            );
          }

          const fullscreenItems = Number(
            incident.presentationSuppressedAt || 0,
          ) > 0
            ? []
            : items.filter(
                (item) => item.fullscreenEnabled !== false,
              );

          if (fullscreenItems.length === 0) {
            await incidentRef.update({
              stage: "siren",
              sirenSentAt: now,
              updatedAt: now,
            });
            continue;
          }

          const sent = await sendAlarmStageSummary(
            receiverUid,
            fullscreenItems,
            {
              incidentId,
              stage: "siren",
              flowType,
            },
          );

          if (!sent) {
            scheduleAlarmIncidentStageRetry(
              receiverUid,
              incidentId,
              "siren",
            );
            return;
          }

          resetAlarmStageRetry(
            receiverUid,
            incidentId,
            "siren",
          );

          await incidentRef.update({
            stage: "siren",
            sirenSentAt: now,
            fullscreenSentAt: now,
            updatedAt: now,
          });
        } else if (
          nextStage === "fullscreen_siren"
        ) {
          // Còi vật lý là cài đặt chung của Home và phải độc lập với
          // tùy chọn đánh thức màn hình của từng tài khoản.
          if (incident.physicalSirenEnabled !== false) {
            await requestPhysicalSirenForIncident(
              receiverUid,
              incidentId,
              incident,
              "emergency_fullscreen_siren_stage",
            );
          }

          const fullscreenItems = Number(
            incident.presentationSuppressedAt || 0,
          ) > 0
            ? []
            : items.filter(
                (item) => item.fullscreenEnabled !== false,
              );

          if (fullscreenItems.length === 0) {
            await incidentRef.update({
              stage: "fullscreen_siren",
              fullscreenSentAt: now,
              updatedAt: now,
            });
            continue;
          }

          const sent = await sendAlarmStageSummary(
            receiverUid,
            fullscreenItems,
            {
              incidentId,
              stage: "fullscreen_siren",
              flowType,
            },
          );

          if (!sent) {
            scheduleAlarmIncidentStageRetry(
              receiverUid,
              incidentId,
              "fullscreen_siren",
            );
            return;
          }

          resetAlarmStageRetry(
            receiverUid,
            incidentId,
            "fullscreen_siren",
          );

          await incidentRef.update({
            stage: "fullscreen_siren",
            fullscreenSentAt: now,
            updatedAt: now,
          });

          console.log(
            "📢 HOME SIREN STAGE READY:",
            receiverUid,
            incidentId,
            incident.homeId,
          );
        } else if (nextStage === "calling") {
          // Chưa gọi thật cho tới khi kết nối Cloud Telephony.
          await incidentRef.update({
            stage: "calling",
            callStatus: "waiting_provider",
            callRequestedAt: now,
            updatedAt: now,
          });

          console.log(
            "📞 ALARM CALL STAGE READY:",
            receiverUid,
            incidentId,
            incident.homeId,
          );
        }
      }
    } catch (err) {
      console.log(
        "ALARM INCIDENT ADVANCE ERROR:",
        receiverUid,
        incidentId,
        targetStage,
        err.message,
      );
    } finally {
      alarmIncidentAdvanceInProgress.delete(lockKey);

      const queuedStage =
        alarmIncidentQueuedStageMap.get(lockKey);

      if (queuedStage) {
        alarmIncidentQueuedStageMap.delete(lockKey);

        setImmediate(() => {
          void advanceAlarmIncidentToStage(
            receiverUid,
            incidentId,
            queuedStage,
          );
        });
      }
    }
  }

  function scheduleAlarmIncidentStages(
    receiverUid,
    incidentId,
    incident,
  ) {
    clearAlarmIncidentTimers(receiverUid, incidentId);

    if (!incident || incident.status !== "active") {
      return;
    }

    const key = getAlarmIncidentTimerKey(
      receiverUid,
      incidentId,
    );

    const now = Date.now();
    const detectedAt = Number(
      incident.detectedAt || incident.createdAt || now,
    );

    const expireAt = Number(
      incident.expireAt ||
        detectedAt + ALARM_INCIDENT_AUTO_EXPIRE_MS,
    );

    const flowType =
      incident.flowType === "emergency"
        ? "emergency"
        : "security";

    if (flowType === "emergency") {
      const fullscreenDueAt = Number(
        incident.fullscreenDueAt ||
          detectedAt,
      );

      const callDueAt = Number(
        incident.callDueAt ||
          detectedAt + EMERGENCY_CALL_DELAY_MS,
      );

      alarmIncidentTimerMap[key] = {
        fullscreenSiren:
          incident.physicalSirenEnabled === false &&
          incident.fullscreenEnabled === false
            ? null
            : setTimeout(
              () => {
                void advanceAlarmIncidentToStage(
                  receiverUid,
                  incidentId,
                  "fullscreen_siren",
                );
              },
              Math.max(0, fullscreenDueAt - now),
            ),
        calling: setTimeout(
          () => {
            void advanceAlarmIncidentToStage(
              receiverUid,
              incidentId,
              "calling",
            );
          },
          Math.max(0, callDueAt - now),
        ),
        expire: setTimeout(
          () => {
            void expireAlarmIncident(
              receiverUid,
              incidentId,
            );
          },
          Math.max(0, expireAt - now),
        ),
      };

      return;
    }

    const alarmDueAt = Number(
      incident.alarmDueAt ||
        detectedAt,
    );

    const sirenDueAt = Number(
      incident.sirenDueAt ||
        detectedAt,
    );

    const callDueAt = Number(
      incident.callDueAt ||
        detectedAt + ALARM_INCIDENT_CALL_DELAY_MS,
    );

    alarmIncidentTimerMap[key] = {
      alarm: setTimeout(
        () => {
          void advanceAlarmIncidentToStage(
            receiverUid,
            incidentId,
            "alarm",
          );
        },
        Math.max(0, alarmDueAt - now),
      ),
      siren:
        incident.physicalSirenEnabled === false &&
        incident.fullscreenEnabled === false
          ? null
          : setTimeout(
              () => {
                void advanceAlarmIncidentToStage(
                  receiverUid,
                  incidentId,
                  "siren",
                );
              },
              Math.max(0, sirenDueAt - now),
            ),
      calling: setTimeout(
        () => {
          void advanceAlarmIncidentToStage(
            receiverUid,
            incidentId,
            "calling",
          );
        },
        Math.max(0, callDueAt - now),
      ),
      expire: setTimeout(
        () => {
          void expireAlarmIncident(
            receiverUid,
            incidentId,
          );
        },
        Math.max(0, expireAt - now),
      ),
    };

    scheduleSecurityModeRepeatTimer(
      receiverUid,
      incidentId,
      incident,
    );
  }

  return {
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
  };
}

module.exports = {
  createAlarmIncidentLifecycle,
};
