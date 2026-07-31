"use strict";

const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const REQUEST_FUTURE_SKEW_MS = 1000;
const HOME_SIREN_RESULT_TTL_MS = 30 * 1000;
const MAX_ALARM_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function cleanText(value) {
  return String(value || "").trim();
}

function isFreshRequestTime(
  timestamp,
  currentTime,
  {
    maxAgeMs = REQUEST_MAX_AGE_MS,
    futureSkewMs = REQUEST_FUTURE_SKEW_MS,
  } = {},
) {
  const value = Number(timestamp);
  const now = Number(currentTime);

  return Boolean(
    Number.isFinite(value) &&
      Number.isFinite(now) &&
      value <= now + futureSkewMs &&
      value >= now - maxAgeMs,
  );
}

function normalizeAlarmPauseRequest(rawRequest, requestId, now) {
  const request = asObject(rawRequest);
  const normalized = {
    requestId: cleanText(requestId),
    status: cleanText(request.status),
    ownerUid: cleanText(request.ownerUid),
    homeId: cleanText(request.homeId),
    createdByUid: cleanText(request.createdByUid),
    action: cleanText(request.action || "create"),
    createdAt: Number(request.createdAt),
    date: cleanText(request.date),
    start: cleanText(request.start),
    end: cleanText(request.end),
    reason: cleanText(request.reason),
    startAt: Number(request.startAt),
    endAt: Number(request.endAt),
  };

  normalized.valid = Boolean(
    normalized.requestId &&
      normalized.status === "pending" &&
      normalized.ownerUid &&
      normalized.homeId &&
      normalized.createdByUid &&
      normalized.requestId.endsWith(`_${normalized.createdByUid}`) &&
      isFreshRequestTime(normalized.createdAt, now) &&
      (normalized.action === "create" || normalized.action === "remove"),
  );

  return normalized;
}

function normalizeHomeSirenActionRequest(rawRequest, requestId, now) {
  const request = asObject(rawRequest);
  const normalized = {
    requestId: cleanText(requestId),
    status: cleanText(request.status),
    homeId: cleanText(request.homeId),
    hubId: cleanText(request.hubId),
    requestedBy: cleanText(request.requestedBy),
    action: cleanText(request.action),
    createdAt: Number(request.createdAt),
  };

  normalized.completed = [
    "succeeded",
    "failed",
    "rejected",
  ].includes(normalized.status);

  normalized.valid = Boolean(
    normalized.requestId &&
      normalized.status === "pending" &&
      normalized.homeId &&
      normalized.hubId &&
      normalized.requestedBy &&
      normalized.action === "mute" &&
      isFreshRequestTime(normalized.createdAt, now),
  );

  return normalized;
}

function normalizeAlarmIncidentActionRequest(
  rawRequest,
  requestId,
  now,
) {
  const request = asObject(rawRequest);
  const action = cleanText(request.action);
  const normalized = {
    requestId: cleanText(requestId),
    status: cleanText(request.status),
    receiverUid: cleanText(request.receiverUid),
    incidentId: cleanText(request.incidentId),
    requestedBy: cleanText(request.requestedBy),
    action,
    createdAt: Number(request.createdAt),
  };

  normalized.valid = Boolean(
    normalized.requestId &&
      normalized.status === "pending" &&
      normalized.receiverUid &&
      normalized.incidentId &&
      normalized.requestedBy &&
      ["stop", "check_home", "resolve", "mute_siren"].includes(
        action,
      ) &&
      isFreshRequestTime(normalized.createdAt, now),
  );

  return normalized;
}

