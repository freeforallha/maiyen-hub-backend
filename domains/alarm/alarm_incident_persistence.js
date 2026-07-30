"use strict";

function createAlarmIncidentPersistence({
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
  alarmIncidentSchemaVersion,
  emergencyMergeWindowMs,
  alarmIncidentCallDelayMs,
  emergencyCallDelayMs,
  log = (...args) => console.log(...args),
}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("db.ref is required");
  }

  const requiredFunctions = {
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
  };

  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }

  const ALARM_INCIDENT_SCHEMA_VERSION = Number(alarmIncidentSchemaVersion);
  const EMERGENCY_MERGE_WINDOW_MS = Number(emergencyMergeWindowMs);
  const ALARM_INCIDENT_CALL_DELAY_MS = Number(alarmIncidentCallDelayMs);
  const EMERGENCY_CALL_DELAY_MS = Number(emergencyCallDelayMs);

  for (const [name, value] of Object.entries({
    ALARM_INCIDENT_SCHEMA_VERSION,
    EMERGENCY_MERGE_WINDOW_MS,
    ALARM_INCIDENT_CALL_DELAY_MS,
    EMERGENCY_CALL_DELAY_MS,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be non-negative`);
    }
  }

  async function startOrMergeAlarmIncidents(
    uid,
    items,
    {
      bypassEventControl = false,
      forceSecurityRedelivery = false,
    } = {},
  ) {
    const normalizedItems = normalizeAlarmIncidentItems(items);

    if (normalizedItems.length === 0) {
      return;
    }

    const groups = new Map();

    for (const item of normalizedItems) {
      const ownerUid = item.ownerUid || uid;
      const flowType = getAlarmIncidentFlowType([item]);
      const groupKey =
        `${ownerUid}|${item.homeId}|${flowType}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }

      groups.get(groupKey).push(item);
    }

    for (const originalGroupedItems of groups.values()) {
      const firstItem = originalGroupedItems[0];
      const ownerUid = firstItem.ownerUid || uid;
      const homeId = firstItem.homeId;
      const homeName = firstItem.homeName || homeId;
      const flowType =
        getAlarmIncidentFlowType(originalGroupedItems);
      const targetKey = getAlarmIncidentTargetKey(
        uid,
        ownerUid,
        homeId,
        flowType,
      );
      const startLockKey = `${uid}|${targetKey}`;

      await withAlarmIncidentStartLock(
        startLockKey,
        async () => {
          let groupedItems = flowType === "security"
            ? normalizePreferredSecurityIncidentItems(
                originalGroupedItems,
              )
            : normalizeAlarmIncidentItems(
                originalGroupedItems,
              );

          if (flowType === "security") {
            const preCreateValidation =
              await evaluateSecurityIncident(
                uid,
                {
                  receiverUid: uid,
                  ownerUid,
                  homeId,
                  flowType,
                  status: "active",
                  items: groupedItems,
                },
              );

            if (!preCreateValidation.active) {
              log(
                "🧹 ALARM INCIDENT SKIPPED, CONDITION CLEARED:",
                uid,
                ownerUid,
                homeId,
                preCreateValidation.reason,
              );
              return;
            }

            groupedItems = preCreateValidation.items;
          } else {
            const allowedEmergencyItems = [];

            for (const item of groupedItems) {
              if (await isAlarmItemAllowedByCurrentHomeMode(item)) {
                allowedEmergencyItems.push(item);
              }
            }

            groupedItems = normalizeAlarmIncidentItems(
              allowedEmergencyItems,
            );

            if (groupedItems.length === 0) {
              log(
                "🔕 EMERGENCY INCIDENT SKIPPED, HOME UNPROTECTED:",
                uid,
                ownerUid,
                homeId,
              );
              return;
            }
          }

          const respectPause = groupedItems.some((item) => {
            return (
              isScheduledAlarmSource(
                item.alarmSource || "scheduled_alarm",
              )
            );
          });

          const enabled = flowType === "emergency"
            ? true
            : await canReceiveAlarm(
                uid,
                homeId,
                ownerUid,
                { respectPause },
              );

          if (!enabled) {
            log(
              "🔕 ALARM INCIDENT NOT CREATED:",
              uid,
              homeId,
              flowType,
            );
            return;
          }

          const active = await getActiveAlarmIncident(
            uid,
            targetKey,
          );

          if (active) {
            const now = Date.now();
            const activeDetectedAt = Number(
              active.incident.detectedAt ||
              active.incident.createdAt ||
              0,
            );

            const activeAgeMs = activeDetectedAt > 0
              ? now - activeDetectedAt
              : Number.POSITIVE_INFINITY;

            if (flowType === "security") {
              const existingItems =
                normalizePreferredSecurityIncidentItems(
                  active.incident.items,
                );
              const existingKeys = new Set(
                existingItems.map(getAlarmIncidentItemIdentity),
              );
              const mergedItems =
                normalizePreferredSecurityIncidentItems([
                  ...existingItems,
                  ...groupedItems,
                ]);
              const mergedKeys = new Set(
                mergedItems.map(getAlarmIncidentItemIdentity),
              );
              const newItems = mergedItems.filter((item) => {
                return !existingKeys.has(
                  getAlarmIncidentItemIdentity(item),
                );
              });
              const forcedRedeliveryItems = forceSecurityRedelivery
                ? normalizePreferredSecurityIncidentItems(groupedItems)
                : [];
              const repeatBaseAt = Number(
                active.incident.lastRepeatedAt ||
                active.incident.detectedAt ||
                active.incident.createdAt ||
                0,
              );
              const repeatedItems = groupedItems.filter((item) => {
                const repeatMinutes =
                  normalizeRepeatMinutes(item.repeatMinutes);
                const source = String(
                  item.alarmSource || "scheduled_alarm",
                );
                const identity = getAlarmIncidentItemIdentity(item);

                return (
                  isScheduledAlarmSource(source) &&
                  existingKeys.has(identity) &&
                  mergedKeys.has(identity) &&
                  repeatMinutes > 0 &&
                  (
                    repeatBaseAt <= 0 ||
                    now - repeatBaseAt >=
                      repeatMinutes * 60 * 1000
                  )
                );
              });
              const updateData = {
                ...buildStandardIncidentFields(
                  flowType,
                  newItems.length > 0
                    ? "sensor_condition_added"
                    : forcedRedeliveryItems.length > 0
                      ? "schedule_occurrence_started"
                      : "sensor_condition_repeated",
                ),
                items: mergedItems,
                reasons: mergedItems.map(
                  (item) => item.reason,
                ),
                notificationEnabled: mergedItems.some(
                  (item) => item.notificationEnabled !== false,
                ),
                physicalSirenEnabled: mergedItems.some(
                  (item) => item.physicalSirenEnabled !== false,
                ),
                fullscreenEnabled: mergedItems.some(
                  (item) => item.fullscreenEnabled !== false,
                ),
                updatedAt: now,
              };

              if (
                newItems.length > 0 ||
                forcedRedeliveryItems.length > 0
              ) {
                updateData.lastNewConditionAt = now;
                updateData.presentationSuppressedAt = null;
                updateData.presentationSuppressedBy = null;
                updateData.lastCheckedAt = null;
                updateData.lastCheckedBy = null;
              }

              if (
                repeatedItems.length > 0 ||
                forcedRedeliveryItems.length > 0
              ) {
                updateData.lastRepeatedAt = now;
                updateData.repeatCount =
                  Number(active.incident.repeatCount || 0) + 1;
              }

              await db
                .ref(
                  `accounts/${uid}/alarmIncidents/${active.incidentId}`,
                )
                .update(updateData);

              const updatedIncident = {
                ...active.incident,
                ...updateData,
              };

              setLocalActiveAlarmIncident(
                uid,
                active.incidentId,
                updatedIncident,
              );

              if (
                newItems.length > 0 ||
                forcedRedeliveryItems.length > 0
              ) {
                await markAlarmItemsTriggered(
                  uid,
                  normalizeAlarmIncidentItems([
                    ...newItems,
                    ...forcedRedeliveryItems,
                  ]),
                  now,
                );
              }

              const repeatReadyIncident =
                await ensureSecurityModeRepeatForIncident(
                  uid,
                  active.incidentId,
                  updatedIncident,
                );

              const deliveryItems = normalizeAlarmIncidentItems([
                ...newItems,
                ...repeatedItems,
                ...forcedRedeliveryItems,
              ]);

              if (deliveryItems.length > 0) {
                await deliverSecurityAlarmChannelsImmediately({
                  uid,
                  incidentId: active.incidentId,
                  incident: repeatReadyIncident || updatedIncident,
                  items: deliveryItems,
                  allowFullscreenRedelivery:
                    newItems.length > 0 ||
                    forcedRedeliveryItems.length > 0,
                });
              }

              log(
                "➕ SECURITY INCIDENT UPDATED:",
                uid,
                active.incidentId,
                `new=${newItems.length}`,
                `repeat=${repeatedItems.length}`,
                `forced=${forcedRedeliveryItems.length}`,
                `items=${mergedItems.length}`,
                `nextRepeatAt=${Number(repeatReadyIncident?.nextRepeatAt || 0)}`,
              );

              return;
            }

            const existingItems = normalizeAlarmIncidentItems(
              active.incident.items,
            );
            const existingKeys = new Set(
              existingItems.map(getAlarmIncidentItemIdentity),
            );
            const newItems = groupedItems.filter((item) => {
              return !existingKeys.has(
                getAlarmIncidentItemIdentity(item),
              );
            });
            const hasPersistentEmergency = [
              ...existingItems,
              ...groupedItems,
            ].some(isPersistentEmergencyIncidentItem);
            const mayMergeTransientRepeat =
              activeAgeMs >= 0 &&
              activeAgeMs <= EMERGENCY_MERGE_WINDOW_MS;

            // Một trạng thái Emergency duy trì chỉ giữ một incident cho đến khi
            // sensor trở lại an toàn. Emergency mới từ sensor khác cũng được gộp
            // vào incident đang chạy. Chỉ một sự kiện transient giống hệt (SOS)
            // sau merge window mới được coi là lần kích hoạt mới.
            if (
              newItems.length > 0 ||
              hasPersistentEmergency ||
              mayMergeTransientRepeat
            ) {
              const mergedItems = normalizeAlarmIncidentItems([
                ...existingItems,
                ...groupedItems,
              ]);
              const updateData = {
                ...buildStandardIncidentFields(
                  flowType,
                  newItems.length > 0
                    ? "sensor_condition_added"
                    : "sensor_condition_repeated",
                ),
                items: mergedItems,
                reasons: mergedItems.map(
                  (item) => item.reason,
                ),
                notificationEnabled: mergedItems.some(
                  (item) => item.notificationEnabled !== false,
                ),
                physicalSirenEnabled: mergedItems.some(
                  (item) => item.physicalSirenEnabled !== false,
                ),
                fullscreenEnabled: mergedItems.some(
                  (item) => item.fullscreenEnabled !== false,
                ),
                expireAt:
                  now + getAlarmIncidentExpireDelayMs(
                    flowType,
                    mergedItems,
                  ),
                lastNewConditionAt:
                  newItems.length > 0
                    ? now
                    : Number(
                        active.incident.lastNewConditionAt ||
                        active.incident.detectedAt ||
                        now,
                      ),
                presentationSuppressedAt:
                  newItems.length > 0
                    ? null
                    : active.incident.presentationSuppressedAt || null,
                presentationSuppressedBy:
                  newItems.length > 0
                    ? null
                    : active.incident.presentationSuppressedBy || null,
                lastCheckedAt:
                  newItems.length > 0
                    ? null
                    : active.incident.lastCheckedAt || null,
                lastCheckedBy:
                  newItems.length > 0
                    ? null
                    : active.incident.lastCheckedBy || null,
                updatedAt: now,
              };

              await db
                .ref(
                  `accounts/${uid}/alarmIncidents/${active.incidentId}`,
                )

                .update(updateData);

              const updatedIncident = {
                ...active.incident,
                ...updateData,
              };

              setLocalActiveAlarmIncident(
                uid,
                active.incidentId,
                updatedIncident,
              );

              if (newItems.length > 0) {
                await markAlarmItemsTriggered(uid, newItems, now);
              }

              rescheduleAlarmIncidentExpireTimer(
                uid,
                active.incidentId,
                updateData.expireAt,
              );

              if (newItems.length > 0) {
                const sent = await sendAlarmStageSummary(
                  uid,
                  newItems,
                  {
                    incidentId: active.incidentId,
                    stage: "notification",
                    flowType,
                  },
                );

                if (!sent) {
                  scheduleInitialAlarmIncidentPushRetry(
                    uid,
                    active.incidentId,
                    "notification",
                    flowType,
                  );
                }
              }

              const currentStage = String(
                active.incident.stage || "notification",
              );

              if (
                updateData.physicalSirenEnabled === true &&
                (
                  currentStage === "fullscreen_siren" ||
                  currentStage === "calling"
                )
              ) {
                await reconcilePhysicalSirenForHome(
                  ownerUid,
                  homeId,
                  {
                    useDatabase: true,
                    reason: "emergency_incident_items_merged",
                  },
                );
              }

              log(
                "➕ EMERGENCY INCIDENT UPDATED:",
                uid,
                active.incidentId,
                `new=${newItems.length}`,
                `items=${mergedItems.length}`,
                `persistent=${hasPersistentEmergency}`,
              );

              return;
            }

            clearAlarmIncidentTimers(
              uid,
              active.incidentId,
            );

            await db
              .ref(
                `accounts/${uid}/alarmIncidents/${active.incidentId}`,
              )
              .update({
                ...buildStandardIncidentFields(
                  flowType,
                  "new_emergency_trigger",
                ),
                status: "superseded",
                supersededAt: now,
                supersededReason: "new_emergency_trigger",
                resolutionAction: "new_emergency_trigger",
                resolutionType: "automatic",
                callStatus:
                  active.incident.callStatus === "not_started"
                    ? "not_started"
                    : "superseded",
                updatedAt: now,
              });

            removeLocalActiveAlarmIncident(
              uid,
              targetKey,
            );

            log(
              "🔁 OLD ALARM INCIDENT SUPERSEDED:",
              uid,
              active.incidentId,
              flowType,
              `age=${Math.round(activeAgeMs / 1000)}s`,
            );
          }

          groupedItems = bypassEventControl
            ? normalizeAlarmIncidentItems(groupedItems)
            : filterNewAlarmItemsByEventControl(
                uid,
                groupedItems,
              );

          if (groupedItems.length === 0) {
            return;
          }

          const incidentRef = db
            .ref(`accounts/${uid}/alarmIncidents`)
            .push();

          const incidentId = incidentRef.key;

          if (!incidentId) {
            return;
          }

          const now = Date.now();
          const initialStage =
            flowType === "emergency"
              ? "notification"
              : "detected";

          const incident = {
            incidentId,
            targetKey,
            receiverUid: uid,
            ownerUid,
            homeId,
            homeName,
            flowType,

            ...buildStandardIncidentFields(
              flowType,
              "sensor_triggered",
            ),

            status: "active",
            stage: initialStage,
            items: groupedItems,
            reasons: groupedItems.map(
              (item) => item.reason,
            ),
            detectedAt: now,
            expireAt:
              now + getAlarmIncidentExpireDelayMs(
                flowType,
                groupedItems,
              ),
            callStatus: "not_started",
            homeSirenStatus: "not_started",
            notificationEnabled: groupedItems.some(
              (item) => item.notificationEnabled !== false,
            ),
            physicalSirenEnabled: groupedItems.some(
              (item) => item.physicalSirenEnabled !== false,
            ),
            fullscreenEnabled: groupedItems.some(
              (item) => item.fullscreenEnabled !== false,
            ),
            createdAt: now,
            updatedAt: now,
          };

          if (flowType === "emergency") {
            incident.fullscreenDueAt =
              now;
            incident.callDueAt =
              now + EMERGENCY_CALL_DELAY_MS;
          } else {
            incident.alarmDueAt =
              now;
            incident.sirenDueAt =
              now;
            incident.callDueAt =
              now + ALARM_INCIDENT_CALL_DELAY_MS;

            const securityItems = getSecurityModeItems(
              groupedItems,
            );
            const currentHome = getCachedHomeData(
              ownerUid,
              homeId,
            );
            const repeatMinutes = securityItems.length > 0
              ? normalizeSecurityModeRepeatMinutes(
                  currentHome?.securityModeRepeatMinutes ??
                  securityItems[0].repeatMinutes,
                )
              : 0;

            incident.items = applySecurityModeRepeatToItems(
              groupedItems,
              repeatMinutes,
            );
            incident.reasons = incident.items.map(
              (item) => item.reason,
            );
            incident.repeatMinutes = repeatMinutes;
            incident.nextRepeatAt = repeatMinutes > 0
              ? now + repeatMinutes * 60 * 1000
              : null;
            incident.repeatConfiguredAt = now;
          }

          await db.ref().update({
            [`accounts/${uid}/alarmIncidents/${incidentId}`]:
              incident,
            [`accounts/${uid}/activeAlarmIncidentByTarget/${targetKey}`]:
              incidentId,
          });

          setLocalActiveAlarmIncident(
            uid,
            incidentId,
            incident,
          );

          await markAlarmItemsTriggered(
            uid,
            incident.items,
            now,
          );

          await addHomeNotificationFromBackend({
            uid,
            homeId,
            homeName,
            type: flowType === "emergency"
              ? "emergency_detected"
              : "alarm_detected",
            category: "alarm",

            severity: getLegacyIncidentSeverity(flowType),
            eventCategory: getStandardIncidentEventCategory(flowType),
            alarmLevel: getStandardIncidentAlarmLevel(flowType),

            title: flowType === "emergency"
              ? getEmergencyIncidentTitle(groupedItems)
              : "Phát hiện bất thường",
            message:
              groupedItems
                .map((item) => item.reason)
                .join(", "),
            entityType: "home",
            entityId: homeId,
          });

          if (flowType === "emergency") {
            const initialSent = await sendAlarmStageSummary(
              uid,
              incident.items,
              {
                incidentId,
                stage: initialStage,
                flowType,
              },
            );

            if (initialSent) {
              resetAlarmStageRetry(
                uid,
                incidentId,
                initialStage,
              );
              await db
                .ref(
                  `accounts/${uid}/alarmIncidents/${incidentId}`,
                )
                .update({
                  initialPushSentAt: Date.now(),
                  updatedAt: Date.now(),
                });
            } else {
              scheduleInitialAlarmIncidentPushRetry(
                uid,
                incidentId,
                initialStage,
                flowType,
              );
            }

            await advanceAlarmIncidentToStage(
              uid,
              incidentId,
              "fullscreen_siren",
            );
          } else {
            await deliverSecurityAlarmChannelsImmediately({
              uid,
              incidentId,
              incident,
              items: incident.items,
            });
          }

          // Chỉ lập lịch gọi điện/lặp/expire sau khi các kênh báo động đã được
          // kích hoạt trực tiếp. Các timer 0 ms còn lại chỉ là fallback idempotent.
          scheduleAlarmIncidentStages(
            uid,
            incidentId,
            incident,
          );

          if (flowType === "emergency") {
            log(
              "🆘 EMERGENCY INCIDENT DETECTED:",
              uid,
              incidentId,
              homeId,
              "fullscreen=immediate",
              `call=${EMERGENCY_CALL_DELAY_MS / 1000}s`,
            );
          } else {
            log(
              "🔎 ALARM INCIDENT DETECTED:",
              uid,
              incidentId,
              homeId,
              "alarm=immediate",
              "siren=immediate",
              `call=${ALARM_INCIDENT_CALL_DELAY_MS / 1000}s`,
            );
          }
        },
      );
    }
  }

  async function resumeActiveAlarmIncidents() {
    try {
      const accounts = getCachedAccountsObject();
      let resumed = 0;

      for (const [uid, account] of Object.entries(accounts)) {
        const incidents = account?.alarmIncidents || {};

        for (const [incidentId, incident] of Object.entries(incidents)) {
          if (incident?.status !== "active") {
            continue;
          }

          const incidentOwnerUid = String(
            incident?.ownerUid || uid,
          ).trim();
          const incidentHomeId = String(
            incident?.homeId || "",
          ).trim();
          const incidentHome = getCachedHomeData(
            incidentOwnerUid,
            incidentHomeId,
          );

          if (incidentHome && isHomeUnprotected(incidentHome)) {
            await resolveAlarmIncidentForReceiver({
              receiverUid: uid,
              incidentId,
              ownerUid: incidentOwnerUid,
              homeId: incidentHomeId,
              resolvedBy: "safehome_backend",
              action: "home_unprotected",
            });
            continue;
          }

          const resumableFlowType = String(
            incident?.flowType || incident?.eventCategory || "security",
          ) === "emergency"
            ? "emergency"
            : "security";
          const standardFields = buildStandardIncidentFields(
            resumableFlowType,
            String(incident?.statusReason || "backend_resumed"),
          );
          let resumableIncident = {
            ...incident,
            flowType: resumableFlowType,
            ...standardFields,
          };

          if (
            Number(incident?.schemaVersion || 0) !==
              ALARM_INCIDENT_SCHEMA_VERSION ||
            String(incident?.eventCategory || "") !==
              standardFields.eventCategory ||
            String(incident?.alarmLevel || "") !==
              standardFields.alarmLevel
          ) {
            await db
              .ref(
                `accounts/${uid}/alarmIncidents/${incidentId}`,
              )
              .update({
                flowType: resumableFlowType,
                ...standardFields,
                updatedAt: Date.now(),
              });
          }

          if (resumableFlowType !== "emergency") {
            const validation =
              await validateAndResolveSecurityIncident(
                uid,
                incidentId,
                resumableIncident,
                { reasonHint: "backend_restart_validation" },
              );

            if (!validation.active) {
              continue;
            }

            resumableIncident = {
              ...resumableIncident,
              items: validation.items,
            };
          }

          if (resumableIncident.flowType !== "emergency") {
            resumableIncident =
              await ensureSecurityModeRepeatForIncident(
                uid,
                incidentId,
                resumableIncident,
                { scheduleTimer: false },
              );
          }

          setLocalActiveAlarmIncident(
            uid,
            incidentId,
            resumableIncident,
          );

          scheduleAlarmIncidentStages(
            uid,
            incidentId,
            resumableIncident,
          );

          const resumedInitialStage =
            resumableIncident.flowType === "emergency"
              ? "notification"
              : "detected";

          if (
            resumableIncident.flowType === "emergency" &&
            !resumableIncident.initialPushSentAt &&
            String(resumableIncident.stage || resumedInitialStage) ===
              resumedInitialStage
          ) {
            scheduleInitialAlarmIncidentPushRetry(
              uid,
              incidentId,
              resumedInitialStage,
              "emergency",
            );
          }

          resumed++;
        }
      }

      log(
        "🚨 ACTIVE ALARM INCIDENTS RESUMED:",
        resumed,
      );
    } catch (err) {
      log(
        "ALARM INCIDENT RESUME ERROR:",
        err.message,
      );
    }
  }

  async function resolveAlarmIncidentForReceiver({
    receiverUid,
    incidentId,
    ownerUid,
    homeId,
    resolvedBy,
    action,
  }) {
    const incidentRef = db.ref(
      `accounts/${receiverUid}/alarmIncidents/${incidentId}`,
    );

    const incidentSnap = await incidentRef.once("value");
    const incident = incidentSnap.val();

    if (
      !incident ||
      incident.status !== "active" ||
      String(incident.ownerUid || "") !== ownerUid ||
      String(incident.homeId || "") !== homeId
    ) {
      return false;
    }

    const now = Date.now();
    const flowType = String(
      incident.flowType || incident.eventCategory || "security",
    ) === "emergency"
      ? "emergency"
      : "security";
    const resolutionType = getIncidentResolutionType(resolvedBy);

    if (resolutionType === "manual") {
      await markAlarmItemsAcknowledged(
        receiverUid,
        incident.items,
        resolvedBy,
        now,
      );
    }

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
        String(action || "resolved"),
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/resolutionType`]:
        resolutionType,
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/status`]:
        "resolved",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/stage`]:
        "resolved",
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/resolvedAt`]:
        now,
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/resolvedBy`]:
        resolvedBy,
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/resolutionAction`]:
        action,
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/updatedAt`]:
        now,
      [`accounts/${receiverUid}/alarmIncidents/${incidentId}/homeSirenStatus`]:
        "stop_requested",
    };

    const targetKey = String(
      incident.targetKey || "",
    ).trim();

    if (targetKey) {
      updates[
        `accounts/${receiverUid}/activeAlarmIncidentByTarget/${targetKey}`
      ] = null;
    }

    await db.ref().update(updates);

    await reconcilePhysicalSirenForHome(
      ownerUid,
      homeId,
      {
        useDatabase: true,
        reason: `incident_resolved:${action}`,
      },
    );

    removeLocalActiveAlarmIncident(
      receiverUid,
      targetKey,
    );

    const hasRemainingActiveIncidents =
      hasLocalActiveAlarmIncidentForReceiver(receiverUid);

    clearAlarmIncidentTimers(
      receiverUid,
      incidentId,
    );

    const resolvedHome = getCachedHomeData(ownerUid, homeId) || {};
    const resolvedHomeName = String(
      resolvedHome.name || incident.homeName || homeId,
    ).trim() || homeId;

    await addHomeNotificationFromBackend({
      uid: receiverUid,
      ownerUid,
      homeId,
      homeName: resolvedHomeName,
      type: flowType === "emergency"
        ? "emergency_resolved"
        : "alarm_resolved",
      category: "alarm",
      severity: "success",
      eventCategory: getStandardIncidentEventCategory(flowType),
      alarmLevel: getStandardIncidentAlarmLevel(flowType),
      title: flowType === "emergency"
        ? "Sự cố nguy hiểm đã kết thúc"
        : "Cảnh báo an ninh đã kết thúc",
      message: hasRemainingActiveIncidents
        ? "Vẫn còn cảnh báo khác đang hoạt động."
        : "Cảnh báo đã được kết thúc.",
      entityType: "home",
      entityId: homeId,
      data: {
        incidentId,
        flowType,
        resolutionAction: String(action || "resolved"),
        resolutionType,
        hasRemainingActiveIncidents,
      },
    });

    await sendAlarmResolvedPush({
      uid: receiverUid,
      incidentId,
      homeId,
      resolvedBy,
      action,
      flowType,
      status: "resolved",
      hasRemainingActiveIncidents,
    });

    log(
      "✅ ALARM INCIDENT RESOLVED FOR RECEIVER:",
      receiverUid,
      incidentId,
      ownerUid,
      homeId,
      action,
    );

    return true;
  }

  async function resolveAlarmIncidentGroupForHome({
    ownerUid,
    homeId,
    flowType = "security",
    resolvedBy,
    action,
  }) {
    const cleanOwnerUid = String(ownerUid || "").trim();
    const cleanHomeId = String(homeId || "").trim();
    const cleanFlowType = String(flowType || "security") === "emergency"
      ? "emergency"
      : "security";

    if (!cleanOwnerUid || !cleanHomeId) {
      return 0;
    }

    const copies = [];
    const receiverUids = getAlarmReceiverUidsForHome(
      cleanOwnerUid,
      cleanHomeId,
    );

    for (const receiverUid of receiverUids) {
      let incidents = getCachedAccountData(receiverUid)?.alarmIncidents;

      if (!incidents || typeof incidents !== "object") {
        try {
          const snap = await db
            .ref(`accounts/${receiverUid}/alarmIncidents`)
            .once("value");
          incidents = snap.val() || {};
        } catch (_) {
          incidents = {};
        }
      }

      for (const [incidentId, incident] of Object.entries(incidents || {})) {
        const incidentFlowType = String(
          incident?.flowType || incident?.eventCategory || "security",
        ) === "emergency"
          ? "emergency"
          : "security";

        if (
          incident?.status === "active" &&
          String(incident?.ownerUid || "").trim() === cleanOwnerUid &&
          String(incident?.homeId || "").trim() === cleanHomeId &&
          incidentFlowType === cleanFlowType
        ) {
          copies.push({ receiverUid, incidentId });
        }
      }
    }

    let resolvedCount = 0;

    for (const copy of copies) {
      const resolved = await resolveAlarmIncidentForReceiver({
        receiverUid: copy.receiverUid,
        incidentId: copy.incidentId,
        ownerUid: cleanOwnerUid,
        homeId: cleanHomeId,
        resolvedBy,
        action,
      });

      if (resolved) {
        resolvedCount++;
      }
    }

    log(
      "✅ ALARM INCIDENT GROUP RESOLVED:",
      cleanOwnerUid,
      cleanHomeId,
      cleanFlowType,
      `copies=${resolvedCount}`,
      action,
    );

    return resolvedCount;
  }

  return {
    startOrMergeAlarmIncidents,
    resumeActiveAlarmIncidents,
    resolveAlarmIncidentForReceiver,
    resolveAlarmIncidentGroupForHome,
  };
}

module.exports = {
  createAlarmIncidentPersistence,
};
