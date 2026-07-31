"use strict";

const {
  createPresenceSessionCoordinator,
} = require("../presence/presence_session");
const {
  memberPresenceStatusSignature,
  presenceCleanupTargetSignature,
} = require("../../firebase_write_policy");
const {
  runtimeSignature,
  buildAutoAwayRuntime: buildRuntime,
  presenceSummarySignature,
  buildPresenceSummary,
} = require("../home/home_status_aggregation");

function createAutoAwayDomain({
  db,
  getCachedAccountsObject,
  getCachedSharedByHomeObject,
  sendPushToUser,
  addHomeNotificationToHomeRecipients,
  isSecurityDeviceType,
  normalizeHomeSecurityMode,
  presenceSessionCoordinator: injectedPresenceSessionCoordinator = null,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("createAutoAwayDomain requires Firebase db");
  }
  for (const [name, dependency] of Object.entries({
    getCachedAccountsObject,
    getCachedSharedByHomeObject,
    sendPushToUser,
    addHomeNotificationToHomeRecipients,
    isSecurityDeviceType,
    normalizeHomeSecurityMode,
  })) {
    if (typeof dependency !== "function") {
      throw new TypeError(`createAutoAwayDomain requires ${name}`);
    }
  }

  // ================= AUTO AWAY =================
  // Chỉ tự bật Mode Bảo vệ khi toàn bộ thành viên đủ điều kiện
  // ở ngoài liên tục 60 giây.
  const AUTO_AWAY_ARM_DELAY_MS = 60 * 1000;

  // Chỉ tự chuyển về Bình thường khi có người ở trong nhà
  // liên tục 30 giây.
  const AUTO_AWAY_INSIDE_CONFIRM_MS = 30 * 1000;

  // Sau khi Auto Away tự chuyển về Bình thường vì có người về,
  // khóa không cho tự bật lại trong 2 phút.
  const AUTO_AWAY_REARM_BLOCK_MS = 2 * 60 * 1000;

  const AUTO_AWAY_SCAN_INTERVAL_MS = 10 * 1000;

  // Khi user chủ động chuyển từ Bảo vệ về Bình thường,
  // Auto Away chỉ tạm hoãn, không bị khóa vĩnh viễn.
  // Sau thời gian này, nếu mọi thành viên đủ điều kiện vẫn ở ngoài,
  // backend sẽ bắt đầu lại chu kỳ tự bật Bảo vệ.
  const AUTO_AWAY_MANUAL_NORMAL_SNOOZE_MS = 2 * 60 * 1000;

  // Session freshness, iOS geofence continuity, monitoring health and
  // Android recovery requests are isolated in the Presence domain.
  const presenceSessionCoordinator =
    injectedPresenceSessionCoordinator ||
    createPresenceSessionCoordinator({
      sendPushToUser,
      now,
    });

  for (const methodName of [
    "getAccountSessionStatus",
    "normalizePresenceMonitoringWarnings",
    "monitoringWarningsToFirebaseMap",
    "getPresenceMonitoringAvailability",
    "getMemberPresenceStatus",
    "prepareSessionContext",
  ]) {
    if (typeof presenceSessionCoordinator[methodName] !== "function") {
      throw new TypeError(
        `createAutoAwayDomain requires presenceSessionCoordinator.${methodName}`,
      );
    }
  }

  const {
    getAccountSessionStatus,
    normalizePresenceMonitoringWarnings,
    monitoringWarningsToFirebaseMap,
    getPresenceMonitoringAvailability,
    getMemberPresenceStatus,
    prepareSessionContext,
  } = presenceSessionCoordinator;

  let autoAwayTimer = null;
  let autoAwayScanRunning = false;
  // Suppress repeated Presence cleanup writes while Firebase cache catches up.
  const presenceCleanupPersistedRuntimeMap = new Map();

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }


  function resolveAutoAwayParticipantSelection(
    autoAway,
    members,
    ownerUid,
  ) {
    const validMemberUids = [...members]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .sort();
    const validMemberSet = new Set(validMemberUids);
    const rawParticipants = asObject(autoAway?.participantUids);
    const rawKeys = Object.keys(rawParticipants)
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .sort();
    const hasExplicitSelection = rawKeys.length > 0;

    let participantUids;

    if (!hasExplicitSelection) {
      // Tương thích ngược: nhà cũ chưa có participantUids vẫn dùng toàn bộ
      // thành viên như logic Auto Away trước đây.
      participantUids = validMemberUids;
    } else {
      participantUids = rawKeys.filter((memberUid) => {
        return rawParticipants[memberUid] === true &&
          validMemberSet.has(memberUid);
      });

      // Thành viên được chọn có thể vừa rời khỏi nhà chia sẻ. Không để cấu
      // hình rỗng làm Auto Away tự bật sai; fallback an toàn về Owner.
      if (
        participantUids.length === 0 &&
        validMemberSet.has(ownerUid)
      ) {
        participantUids = [ownerUid];
      }
    }

    const normalizedMap = {};

    for (const memberUid of participantUids) {
      normalizedMap[memberUid] = true;
    }

    const normalizedKeys = Object.keys(normalizedMap).sort();
    const rawTrueKeys = rawKeys.filter((memberUid) => {
      return rawParticipants[memberUid] === true;
    });
    const hasInvalidValue = rawKeys.some((memberUid) => {
      return rawParticipants[memberUid] !== true;
    });
    const needsNormalization = hasExplicitSelection && (
      hasInvalidValue ||
      JSON.stringify(rawTrueKeys) !== JSON.stringify(normalizedKeys)
    );

    return {
      participantUids,
      participantSet: new Set(participantUids),
      hasExplicitSelection,
      normalizedMap,
      needsNormalization,
    };
  }

  function hasSecurityDevices(home) {
    const devices = asObject(home?.devices);

    return Object.values(devices).some((rawDevice) => {
      const device = asObject(rawDevice);
      const deviceType = String(
        device.type || "unknown",
      ).trim();

      return isSecurityDeviceType(deviceType);
    });
  }

  async function checkAutoAwayHomes() {
    if (autoAwayScanRunning) {
      return;
    }

    autoAwayScanRunning = true;

    try {
      const accounts = getCachedAccountsObject();
      const sharedByHome = getCachedSharedByHomeObject();
      const currentTime = now();
      const updates = {};
      const logs = [];
      const modeNotifications = [];
      const pendingPresenceCleanupRuntimeUpdates = [];
      const {
        sessionStatusByUid,
        recoveryGraceByUid: presenceRecoveryGraceByUid,
        logs: presenceSessionLogs,
      } = await prepareSessionContext(accounts, currentTime);

      logs.push(...presenceSessionLogs);

      for (const [ownerUid, rawAccount] of Object.entries(accounts)) {
        const account = asObject(rawAccount);
        const homes = asObject(account.homes);

        for (const [homeId, rawHome] of Object.entries(homes)) {
          const home = asObject(rawHome);
          const autoAway = asObject(home.autoAway);
          const runtime = asObject(home.autoAwayRuntime);

          const homePath =
            `accounts/${ownerUid}/homes/${homeId}`;
          const runtimePath =
            `${homePath}/autoAwayRuntime`;
          const presenceSummaryPath =
            `${homePath}/presenceSummary`;
          const memberPresenceStatusPath =
            `${homePath}/memberPresenceStatus`;

          const members = new Set([ownerUid]);
          const sharedMembers = asObject(sharedByHome[homeId]);

          for (const rawMemberUid of Object.keys(sharedMembers)) {
            const memberUid = String(rawMemberUid || "").trim();

            if (memberUid) {
              members.add(memberUid);
            }
          }

          const participantSelection =
            resolveAutoAwayParticipantSelection(
              autoAway,
              members,
              ownerUid,
            );
          const participantSet =
            participantSelection.participantSet;

          if (participantSelection.needsNormalization) {
            updates[
              `${homePath}/autoAway/participantUids`
            ] = participantSelection.normalizedMap;
            logs.push(
              `👥 AUTO AWAY PARTICIPANTS NORMALIZED: ${ownerUid} ${homeId} participants=${participantSelection.participantUids.length}`,
            );
          }

          const eligibleStates = [];
          const memberPresenceByUid = new Map();
          const nextMemberPresenceStatus = {};
          let excludedCount = 0;
          let monitoredUnknownCount = 0;
          let signedInCount = 0;
          let connectedCount = 0;

          for (const memberUid of members) {
            const sessionStatus =
              sessionStatusByUid.get(memberUid) ||
              getAccountSessionStatus(
                asObject(accounts?.[memberUid]),
                currentTime,
              );

            const presenceStatus = getMemberPresenceStatus(
              accounts,
              memberUid,
              ownerUid,
              homeId,
              sessionStatus,
              currentTime,
              presenceRecoveryGraceByUid.get(memberUid) === true,
            );

            memberPresenceByUid.set(
              memberUid,
              presenceStatus,
            );

            // Online/offline lấy từ installation session hiện tại.
            // homePresence signed_out chỉ là marker vị trí của phiên
            // trước và không được giữ tài khoản offline sau khi login lại.
            const signedInForHome =
              sessionStatus.active === true;

            const presenceAvailableForHome =
              presenceStatus.sessionAllowsPresence === true;

            const connectedForHome =
              signedInForHome &&
              sessionStatus.connected === true;

            if (signedInForHome) {
              signedInCount++;
            }

            if (connectedForHome) {
              connectedCount++;
            }

            // Tự chuyển dữ liệu từ logic cũ: tối ưu pin, giới hạn nền
            // và tự khởi động chỉ còn là cảnh báo, không còn khóa Auto Away.
            const legacyWarningReason =
              presenceStatus.storedMonitoringBlockingReason ===
                "battery_optimization_required" ||
              presenceStatus.storedMonitoringBlockingReason ===
                "background_restricted" ||
              presenceStatus.storedMonitoringBlockingReason ===
                "auto_start_required";

            const shouldNormalizeLegacyMonitoring =
              presenceAvailableForHome &&
              presenceStatus.identityMatches === true &&
              presenceStatus.reactivatedAfterSignedOut !== true &&
              presenceStatus.monitoringAvailable === true &&
              (
                presenceStatus.storedMonitoringEligible !== true ||
                presenceStatus.storedMonitoringAvailable !== true ||
                legacyWarningReason
              );

            if (shouldNormalizeLegacyMonitoring) {
              const presencePath =
                `accounts/${memberUid}/homePresence/${homeId}`;

              updates[`${presencePath}/monitoringEligible`] = true;
              updates[`${presencePath}/monitoringAvailable`] = true;
              updates[`${presencePath}/monitoringWarnings`] =
                monitoringWarningsToFirebaseMap(
                  presenceStatus.monitoringWarnings,
                );
              updates[`${presencePath}/monitoringWarningReason`] =
                presenceStatus.monitoringWarnings[0] || null;
              updates[`${presencePath}/monitoringBlockingReason`] =
                null;
              updates[`${presencePath}/monitoringCheckedAt`] = currentTime;

              logs.push(
                `⚙️ AUTO AWAY MONITORING NORMALIZED: ${memberUid} ${homeId}`,
              );
            }

            const locationKnown =
              presenceAvailableForHome &&
              (
                presenceStatus.state === "inside" ||
                presenceStatus.state === "outside"
              );

            nextMemberPresenceStatus[memberUid] = {
              online: signedInForHome,
              connected: connectedForHome,
              autoAwayParticipant:
                participantSet.has(memberUid),
              state: locationKnown
                ? presenceStatus.state
                : "unknown",
              locationKnown,
              monitoringEligible:
                presenceAvailableForHome &&
                presenceStatus.monitoringAvailable === true,
              monitoringAvailable:
                presenceAvailableForHome &&
                presenceStatus.monitoringAvailable === true,
              monitoringWarnings:
                presenceAvailableForHome
                  ? presenceStatus.monitoringWarnings
                  : [],
              monitoringWarningReason:
                presenceAvailableForHome
                  ? presenceStatus.monitoringWarnings[0] || ""
                  : "",
              monitoringHealth:
                presenceAvailableForHome
                  ? presenceStatus.monitoringHealth
                  : "unavailable",
              monitoringHealthReason:
                presenceAvailableForHome
                  ? presenceStatus.monitoringHealthReason
                  : "signed_out",
              lastConfirmedAt:
                presenceAvailableForHome
                  ? Number(
                      presenceStatus.lastConfirmedAt || 0,
                    )
                  : 0,
              appState: signedInForHome
                ? String(
                    sessionStatus.appState || "",
                  ).trim()
                : presenceStatus.staleIosPresenceAllowed
                  ? "ios_background"
                  : presenceStatus.androidRecoveryGraceAllowed
                    ? "android_recovery"
                    : "signed_out",
              reason:
                presenceAvailableForHome
                  ? presenceStatus.reactivatedAfterSignedOut
                    ? "session_reactivated"
                    : presenceStatus.staleIosPresenceAllowed
                      ? "ios_background_geofence"
                      : presenceStatus.androidRecoveryGraceAllowed
                        ? "android_presence_recovery"
                        : presenceStatus.monitoringAvailable === true
                        ? ""
                        : String(
                            presenceStatus.monitoringBlockingReason ||
                            "permission_required",
                          ).trim()
                  : String(
                      presenceStatus.sessionReason || "signed_out",
                    ).trim(),
              lastSeenAt: Number(
                sessionStatus.freshestSeenAt || 0,
              ),
              updatedAt: currentTime,
            };

            const presenceCleanupRuntimeKey =
              `${memberUid}|${ownerUid}|${homeId}`;

            if (presenceStatus.needsSessionCleanup) {
              const reason =
                presenceStatus.sessionReason ||
                "session_stale";

              const presencePath =
                `accounts/${memberUid}/homePresence/${homeId}`;

              const cleanupChanged =
                presenceStatus.rawState !== "unknown" ||
                presenceStatus.event !== reason ||
                presenceStatus.storedMonitoringEligible !== false ||
                presenceStatus.storedMonitoringAvailable !== false ||
                presenceStatus.monitoringBlockingReason !== reason;

              const cleanupTargetSignature =
                presenceCleanupTargetSignature(reason);

              const cleanupAlreadyPersisted =
                presenceCleanupPersistedRuntimeMap.get(
                  presenceCleanupRuntimeKey,
                ) === cleanupTargetSignature;

              if (cleanupChanged && !cleanupAlreadyPersisted) {
                updates[`${presencePath}/state`] = "unknown";
                updates[`${presencePath}/event`] = reason;
                updates[`${presencePath}/source`] =
                  "native_geofence";
                updates[`${presencePath}/updatedAt`] = currentTime;
                updates[`${presencePath}/monitoringEligible`] = false;
                updates[`${presencePath}/monitoringAvailable`] = false;
                updates[`${presencePath}/monitoringWarnings`] = null;
                updates[`${presencePath}/monitoringWarningReason`] = null;
                updates[`${presencePath}/monitoringBlockingReason`] =
                  reason;
                updates[`${presencePath}/monitoringCheckedAt`] = currentTime;

                pendingPresenceCleanupRuntimeUpdates.push([
                  presenceCleanupRuntimeKey,
                  cleanupTargetSignature,
                ]);

                logs.push(
                  `👤 SESSION INACTIVE → UNKNOWN: ${memberUid} ${homeId} reason=${reason}`,
                );
              } else if (!cleanupChanged) {
                presenceCleanupPersistedRuntimeMap.set(
                  presenceCleanupRuntimeKey,
                  cleanupTargetSignature,
                );
              }
            } else {
              presenceCleanupPersistedRuntimeMap.delete(
                presenceCleanupRuntimeKey,
              );
            }

            if (!participantSet.has(memberUid)) {
              continue;
            }

            if (!presenceStatus.eligibleForArming) {
              excludedCount++;

              if (presenceStatus.unknownWhileMonitored) {
                monitoredUnknownCount++;
              }

              continue;
            }

            eligibleStates.push(presenceStatus.state);
          }

          const totalMemberCount = members.size;
          const participantCount = participantSet.size;

          // Các biến arming* chỉ dùng cho quyết định Auto Away.
          // Unknown không được tính là inside, cũng không được tính
          // là outside khi xét tự bật Bảo vệ.
          const memberCount = eligibleStates.length;
          const insideCount = eligibleStates.filter(
            (state) => state === "inside",
          ).length;
          const outsideCount = eligibleStates.filter(
            (state) => state === "outside",
          ).length;
          const armingUnknownCount = Math.max(
            0,
            memberCount - insideCount - outsideCount,
          );

          // Các biến display* dùng cho UI và timeline summary.
          // Mẫu số luôn là tổng thành viên thật để không hiện 2/2
          // khi thực tế là 2/3 trong nhà và 1/3 chưa rõ vị trí.
          const displayMemberCount = totalMemberCount;
          const displayInsideCount = Object.values(
            nextMemberPresenceStatus,
          ).filter((status) => {
            return asObject(status).state === "inside";
          }).length;
          const displayOutsideCount = Object.values(
            nextMemberPresenceStatus,
          ).filter((status) => {
            return asObject(status).state === "outside";
          }).length;
          const displayKnownLocationCount =
            displayInsideCount + displayOutsideCount;
          const displayUnknownCount = Math.max(
            0,
            totalMemberCount - displayKnownLocationCount,
          );

          // Bộ đếm participant* chỉ dùng để hiển thị nhóm thành viên
          // đã được Owner/Admin chọn cho Tự động Bảo vệ. Ba giá trị
          // này luôn cộng lại đúng bằng participantCount, kể cả khi
          // một thành viên chưa có vị trí hợp lệ để tham gia quyết định Mode.
          const participantStatuses = Object.entries(
            nextMemberPresenceStatus,
          ).filter(([memberUid]) => {
            return participantSet.has(memberUid);
          });
          const participantInsideCount = participantStatuses.filter(
            ([, status]) => asObject(status).state === "inside",
          ).length;
          const participantOutsideCount = participantStatuses.filter(
            ([, status]) => asObject(status).state === "outside",
          ).length;
          const participantUnknownCount = Math.max(
            0,
            participantCount -
              participantInsideCount -
              participantOutsideCount,
          );

          const unavailableCount = displayUnknownCount;

          const runtimeCounts = {
            totalMemberCount,
            participantCount,
            memberCount: displayMemberCount,
            eligibleMemberCount: memberCount,
            excludedCount,
            insideCount: displayInsideCount,
            outsideCount: displayOutsideCount,
            unknownCount: displayUnknownCount,
            knownLocationCount: displayKnownLocationCount,
            armingInsideCount: insideCount,
            armingOutsideCount: outsideCount,
            armingUnknownCount,
          };

          const currentPresenceSummary =
            asObject(home.presenceSummary);

          const nextPresenceSummary =
            buildPresenceSummary({
              totalMemberCount,
              participantCount,
              participantInsideCount,
              participantOutsideCount,
              participantUnknownCount,
              signedInCount,
              onlineCount: signedInCount,
              connectedCount,
              memberCount: displayMemberCount,
              eligibleMemberCount: memberCount,
              excludedCount,
              insideCount: displayInsideCount,
              outsideCount: displayOutsideCount,
              unknownCount: displayUnknownCount,
              knownLocationCount: displayKnownLocationCount,
              armingInsideCount: insideCount,
              armingOutsideCount: outsideCount,
              armingUnknownCount,
              unavailableCount,
              now: currentTime,
            });

          if (
            presenceSummarySignature(currentPresenceSummary) !==
            presenceSummarySignature(nextPresenceSummary)
          ) {
            updates[presenceSummaryPath] =
              nextPresenceSummary;
          }

          const currentMemberPresenceStatus =
            asObject(home.memberPresenceStatus);

          if (
            memberPresenceStatusSignature(
              currentMemberPresenceStatus,
            ) !==
            memberPresenceStatusSignature(
              nextMemberPresenceStatus,
            )
          ) {
            updates[memberPresenceStatusPath] =
              nextMemberPresenceStatus;
          }

          const securityMode =
            normalizeHomeSecurityMode(home.securityMode);
          const securityModeSource = String(
            home.securityModeSource || "",
          ).trim();

          // Không bảo vệ là khóa ưu tiên tuyệt đối. Auto Away không được
          // tự bật Bảo vệ hoặc thay đổi mode này.
          if (securityMode === "unprotected") {
            const nextRuntime = buildRuntime({
              status: "unprotected_override",
              ...runtimeCounts,
              allOutsideSince: 0,
              cycleArmed: false,
              manualNormalSnoozeUntil: 0,
              insideOverrideUid: "",
              insideOverrideAt: 0,
              now: currentTime,
            });

            if (runtimeSignature(runtime) !== runtimeSignature(nextRuntime)) {
              updates[runtimePath] = nextRuntime;
            }

            continue;
          }

          // Bật Bảo vệ thủ công là khóa ưu tiên cao nhất:
          // Auto Away không được tự hạ về Bình thường và không ghi đè
          // nguồn manual khi user đã chủ động bật Bảo vệ.
          if (
            securityModeSource === "manual" &&
            securityMode === "armed"
          ) {
            const nextRuntime = buildRuntime({
              status: "manual_override",
              ...runtimeCounts,
              allOutsideSince: 0,
              cycleArmed: false,
              manualNormalSnoozeUntil: 0,
              insideOverrideUid: "",
              insideOverrideAt: 0,
              now: currentTime,
            });

            if (
              runtimeSignature(runtime) !==
              runtimeSignature(nextRuntime)
            ) {
              updates[runtimePath] = nextRuntime;
            }

            continue;
          }

          // Chuyển về Bình thường thủ công không được khóa Auto Away
          // vĩnh viễn. Đây chỉ là một khoảng tạm hoãn ngắn để user
          // không bị hệ tự bật lại ngay lập tức.
          if (
            securityModeSource === "manual" &&
            securityMode === "normal"
          ) {
            updates[`${homePath}/securityModeSource`] = null;

            if (autoAway.enabled === true) {
              const snoozeUntil =
                currentTime + AUTO_AWAY_MANUAL_NORMAL_SNOOZE_MS;

              const nextRuntime = buildRuntime({
                status: "manual_normal_snooze",
                ...runtimeCounts,
                allOutsideSince: 0,
                cycleArmed: false,
                manualNormalSnoozeUntil: snoozeUntil,
                insideOverrideUid: "",
                insideOverrideAt: 0,
                now: currentTime,
              });

              if (
                runtimeSignature(runtime) !==
                runtimeSignature(nextRuntime)
              ) {
                updates[runtimePath] = nextRuntime;
              }

              logs.push(
                `⏸️ AUTO AWAY MANUAL NORMAL SNOOZE: ${ownerUid} ${homeId} until=${snoozeUntil}`,
              );

              continue;
            }
          }

          if (autoAway.enabled !== true) {
            if (Object.keys(runtime).length > 0) {
              updates[runtimePath] = null;
            }

            if (
              home.securityMode === "armed" &&
              home.securityModeSource === "auto_away"
            ) {
              updates[`${homePath}/securityMode`] = "normal";
              updates[`${homePath}/securityModeSource`] = null;

              logs.push(
                `🏠 AUTO AWAY OFF → NORMAL: ${ownerUid} ${homeId}`,
              );
              modeNotifications.push({
                ownerUid,
                homeId,
                homeName: String(home.name || homeId).trim() || homeId,
                type: "auto_away_normal",
                title: "Bảo vệ tự động đã tắt",
                message: "Nhà đang ở chế độ Bình thường.",
                reason: "auto_away_disabled",
              });
            }

            continue;
          }

          // Nhà không có sensor thuộc nhóm an ninh không được tự bật
          // Mode Bảo vệ. Sensor môi trường/hạ tầng không được tính.
          if (!hasSecurityDevices(home)) {
            if (Object.keys(runtime).length > 0) {
              updates[runtimePath] = null;
            }

            if (
              home.securityMode === "armed" &&
              home.securityModeSource === "auto_away"
            ) {
              updates[`${homePath}/securityMode`] = "normal";
              updates[`${homePath}/securityModeSource`] = null;

              logs.push(
                `🏠 AUTO AWAY NO SECURITY DEVICES → NORMAL: ${ownerUid} ${homeId}`,
              );
              modeNotifications.push({
                ownerUid,
                homeId,
                homeName: String(home.name || homeId).trim() || homeId,
                type: "auto_away_normal",
                title: "Bảo vệ tự động đã tắt",
                message: "Nhà đang ở chế độ Bình thường.",
                reason: "no_security_devices",
              });
            }

            continue;
          }

          const manualNormalSnoozeUntil = Number(
            runtime.manualNormalSnoozeUntil || 0,
          );

          if (manualNormalSnoozeUntil > currentTime) {
            const nextRuntime = buildRuntime({
              status: "manual_normal_snooze",
              ...runtimeCounts,
              allOutsideSince: 0,
              cycleArmed: false,
              manualNormalSnoozeUntil,
              insideOverrideUid: "",
              insideOverrideAt: 0,
              now: currentTime,
            });

            if (
              runtimeSignature(runtime) !==
              runtimeSignature(nextRuntime)
            ) {
              updates[runtimePath] = nextRuntime;
            }

            continue;
          }

          // Không còn ai đủ điều kiện theo dõi nền:
          // - Nếu nhà chưa armed: không được bắt đầu chu kỳ Auto Away mới.
          // - Nếu Auto Away đã armed thành công: phải giữ nguyên armed.
          //   Việc mất quyền nền/auto-start/miễn tối ưu pin không được
          //   tự hạ Mode về Bình thường.
          // - Chỉ hạ Mode khi có một lần enter/initial_sync thực sự xảy ra
          //   sau khi chu kỳ rời nhà đã bắt đầu.
          const storedRearmBlockedUntil = Number(
            runtime.rearmBlockedUntil || 0,
          );

          const activeRearmBlockedUntil =
            storedRearmBlockedUntil > currentTime
              ? storedRearmBlockedUntil
              : 0;

          if (memberCount === 0) {
            const autoAwayAlreadyArmed =
              securityMode === "armed" &&
              securityModeSource === "auto_away";

            const awayCycleStartedAt = Number(
              runtime.allOutsideSince || 0,
            );

            let confirmedInsideUid = "";
            let confirmedInsideAt = 0;

            if (
              autoAwayAlreadyArmed &&
              awayCycleStartedAt > 0
            ) {
              for (const [memberUid, presenceStatus] of
                memberPresenceByUid.entries()) {
                if (
                  !participantSet.has(memberUid) ||
                  !presenceStatus.identityMatches ||
                  !presenceStatus.sessionActive ||
                  presenceStatus.state !== "inside" ||
                  presenceStatus.updatedAt <
                    awayCycleStartedAt ||
                  (
                    presenceStatus.event !== "enter" &&
                    presenceStatus.event !== "initial_sync"
                  )
                ) {
                  continue;
                }

                if (
                  presenceStatus.updatedAt >
                  confirmedInsideAt
                ) {
                  confirmedInsideUid = memberUid;
                  confirmedInsideAt =
                    presenceStatus.updatedAt;
                }
              }
            }

            let nextRuntime;

            if (confirmedInsideUid) {
              const storedCandidateUid = String(
                runtime.insideOverrideUid || "",
              ).trim();

              const storedCandidateSince = Number(
                runtime.insideCandidateSince || 0,
              );

              const insideCandidateSince =
                storedCandidateUid === confirmedInsideUid &&
                storedCandidateSince > 0
                  ? storedCandidateSince
                  : currentTime;

              const insideConfirmed =
                currentTime - insideCandidateSince >=
                AUTO_AWAY_INSIDE_CONFIRM_MS;

              if (insideConfirmed) {
                const rearmBlockedUntil =
                  currentTime + AUTO_AWAY_REARM_BLOCK_MS;

                nextRuntime = buildRuntime({
                  status: "inside_unmonitored",
                  ...runtimeCounts,
                  allOutsideSince: 0,
                  insideCandidateSince: 0,
                  rearmBlockedUntil,
                  cycleArmed: false,
                  insideOverrideUid:
                    confirmedInsideUid,
                  insideOverrideAt:
                    confirmedInsideAt,
                  now: currentTime,
                });

                updates[`${homePath}/securityMode`] =
                  "normal";
                updates[`${homePath}/securityModeSource`] =
                  null;

                logs.push(
                  `🏠 AUTO AWAY UNMONITORED MEMBER RETURNED → NORMAL: ${ownerUid} ${homeId} member=${confirmedInsideUid} rearmBlockedUntil=${rearmBlockedUntil}`,
                );
                modeNotifications.push({
                  ownerUid,
                  homeId,
                  homeName: String(home.name || homeId).trim() || homeId,
                  type: "auto_away_normal",
                  title: "Bảo vệ tự động đã tắt",
                  message: "Có thành viên đã trở về nhà.",
                  reason: "member_returned",
                });
              } else {
                nextRuntime = buildRuntime({
                  status:
                    "confirming_inside_unmonitored",
                  ...runtimeCounts,
                  allOutsideSince:
                    awayCycleStartedAt,
                  insideCandidateSince,
                  rearmBlockedUntil:
                    activeRearmBlockedUntil,
                  cycleArmed: true,
                  insideOverrideUid:
                    confirmedInsideUid,
                  insideOverrideAt:
                    confirmedInsideAt,
                  now: currentTime,
                });
              }
            } else if (autoAwayAlreadyArmed) {
              nextRuntime = buildRuntime({
                status:
                  "armed_monitoring_unavailable",
                ...runtimeCounts,
                allOutsideSince:
                  awayCycleStartedAt,
                insideCandidateSince: 0,
                rearmBlockedUntil:
                  activeRearmBlockedUntil,
                cycleArmed: true,
                insideOverrideUid: "",
                insideOverrideAt: 0,
                now: currentTime,
              });

              if (
                String(runtime.status || "") !==
                "armed_monitoring_unavailable"
              ) {
                logs.push(
                  `🛡️ AUTO AWAY ARMED KEPT, MONITORING UNAVAILABLE: ${ownerUid} ${homeId}`,
                );
              }
            } else {
              nextRuntime = buildRuntime({
                status:
                  activeRearmBlockedUntil > 0
                    ? "rearm_blocked"
                    : "waiting_monitoring",
                ...runtimeCounts,
                allOutsideSince: 0,
                insideCandidateSince: 0,
                rearmBlockedUntil:
                  activeRearmBlockedUntil,
                cycleArmed: false,
                insideOverrideUid: "",
                insideOverrideAt: 0,
                now: currentTime,
              });
            }

            if (
              runtimeSignature(runtime) !==
              runtimeSignature(nextRuntime)
            ) {
              updates[runtimePath] = nextRuntime;
            }

            continue;
          }

          const eligibleMemberInside =
            insideCount > 0;

          const storedInsideOverrideUid = String(
            runtime.insideOverrideUid || "",
          ).trim();

          const storedInsideOverrideAt = Number(
            runtime.insideOverrideAt || 0,
          );

          const storedOverridePresence =
            storedInsideOverrideUid
              ? memberPresenceByUid.get(
                  storedInsideOverrideUid,
                )
              : null;

          // Khi một người bị loại khỏi phép tính BẬT Auto Away
          // thực sự đi vào nhà, giữ Mode Bình thường cho tới khi
          // trạng thái của người đó đổi khỏi inside.
          const storedInsideOverrideActive =
            storedInsideOverrideUid &&
            participantSet.has(storedInsideOverrideUid) &&
            storedInsideOverrideAt > 0 &&
            storedOverridePresence &&
            storedOverridePresence.identityMatches === true &&
            storedOverridePresence.state === "inside" &&
            storedOverridePresence.updatedAt >=
              storedInsideOverrideAt;

          const awayCycleStartedAt = Number(
            runtime.allOutsideSince || 0,
          );

          let newInsideOverrideUid = "";
          let newInsideOverrideAt = 0;

          // Không dùng dữ liệu inside cũ để chặn Auto Away.
          // Chỉ nhận enter/initial_sync xảy ra sau khi chu kỳ
          // tất cả thành viên đủ điều kiện đã rời nhà bắt đầu.
          if (
            !storedInsideOverrideActive &&
            awayCycleStartedAt > 0
          ) {
            for (const [memberUid, presenceStatus] of
              memberPresenceByUid.entries()) {
              if (
                !participantSet.has(memberUid) ||
                presenceStatus.eligibleForArming ||
                !presenceStatus.identityMatches ||
                presenceStatus.state !== "inside" ||
                presenceStatus.updatedAt <
                  awayCycleStartedAt ||
                (
                  presenceStatus.event !== "enter" &&
                  presenceStatus.event !== "initial_sync"
                )
              ) {
                continue;
              }

              if (
                presenceStatus.updatedAt >
                newInsideOverrideAt
              ) {
                newInsideOverrideUid = memberUid;
                newInsideOverrideAt =
                  presenceStatus.updatedAt;
              }
            }
          }

          const excludedMemberInside =
            storedInsideOverrideActive ||
            newInsideOverrideUid !== "";

          const anyInsideForNormalMode =
            eligibleMemberInside ||
            excludedMemberInside;

          const allOutside =
            outsideCount === memberCount;

          const autoAwayAlreadyArmed =
            securityMode === "armed" &&
            securityModeSource === "auto_away";

          let nextRuntime;

          if (anyInsideForNormalMode) {
            const activeInsideOverrideUid =
              storedInsideOverrideActive
                ? storedInsideOverrideUid
                : newInsideOverrideUid;

            const activeInsideOverrideAt =
              storedInsideOverrideActive
                ? storedInsideOverrideAt
                : newInsideOverrideAt;

            const insideStatus =
              excludedMemberInside &&
              !eligibleMemberInside
                ? "inside_unmonitored"
                : "inside";

            if (autoAwayAlreadyArmed) {
              const storedInsideCandidateSince = Number(
                runtime.insideCandidateSince || 0,
              );

              const insideCandidateSince =
                storedInsideCandidateSince > 0
                  ? storedInsideCandidateSince
                  : currentTime;

              const insideConfirmed =
                currentTime - insideCandidateSince >=
                AUTO_AWAY_INSIDE_CONFIRM_MS;

              if (insideConfirmed) {
                const rearmBlockedUntil =
                  currentTime + AUTO_AWAY_REARM_BLOCK_MS;

                nextRuntime = buildRuntime({
                  status: insideStatus,
                  ...runtimeCounts,
                  allOutsideSince: 0,
                  insideCandidateSince: 0,
                  rearmBlockedUntil,
                  cycleArmed: false,
                  insideOverrideUid:
                    activeInsideOverrideUid,
                  insideOverrideAt:
                    activeInsideOverrideAt,
                  now: currentTime,
                });

                updates[`${homePath}/securityMode`] =
                  "normal";
                updates[`${homePath}/securityModeSource`] =
                  null;

                logs.push(
                  excludedMemberInside &&
                  !eligibleMemberInside
                    ? `🏠 AUTO AWAY UNMONITORED MEMBER RETURNED → NORMAL: ${ownerUid} ${homeId} member=${activeInsideOverrideUid} rearmBlockedUntil=${rearmBlockedUntil}`
                    : `🏠 AUTO AWAY MEMBER RETURNED → NORMAL: ${ownerUid} ${homeId} rearmBlockedUntil=${rearmBlockedUntil}`,
                );
                modeNotifications.push({
                  ownerUid,
                  homeId,
                  homeName: String(home.name || homeId).trim() || homeId,
                  type: "auto_away_normal",
                  title: "Bảo vệ tự động đã tắt",
                  message: "Có thành viên đã trở về nhà.",
                  reason: "member_returned",
                });
              } else {
                nextRuntime = buildRuntime({
                  status:
                    excludedMemberInside &&
                    !eligibleMemberInside
                      ? "confirming_inside_unmonitored"
                      : "confirming_inside",
                  ...runtimeCounts,
                  allOutsideSince:
                    awayCycleStartedAt,
                  insideCandidateSince,
                  rearmBlockedUntil:
                    activeRearmBlockedUntil,
                  cycleArmed: true,
                  insideOverrideUid:
                    activeInsideOverrideUid,
                  insideOverrideAt:
                    activeInsideOverrideAt,
                  now: currentTime,
                });
              }
            } else {
              nextRuntime = buildRuntime({
                status: insideStatus,
                ...runtimeCounts,
                allOutsideSince: 0,
                insideCandidateSince: 0,
                rearmBlockedUntil:
                  activeRearmBlockedUntil,
                cycleArmed: false,
                insideOverrideUid:
                  activeInsideOverrideUid,
                insideOverrideAt:
                  activeInsideOverrideAt,
                now: currentTime,
              });
            }
          } else if (!allOutside) {
            // Có trạng thái unknown hoặc dữ liệu chưa đầy đủ:
            // hủy cả hai bộ đếm xác nhận.
            nextRuntime = buildRuntime({
              status:
                activeRearmBlockedUntil > 0
                  ? "rearm_blocked"
                  : "waiting_presence",
              ...runtimeCounts,
              allOutsideSince: 0,
              insideCandidateSince: 0,
              rearmBlockedUntil:
                activeRearmBlockedUntil,
              cycleArmed: false,
              insideOverrideUid: "",
              insideOverrideAt: 0,
              now: currentTime,
            });
          } else if (activeRearmBlockedUntil > 0) {
            // Sau khi có người về nhà, Auto Away không được bật lại
            // trong 3 phút dù GPS tạm báo outside.
            nextRuntime = buildRuntime({
              status: "rearm_blocked",
              ...runtimeCounts,
              allOutsideSince: 0,
              insideCandidateSince: 0,
              rearmBlockedUntil:
                activeRearmBlockedUntil,
              cycleArmed: false,
              insideOverrideUid: "",
              insideOverrideAt: 0,
              now: currentTime,
            });
          } else {
            const storedSince = Number(
              runtime.allOutsideSince || 0,
            );

            const allOutsideSince =
              storedSince > 0 ? storedSince : currentTime;

            let cycleArmed = runtime.cycleArmed === true;
            const elapsed = currentTime - allOutsideSince;

            if (
              !cycleArmed &&
              elapsed >= AUTO_AWAY_ARM_DELAY_MS
            ) {
              cycleArmed = true;

              if (securityMode !== "armed") {
                updates[`${homePath}/securityMode`] = "armed";
                updates[`${homePath}/securityModeSource`] = "auto_away";

                logs.push(
                  `🛡️ AUTO AWAY ARMED: ${ownerUid} ${homeId} eligible=${memberCount} excluded=${excludedCount}`,
                );
                modeNotifications.push({
                  ownerUid,
                  homeId,
                  homeName: String(home.name || homeId).trim() || homeId,
                  type: "auto_away_armed",
                  title: "Bảo vệ tự động đã bật",
                  message: "Toàn bộ thành viên đã rời khỏi nhà.",
                  reason: "all_members_outside",
                });
              } else {
                logs.push(
                  `🛡️ AUTO AWAY CYCLE READY, MODE ALREADY ARMED: ${ownerUid} ${homeId}`,
                );
              }
            }

            nextRuntime = buildRuntime({
              status: cycleArmed ? "armed" : "countdown",
              ...runtimeCounts,
              allOutsideSince,
              insideCandidateSince: 0,
              rearmBlockedUntil: 0,
              cycleArmed,
              insideOverrideUid: "",
              insideOverrideAt: 0,
              now: currentTime,
            });
          }

          if (
            runtimeSignature(runtime) !==
            runtimeSignature(nextRuntime)
          ) {
            updates[runtimePath] = nextRuntime;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);

        for (const [
          runtimeKey,
          targetSignature,
        ] of pendingPresenceCleanupRuntimeUpdates) {
          presenceCleanupPersistedRuntimeMap.set(
            runtimeKey,
            targetSignature,
          );
        }
      }

      for (const item of modeNotifications) {
        await addHomeNotificationToHomeRecipients({
          ownerUid: item.ownerUid,
          homeId: item.homeId,
          homeName: item.homeName,
          type: item.type,
          category: "home",
          severity: "success",
          title: item.title,
          message: item.message,
          entityType: "home",
          entityId: item.homeId,
          dedupeKey: `${item.type}|${item.homeId}|${item.reason}`,
          dedupeMs: 30 * 1000,
          data: {
            securityMode: item.type === "auto_away_armed" ? "armed" : "normal",
            securityModeSource: "auto_away",
            reason: item.reason,
          },
        });
      }

      for (const line of logs) {
        log(line);
      }
    } catch (error) {
      log(
        "AUTO AWAY MONITOR ERROR:",
        error.message,
      );
    } finally {
      autoAwayScanRunning = false;
    }
  }

  function startAutoAwayMonitor() {
    if (!db) {
      throw new Error("AUTO AWAY DB IS REQUIRED");
    }

    if (autoAwayTimer) {
      return;
    }

    log(
      "📍 AUTO AWAY MONITOR STARTED:",
      `delay=${AUTO_AWAY_ARM_DELAY_MS / 1000}s`,
      `scan=${AUTO_AWAY_SCAN_INTERVAL_MS / 1000}s`,
      `sessionStale=${Math.round(presenceSessionCoordinator.accountSessionStaleMs / 60000)}m`,
    );

    void checkAutoAwayHomes();

    autoAwayTimer = setIntervalFn(
      () => {
        void checkAutoAwayHomes();
      },
      AUTO_AWAY_SCAN_INTERVAL_MS,
    );
  }

  function stopAutoAwayMonitor() {
    if (!autoAwayTimer) {
      return;
    }

    clearIntervalFn(autoAwayTimer);
    autoAwayTimer = null;
  }

  return {
    resolveAutoAwayParticipantSelection,
    getAccountSessionStatus,
    normalizePresenceMonitoringWarnings,
    getPresenceMonitoringAvailability,
    getMemberPresenceStatus,
    runtimeSignature,
    buildRuntime,
    presenceSummarySignature,
    buildPresenceSummary,
    checkAutoAwayHomes,
    startAutoAwayMonitor,
    stopAutoAwayMonitor,
  };
}

module.exports = {
  createAutoAwayDomain,
};