function buildAlarmPauseMirrorUpdates({
  ownerUid,
  homeId,
  requestId,
  sharedUsers,
  pauseData,
} = {}) {
  const cleanOwnerUid = cleanText(ownerUid);
  const cleanHomeId = cleanText(homeId);
  const cleanRequestId = cleanText(requestId);
  const pauseValue = pauseData == null ? null : pauseData;

  if (!cleanOwnerUid || !cleanHomeId || !cleanRequestId) {
    throw new Error("ALARM PAUSE UPDATE IDENTITY MISSING");
  }

  const updates = {
    [`accounts/${cleanOwnerUid}/homes/${cleanHomeId}/alarmPauseToday`]:
      pauseValue,
    [`alarm_pause_requests/${cleanRequestId}`]: null,
  };

  for (const sharedUid of Object.keys(asObject(sharedUsers))) {
    const cleanSharedUid = cleanText(sharedUid);

    if (!cleanSharedUid || cleanSharedUid === cleanOwnerUid) {
      continue;
    }

    updates[
      `accounts/${cleanSharedUid}/sharedHomes/${cleanHomeId}/alarmPauseToday`
    ] = pauseValue;
  }

  return updates;
}

function createHomeActionRequestDomain({
  db,
  deviceId,
  lastNotificationMap,
  getCachedAccountData,
  getCachedHomeData,
  verifyHomeParticipant,
  isCachedHomeParticipant,
  normalizeTimestamp,
  getDateKeyFromTimestamp,
  isValidHHMM,
  doesPauseOverlapEnabledAlarm,
  cancelAlarmPauseExpiryTimer,
  scheduleAlarmPauseExpiry,
  addHomeNotificationFromBackend,
  addHomeNotificationToHomeRecipients,
  sendAlarmPauseNotification,
  getCachedUserDisplayName,
  mutePhysicalSirenForHome,
  acknowledgeAlarmIncidentForReceiver,
  sendAlarmResolvedPush,
  hasLocalActiveAlarmIncidentForReceiver,
  resolveAlarmIncidentGroupForHome,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  homeSirenResultTtlMs = HOME_SIREN_RESULT_TTL_MS,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new Error("Home Action Requests requires db.ref");
  }

  const requiredFunctions = {
    getCachedAccountData,
    getCachedHomeData,
    verifyHomeParticipant,
    isCachedHomeParticipant,
    normalizeTimestamp,
    getDateKeyFromTimestamp,
    isValidHHMM,
    doesPauseOverlapEnabledAlarm,
    cancelAlarmPauseExpiryTimer,
    scheduleAlarmPauseExpiry,
    addHomeNotificationFromBackend,
    addHomeNotificationToHomeRecipients,
    sendAlarmPauseNotification,
    getCachedUserDisplayName,
    mutePhysicalSirenForHome,
    acknowledgeAlarmIncidentForReceiver,
    sendAlarmResolvedPush,
    hasLocalActiveAlarmIncidentForReceiver,
    resolveAlarmIncidentGroupForHome,
  };

  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== "function") {
      throw new Error(`Home Action Requests requires ${name}`);
    }
  }

  const cleanDeviceId = cleanText(deviceId);

  if (!cleanDeviceId) {
    throw new Error("Home Action Requests requires deviceId");
  }

  const notificationDedupe =
    lastNotificationMap && typeof lastNotificationMap === "object"
      ? lastNotificationMap
      : {};
  const homeSirenActionInProgress = new Set();
  const alarmIncidentActionInProgress = new Set();
  const cleanupTimers = new Set();

  function scheduleRequestCleanup(requestRef) {
    const timer = setTimeoutFn(() => {
      cleanupTimers.delete(timer);
      void requestRef.remove().catch(() => {});
    }, Math.max(0, Number(homeSirenResultTtlMs) || 0));

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }

    cleanupTimers.add(timer);
  }

  async function finishHomeSirenActionRequest(
    requestRef,
    status,
    details = {},
  ) {
    await requestRef.update({
      status,
      ...details,
      completedAt: now(),
    });

    scheduleRequestCleanup(requestRef);
  }

  async function rejectAndRemove(snap, label, reason) {
    log(`❌ ${label} REJECTED:`, snap?.key, reason);

    try {
      await snap.ref.remove();
    } catch (_) {}
  }

  async function handleAlarmPauseRequest(snap) {
    const rawRequest = snap?.val?.();
    const requestId = cleanText(snap?.key);
    const request = normalizeAlarmPauseRequest(
      rawRequest,
      requestId,
      now(),
    );

    try {
      if (!rawRequest || !requestId) {
        return;
      }

      if (!request.valid) {
        await rejectAndRemove(snap, "ALARM PAUSE REQUEST", "INVALID DATA");
        return;
      }

      const {
        ownerUid,
        homeId,
        createdByUid,
        action,
      } = request;
      const homeSnap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}`)
        .once("value");

      if (!homeSnap.exists()) {
        await rejectAndRemove(snap, "ALARM PAUSE REQUEST", "HOME NOT FOUND");
        return;
      }

      const home = asObject(homeSnap.val());
      const hasPermission = await verifyHomeParticipant({
        requesterUid: createdByUid,
        ownerUid,
        homeId,
      });

      if (!hasPermission) {
        await rejectAndRemove(snap, "ALARM PAUSE REQUEST", "NO PERMISSION");
        return;
      }

      const [actorSnap, sharedSnap] = await Promise.all([
        db.ref(`accounts/${createdByUid}`).once("value"),
        db.ref(`sharedByHome/${homeId}`).once("value"),
      ]);
      const actor = asObject(actorSnap.val());
      const actorProfile = asObject(actor.profile);
      const trustedActorName =
        cleanText(
          actorProfile.name || actor.name || actor.email,
        ) || "Một thành viên";
      const sharedUsers = asObject(sharedSnap.val());
      const trustedHomeName = cleanText(home.name) || homeId;

      if (action === "remove") {
        cancelAlarmPauseExpiryTimer(ownerUid, homeId);
        await db.ref().update(
          buildAlarmPauseMirrorUpdates({
            ownerUid,
            homeId,
            requestId,
            sharedUsers,
            pauseData: null,
          }),
        );

        await addHomeNotificationToHomeRecipients({
          ownerUid,
          homeId,
          homeName: trustedHomeName,
          type: "alarm_pause_cancelled",
          category: "alarm",
          severity: "success",
          title: "Báo động đã hoạt động trở lại",
          message: `${trustedActorName} đã huỷ tạm dừng báo động.`,
          actorUid: createdByUid,
          entityType: "home",
          entityId: homeId,
          recipientUids: [ownerUid, ...Object.keys(sharedUsers)],
          dedupeKey: `alarm_pause_cancelled|${requestId}`,
          dedupeMs: 60 * 1000,
          data: {
            actorName: trustedActorName,
            homeName: trustedHomeName,
            reason: "cancelled_early",
          },
        });

        log(
          "🧹 ALARM PAUSE REMOVED:",
          ownerUid,
          homeId,
          createdByUid,
        );
        return;
      }

      const startAt = normalizeTimestamp(request.startAt);
      const endAt = normalizeTimestamp(request.endAt);

      if (
        !isValidHHMM(request.start) ||
        !isValidHHMM(request.end) ||
        request.start === request.end ||
        request.reason.length > 120 ||
        startAt <= 0 ||
        endAt <= startAt ||
        endAt - startAt > MAX_ALARM_PAUSE_DURATION_MS ||
        startAt < now() - 2 * 60 * 1000 ||
        request.date !== getDateKeyFromTimestamp(startAt)
      ) {
        await rejectAndRemove(
          snap,
          "ALARM PAUSE REQUEST",
          "INVALID PAUSE DATA",
        );
        return;
      }

      if (!doesPauseOverlapEnabledAlarm(home, startAt, endAt)) {
        await rejectAndRemove(
          snap,
          "ALARM PAUSE REQUEST",
          "OUTSIDE ALARM RANGE",
        );
        return;
      }

      const pauseData = {
        date: request.date,
        start: request.start,
        end: request.end,
        startAt,
        endAt,
        homeName: trustedHomeName,
        reason: request.reason,
        createdByUid,
        createdByName: trustedActorName,
        createdAt: now(),
      };

      await db.ref().update(
        buildAlarmPauseMirrorUpdates({
          ownerUid,
          homeId,
          requestId,
          sharedUsers,
          pauseData,
        }),
      );
      scheduleAlarmPauseExpiry(ownerUid, homeId, pauseData);

      log(
        "⏸️ ALARM PAUSE REQUEST APPLIED:",
        ownerUid,
        homeId,
        createdByUid,
      );
    } catch (error) {
      log("ALARM PAUSE REQUEST ERROR:", error.message);

      try {
        await snap.ref.remove();
      } catch (_) {}
    }
  }

  async function handleAlarmPauseAccountChanged(snap) {
    try {
      const ownerUid = cleanText(snap?.key);
      const user = asObject(snap?.val?.());
      const homes = asObject(user.homes);

      for (const [homeId, rawHome] of Object.entries(homes)) {
        const home = asObject(rawHome);
        const pause = asObject(home.alarmPauseToday);

        if (Object.keys(pause).length === 0) {
          continue;
        }

        const key = `${ownerUid}_${homeId}_${pause.createdAt || 0}`;

        if (notificationDedupe[key]) {
          continue;
        }

        notificationDedupe[key] = now();
        const homeName =
          cleanText(pause.homeName) || cleanText(home.name) || homeId;
        const actorName =
          cleanText(pause.createdByName) || "Một thành viên";
        const text =
          `Báo động đã được ${actorName} tạm tắt từ ${pause.start} tới ${pause.end}.\n\n` +
          "Nên trong khoảng thời gian này:\n" +
          "• Một số thiết bị an ninh sẽ tạm ngừng cảnh báo.\n" +
          "• Các cảnh báo nguy hiểm như cháy nổ, ngập nước, chạm chập v.v... vẫn được gửi bình thường.";
        const sharedSnap = await db
          .ref(`sharedByHome/${homeId}`)
          .once("value");
        const sharedUsers = asObject(sharedSnap.val());
        const recipientUids = new Set([
          ownerUid,
          ...Object.keys(sharedUsers),
        ]);
        const pauseReason = cleanText(pause.reason);
        const message =
          `${actorName} đã tạm dừng Báo động từ ${pause.start} đến ${pause.end}.` +
          (pauseReason ? ` Lý do: ${pauseReason}.` : "");

        for (const recipientUid of recipientUids) {
          await addHomeNotificationFromBackend({
            uid: recipientUid,
            homeId,
            homeName,
            type: "alarm_pause_started",
            category: "alarm",
            severity: "warning",
            title: "Báo động đã được tạm dừng",
            message,
            entityType: "home",
            entityId: homeId,
          });

          if (recipientUid !== cleanText(pause.createdByUid)) {
            await sendAlarmPauseNotification(
              recipientUid,
              homeId,
              homeName,
              text,
            );
          }
        }

        log("⏸️ ALARM PAUSE BROADCAST:", homeId);
      }
    } catch (error) {
      log("ALARM PAUSE WATCH ERROR:", error.message);
    }
  }

  async function resolveRequesterHomeAccess(requestedBy, homeId) {
    let requesterAccount = getCachedAccountData(requestedBy);

    if (!requesterAccount) {
      const accountSnap = await db
        .ref(`accounts/${requestedBy}`)
        .once("value");
      requesterAccount = accountSnap.val() || null;
    }

    const account = asObject(requesterAccount);

    if (asObject(account.homes)[homeId]) {
      return { allowed: true, ownerUid: requestedBy };
    }

    const ownerUid = cleanText(
      asObject(asObject(account.sharedHomes)[homeId]).ownerUid,
    );

    if (!ownerUid) {
      return { allowed: false, ownerUid: "" };
    }

    const allowed = await verifyHomeParticipant({
      requesterUid: requestedBy,
      ownerUid,
      homeId,
    });

    return { allowed, ownerUid };
  }

  async function handleHomeSirenActionRequest(snap) {
    const rawRequest = snap?.val?.();
    const requestId = cleanText(snap?.key);
    const request = normalizeHomeSirenActionRequest(
      rawRequest,
      requestId,
      now(),
    );
    let ownsRequest = false;

    async function reject(reason) {
      log("❌ HOME SIREN ACTION REJECTED:", requestId, reason);

      try {
        await finishHomeSirenActionRequest(snap.ref, "failed", {
          reason,
          processingHubId: cleanDeviceId,
        });
      } catch (_) {}
    }

    try {
      if (!rawRequest || !requestId) {
        return;
      }

      if (request.completed) {
        scheduleRequestCleanup(snap.ref);
        return;
      }

      if (request.status !== "pending") {
        return;
      }

      if (homeSirenActionInProgress.has(requestId)) {
        return;
      }

      homeSirenActionInProgress.add(requestId);

      if (!request.valid) {
        ownsRequest = true;
        await reject("invalid_request");
        return;
      }

      const access = await resolveRequesterHomeAccess(
        request.requestedBy,
        request.homeId,
      );

      if (!access.allowed || !access.ownerUid) {
        ownsRequest = true;
        await reject("home_access_denied");
        return;
      }

      let home = getCachedHomeData(access.ownerUid, request.homeId);

      if (!home) {
        const homeSnap = await db
          .ref(`accounts/${access.ownerUid}/homes/${request.homeId}`)
          .once("value");
        home = homeSnap.val() || null;
      }

      if (!home) {
        ownsRequest = true;
        await reject("home_not_found");
        return;
      }

      const targetHubId = cleanText(home.hubId) || request.hubId;

      if (targetHubId !== cleanDeviceId) {
        return;
      }

      ownsRequest = true;
      await snap.ref.update({
        status: "processing",
        processingHubId: cleanDeviceId,
        startedAt: now(),
      });

      const result = await mutePhysicalSirenForHome(
        access.ownerUid,
        request.homeId,
        request.requestedBy,
        { reason: "device_list_mute_button" },
      );
      const succeeded = result.status === "stopped";

      if (succeeded) {
        const actorName = getCachedUserDisplayName(request.requestedBy);
        const homeName = cleanText(home.name) || request.homeId;

        await addHomeNotificationToHomeRecipients({
          ownerUid: access.ownerUid,
          homeId: request.homeId,
          homeName,
          type: "physical_siren_muted",
          category: "alarm",
          severity: "warning",
          title: "Còi báo động đã được tắt",
          message: "Sự cố vẫn đang được theo dõi.",
          actorUid: request.requestedBy,
          entityType: "home",
          entityId: request.homeId,
          dedupeKey:
            `physical_siren_muted|${request.homeId}|${request.requestedBy}`,
          dedupeMs: 5000,
          data: {
            actorName,
            requestedBy: request.requestedBy,
          },
        });
      }

      log(
        "🔕 HOME SIREN MUTED FROM DEVICE LIST:",
        requestId,
        request.requestedBy,
        access.ownerUid,
        request.homeId,
        result.status,
        `confirmed=${result.confirmedCount || 0}/${result.deviceCount || 0}`,
      );

      await finishHomeSirenActionRequest(
        snap.ref,
        succeeded ? "succeeded" : "failed",
        {
          resultStatus: result.status,
          ownerUid: access.ownerUid,
          homeId: request.homeId,
          hubId: cleanDeviceId,
          deviceCount: Number(result.deviceCount || 0),
          successCount: Number(result.successCount || 0),
          confirmedCount: Number(result.confirmedCount || 0),
          reason: succeeded ? "" : result.status,
        },
      );
    } catch (error) {
      log("HOME SIREN ACTION ERROR:", requestId, error.message);

      if (ownsRequest) {
        try {
          await finishHomeSirenActionRequest(snap.ref, "failed", {
            reason: "backend_error",
            error: cleanText(error.message).slice(0, 300),
            processingHubId: cleanDeviceId,
          });
        } catch (_) {}
      }
    } finally {
      if (requestId) {
        homeSirenActionInProgress.delete(requestId);
      }
    }
  }

  async function handleAlarmIncidentActionRequest(snap) {
    const rawRequest = snap?.val?.();
    const requestId = cleanText(snap?.key);
    const request = normalizeAlarmIncidentActionRequest(
      rawRequest,
      requestId,
      now(),
    );

    try {
      if (!rawRequest || !requestId) {
        return;
      }

      if (alarmIncidentActionInProgress.has(requestId)) {
        return;
      }

      alarmIncidentActionInProgress.add(requestId);

      if (!request.valid) {
        await rejectAndRemove(
          snap,
          "ALARM INCIDENT ACTION",
          "INVALID DATA",
        );
        return;
      }

      const incidentPath =
        `accounts/${request.receiverUid}/alarmIncidents/${request.incidentId}`;
      const incidentSnap = await db.ref(incidentPath).once("value");
      const incident = incidentSnap.val();

      if (!incident) {
        await rejectAndRemove(
          snap,
          "ALARM INCIDENT ACTION",
          "INCIDENT NOT FOUND",
        );
        return;
      }

      const ownerUid = cleanText(incident.ownerUid);
      const homeId = cleanText(incident.homeId);

      if (!ownerUid || !homeId) {
        await rejectAndRemove(
          snap,
          "ALARM INCIDENT ACTION",
          "INVALID INCIDENT",
        );
        return;
      }

      if (request.requestedBy !== request.receiverUid) {
        await rejectAndRemove(
          snap,
          "ALARM INCIDENT ACTION",
          "NO PERMISSION",
        );
        return;
      }

      if (request.action === "check_home" && incident.status === "active") {
        if (!isCachedHomeParticipant({
          requesterUid: request.requestedBy,
          ownerUid,
          homeId,
        })) {
          await rejectAndRemove(
            snap,
            "ALARM INCIDENT ACTION",
            "NO HOME PERMISSION",
          );
          return;
        }

        const acknowledged = await acknowledgeAlarmIncidentForReceiver({
          receiverUid: request.receiverUid,
          incidentId: request.incidentId,
          acknowledgedBy: request.requestedBy,
        });

        if (!acknowledged) {
          await rejectAndRemove(
            snap,
            "ALARM INCIDENT ACTION",
            "INCIDENT NOT ACTIVE",
          );
          return;
        }

        await snap.ref.remove();
        log(
          "👀 ALARM INCIDENT CHECKED FOR RECEIVER:",
          requestId,
          request.receiverUid,
          request.incidentId,
        );
        return;
      }

      if (request.action === "mute_siren") {
        if (incident.status === "active") {
          await mutePhysicalSirenForHome(
            ownerUid,
            homeId,
            request.requestedBy,
            { reason: "manual_mute_button" },
          );
          await db.ref(incidentPath).update({
            homeSirenStatus: "manual_muted",
            homeSirenMutedAt: now(),
            homeSirenMutedBy: request.requestedBy,
            updatedAt: now(),
          });

          const home = getCachedHomeData(ownerUid, homeId) || {};
          const homeName =
            cleanText(home.name || incident.homeName) || homeId;
          const actorName = getCachedUserDisplayName(
            request.requestedBy,
          );

          await addHomeNotificationToHomeRecipients({
            ownerUid,
            homeId,
            homeName,
            type: "physical_siren_muted",
            category: "alarm",
            severity: "warning",
            title: "Còi báo động đã được tắt",
            message: "Sự cố vẫn đang được theo dõi.",
            actorUid: request.requestedBy,
            entityType: "home",
            entityId: homeId,
            dedupeKey:
              `physical_siren_muted|${homeId}|${request.requestedBy}`,
            dedupeMs: 5000,
            data: {
              actorName,
              requestedBy: request.requestedBy,
              incidentId: request.incidentId,
            },
          });
        }

        await snap.ref.remove();
        log(
          "🔕 ALARM HOME SIREN MUTED:",
          requestId,
          request.receiverUid,
          request.incidentId,
        );
        return;
      }

      if (incident.status !== "active") {
        await sendAlarmResolvedPush({
          uid: request.receiverUid,
          incidentId: request.incidentId,
          homeId,
          resolvedBy: cleanText(
            incident.resolvedBy || request.requestedBy,
          ),
          action: cleanText(
            incident.resolutionAction ||
              incident.status ||
              "already_resolved",
          ),
          flowType: cleanText(
            incident.flowType || incident.eventCategory || "security",
          ),
          status: cleanText(incident.status || "resolved"),
          hasRemainingActiveIncidents:
            hasLocalActiveAlarmIncidentForReceiver(request.receiverUid),
        });
        await snap.ref.remove();
        log(
          "✅ ALARM ACTION ALREADY RESOLVED:",
          requestId,
          request.receiverUid,
          request.incidentId,
          incident.status,
        );
        return;
      }

      if (!isCachedHomeParticipant({
        requesterUid: request.requestedBy,
        ownerUid,
        homeId,
      })) {
        await rejectAndRemove(
          snap,
          "ALARM INCIDENT ACTION",
          "NO HOME PERMISSION",
        );
        return;
      }

      if (request.action === "stop") {
        await mutePhysicalSirenForHome(
          ownerUid,
          homeId,
          request.requestedBy,
          { reason: "stop_alarm_button" },
        );
      }

      const flowType =
        cleanText(incident.flowType || incident.eventCategory) ===
        "emergency"
          ? "emergency"
          : "security";

      await resolveAlarmIncidentGroupForHome({
        ownerUid,
        homeId,
        flowType,
        resolvedBy: request.requestedBy,
        action: request.action,
      });
      await snap.ref.remove();
    } catch (error) {
      log("ALARM INCIDENT ACTION ERROR:", requestId, error.message);

      try {
        await snap.ref.remove();
      } catch (_) {}
    } finally {
      if (requestId) {
        alarmIncidentActionInProgress.delete(requestId);
      }
    }
  }

  function stopHomeActionRequestRuntime() {
    for (const timer of cleanupTimers) {
      clearTimeoutFn(timer);
    }

    const clearedTimers = cleanupTimers.size;
    cleanupTimers.clear();
    homeSirenActionInProgress.clear();
    alarmIncidentActionInProgress.clear();

    return clearedTimers > 0;
  }

  function getHomeActionRequestRuntimeState() {
    return {
      homeSirenRequests: homeSirenActionInProgress.size,
      alarmIncidentRequests: alarmIncidentActionInProgress.size,
      cleanupTimers: cleanupTimers.size,
    };
  }

  return {
    getHomeActionRequestRuntimeState,
    handleAlarmIncidentActionRequest,
    handleAlarmPauseAccountChanged,
    handleAlarmPauseRequest,
    handleHomeSirenActionRequest,
    stopHomeActionRequestRuntime,
  };
}

module.exports = {
  HOME_SIREN_RESULT_TTL_MS,
  MAX_ALARM_PAUSE_DURATION_MS,
  REQUEST_FUTURE_SKEW_MS,
  REQUEST_MAX_AGE_MS,
  buildAlarmPauseMirrorUpdates,
  createHomeActionRequestDomain,
  isFreshRequestTime,
  normalizeAlarmIncidentActionRequest,
  normalizeAlarmPauseRequest,
  normalizeHomeSirenActionRequest,
};
