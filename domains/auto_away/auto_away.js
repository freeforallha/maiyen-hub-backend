"use strict";

const {
  buildPresenceRecoveryMessage,
  createPresenceRecoveryCoordinator,
} = require("../../presence_recovery");
const {
  memberPresenceStatusSignature,
  presenceCleanupTargetSignature,
} = require("../../firebase_write_policy");

function createAutoAwayDomain({
  db,
  getCachedAccountsObject,
  getCachedSharedByHomeObject,
  sendPushToUser,
  addHomeNotificationToHomeRecipients,
  isSecurityDeviceType,
  normalizeHomeSecurityMode,
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

  // Chỉ dùng để hiển thị sức khỏe giám sát, không đổi inside/outside
  // thành unknown và không loại thành viên khỏi Auto Away.
  // Native geofence có thể im lặng nhiều giờ khi người dùng không
  // đi qua ranh giới, đây là hành vi bình thường.
  const AUTO_AWAY_MONITORING_HEALTH_STALE_MS =
    24 * 60 * 60 * 1000;
  const IOS_STALE_PRESENCE_MAX_AGE_MS =
    24 * 60 * 60 * 1000;
  // Nếu app/foreground service không ghi heartbeat nữa
  // (máy shutdown, hết pin, app bị kill hoàn toàn),
  // sau 12 phút backend sẽ coi vị trí là không xác định.
  const ACCOUNT_SESSION_STALE_MS =
    12 * 60 * 1000;

  // Trước khi Android session bị chuyển sang unknown, backend gửi tối đa
  // hai data-only FCM high-priority để app tự khôi phục foreground task và
  // ghi heartbeat ngay. Push thành công được giữ một grace ngắn; nếu app
  // vẫn không phản hồi sau hai lần thì trạng thái mới chuyển unknown.
  const presenceRecoveryCoordinator =
    createPresenceRecoveryCoordinator({
      triggerAgeMs: 8 * 60 * 1000,
      retryCooldownMs: 3 * 60 * 1000,
      graceMs: 3 * 60 * 1000,
      maxAttempts: 2,
    });

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

  function getAccountSessionStatus(account, now) {
    const sessions = Object.values(
      asObject(account?.sessions),
    ).map((rawSession) => asObject(rawSession));

    if (sessions.length === 0) {
      return {
        active: false,
        connected: false,
        reason: "legacy_session_missing",
        freshestSeenAt: 0,
        appState: "",
        signedInSessionCount: 0,
      };
    }

    let signedInCount = 0;
    let active = false;
    let connected = false;
    let freshestSeenAt = 0;
    let freshestAppState = "";
    let freshestPlatform = "";

    for (const session of sessions) {
      if (session.signedIn !== true) {
        continue;
      }

      signedInCount++;

      const lastSeenAt = Math.max(
        Number(session.lastSeenAt || 0),
        Number(session.lastLoginAt || 0),
      );

      if (lastSeenAt >= freshestSeenAt) {
        freshestSeenAt = lastSeenAt;
        freshestAppState = String(
          session.appState || "",
        ).trim();
        freshestPlatform = String(
          session.platform || "",
        ).trim();
      }

      const sessionIsActive =
        lastSeenAt > 0 &&
        now - lastSeenAt <= ACCOUNT_SESSION_STALE_MS;

      if (!sessionIsActive) {
        continue;
      }

      active = true;

      if (session.connected === true) {
        connected = true;
      }
    }

    if (active) {
      return {
        active: true,
        connected,
        reason: "",
        freshestSeenAt,
        appState: freshestAppState,
        platform: freshestPlatform,
        signedInSessionCount: signedInCount,
      };
    }

    return {
      active: false,
      connected: false,
      reason:
        signedInCount > 0
          ? "session_stale"
          : "signed_out",
      freshestSeenAt,
      appState: freshestAppState,
      platform: freshestPlatform,
      signedInSessionCount: signedInCount,
    };
  }


  function getPresenceRecoveryCandidate(uid, account) {
    const value = asObject(account);
    const activeSession = asObject(value.activeSession);
    const installationId = String(
      activeSession.installationId || "",
    ).trim();
    const sessionId = String(
      activeSession.sessionId || "",
    ).trim();

    if (!installationId || !sessionId) {
      return null;
    }

    const session = asObject(
      asObject(value.sessions)[installationId],
    );

    if (
      session.signedIn !== true ||
      String(session.sessionId || "").trim() !== sessionId
    ) {
      return null;
    }

    const lastSeenAt = Math.max(
      Number(session.lastSeenAt || 0),
      Number(session.lastLoginAt || 0),
    );

    return {
      uid: String(uid || "").trim(),
      installationId,
      platform: String(session.platform || "").trim(),
      signedIn: true,
      lastSeenAt,
    };
  }

  function normalizePresenceMonitoringWarnings(presence) {
    const value = asObject(presence);
    const warnings = new Set();
    const rawWarnings = value.monitoringWarnings;

    if (Array.isArray(rawWarnings)) {
      for (const rawWarning of rawWarnings) {
        const warning = String(rawWarning || "").trim();

        if (warning) {
          warnings.add(warning);
        }
      }
    } else if (
      rawWarnings &&
      typeof rawWarnings === "object"
    ) {
      for (const [rawWarning, enabled] of Object.entries(
        rawWarnings,
      )) {
        const warning = String(rawWarning || "").trim();

        if (warning && enabled === true) {
          warnings.add(warning);
        }
      }
    } else {
      const warning = String(rawWarnings || "").trim();

      if (warning) {
        warnings.add(warning);
      }
    }

    // Tương thích dữ liệu từ phiên bản app cũ.
    // Các trạng thái này chỉ là khuyến nghị, không được loại thành viên
    // khỏi phép tính Auto Away.
    if (value.batteryUnrestricted === false) {
      warnings.add("battery_optimization_recommended");
    }

    if (value.backgroundRestricted === true) {
      warnings.add("background_activity_restricted");
    }

    if (value.autoStartConfirmed === false) {
      warnings.add("auto_start_recommended");
    }

    const legacyReason = String(
      value.monitoringBlockingReason || "",
    ).trim();

    if (
      legacyReason === "battery_optimization_required"
    ) {
      warnings.add("battery_optimization_recommended");
    } else if (
      legacyReason === "background_restricted"
    ) {
      warnings.add("background_activity_restricted");
    } else if (
      legacyReason === "auto_start_required"
    ) {
      warnings.add("auto_start_recommended");
    }

    return Array.from(warnings).sort();
  }

  function monitoringWarningsToFirebaseMap(warnings) {
    const result = {};

    for (const rawWarning of Array.isArray(warnings)
      ? warnings
      : []) {
      const warning = String(rawWarning || "").trim();

      if (warning) {
        result[warning] = true;
      }
    }

    return Object.keys(result).length > 0
      ? result
      : null;
  }

  function getPresenceMonitoringAvailability(presence) {
    const value = asObject(presence);

    // locationAlwaysGranted là nguồn chuẩn của app hiện tại.
    if (
      Object.prototype.hasOwnProperty.call(
        value,
        "locationAlwaysGranted",
      )
    ) {
      return value.locationAlwaysGranted === true;
    }

    // Tương thích ngắn hạn với bản app đã ghi monitoringAvailable.
    if (
      Object.prototype.hasOwnProperty.call(
        value,
        "monitoringAvailable",
      )
    ) {
      return value.monitoringAvailable === true;
    }

    // Dữ liệu rất cũ chưa có hai trường trên.
    return value.monitoringEligible !== false;
  }

  function getMemberPresenceStatus(
    accounts,
    memberUid,
    ownerUid,
    homeId,
    sessionStatus,
    now,
    recoveryGraceActive = false,
  ) {
    const presence = asObject(
      accounts?.[memberUid]?.homePresence?.[homeId],
    );

    const storedOwnerUid = String(
      presence.ownerUid || "",
    ).trim();

    const storedHomeId = String(
      presence.homeId || "",
    ).trim();

    const identityMatches =
      storedOwnerUid === ownerUid &&
      storedHomeId === homeId;

    const rawState = String(
      presence.state || "unknown",
    ).trim();

    const event = String(
      presence.event || "",
    ).trim();

    const storedMonitoringBlockingReason = String(
      presence.monitoringBlockingReason || "",
    ).trim();

    const monitoringWarnings =
      normalizePresenceMonitoringWarnings(presence);

    const monitoringAvailable =
      getPresenceMonitoringAvailability(presence);

    const hasSignedOutMarker =
      event === "signed_out" ||
      storedMonitoringBlockingReason === "signed_out";

    const sessionActive =
    sessionStatus?.active === true;

  const sessionPlatform = String(
    sessionStatus?.platform || "",
  ).trim();

  const hasKnownState =
    rawState === "inside" ||
    rawState === "outside";

  const presenceUpdatedAt = Number(
    presence.updatedAt || 0,
  );

  const lastConfirmedAt = Math.max(
    Number(presence.lastConfirmedAt || 0),
    Number(presence.lastEventOccurredAt || 0),
    presenceUpdatedAt,
  );

  const sessionFreshestSeenAt = Number(
    sessionStatus?.freshestSeenAt || 0,
  );

  // Lấy lần hoạt động gần nhất từ cả session và geofence.
  // Geofence enter/exit hợp lệ cũng gia hạn trạng thái iOS.
  const iosFreshestActivityAt = Math.max(
    sessionFreshestSeenAt,
    lastConfirmedAt,
  );

  const iosPresenceExpired =
    sessionPlatform === "ios" &&
    (
      iosFreshestActivityAt <= 0 ||
      now - iosFreshestActivityAt >
        IOS_STALE_PRESENCE_MAX_AGE_MS
    );

  // iOS được phép giữ trạng thái khi app chỉ đang suspend,
  // nhưng không được giữ vô thời hạn.
  const staleIosPresenceAllowed =
    !sessionActive &&
    !hasSignedOutMarker &&
    !iosPresenceExpired &&
    sessionPlatform === "ios" &&
    Number(sessionStatus?.signedInSessionCount || 0) > 0;

  const androidRecoveryGraceAllowed =
    !sessionActive &&
    !hasSignedOutMarker &&
    recoveryGraceActive === true &&
    Number(sessionStatus?.signedInSessionCount || 0) > 0;

  const sessionAllowsPresence =
    sessionActive ||
    staleIosPresenceAllowed ||
    androidRecoveryGraceAllowed;

  // Session đang hoạt động luôn thắng marker signed_out cũ,
  // nhưng marker signed_out thật vẫn phải chặn trạng thái cũ.
  const explicitlySignedOut =
    hasSignedOutMarker && !sessionActive;

  const reactivatedAfterSignedOut =
    hasSignedOutMarker && sessionActive;

    // Chỉ là trạng thái sức khỏe để hiển thị/cảnh báo.
    // Không được đổi inside/outside thành unknown chỉ vì không có
    // heartbeat định kỳ trong lúc app chạy nền hoặc bị kết thúc.
    const monitoringHealthStale =
      monitoringAvailable &&
      hasKnownState &&
      lastConfirmedAt > 0 &&
      now - lastConfirmedAt >
        AUTO_AWAY_MONITORING_HEALTH_STALE_MS;

    const monitoringHealth =
      !monitoringAvailable
        ? "unavailable"
        : !hasKnownState
          ? "waiting_location"
          : monitoringHealthStale
            ? "stale"
            : "active";

    const monitoringHealthReason =
      monitoringHealth === "unavailable"
        ? (
            storedMonitoringBlockingReason ||
            "permission_required"
          )
        : monitoringHealth === "waiting_location"
          ? "location_not_confirmed"
          : monitoringHealth === "stale"
            ? "no_recent_confirmation"
            : "";

    // Chỉ quyền vị trí nền là điều kiện bắt buộc.
    // Pin/chạy nền/tự khởi động chỉ là cảnh báo.
    const monitoringEligible = monitoringAvailable;

    const monitoringBlockingReason =
      storedMonitoringBlockingReason === "signed_out"
        ? "signed_out"
        : monitoringAvailable
          ? ""
          : "permission_required";

    // Background/terminated dựa vào native geofence. Nếu không có
    // event mới thì trạng thái trước đó vẫn là trạng thái xác nhận
    // gần nhất; không được tự biến thành unknown sau 2 phút.
    const state =
      identityMatches &&
      sessionAllowsPresence &&
      !reactivatedAfterSignedOut &&
      hasKnownState
        ? rawState
        : "unknown";

    const eligibleForArming =
      identityMatches &&
      sessionAllowsPresence &&
      !reactivatedAfterSignedOut &&
      monitoringEligible &&
      hasKnownState;

    const unknownWhileMonitored =
      identityMatches &&
      sessionAllowsPresence &&
      monitoringEligible &&
      (
        reactivatedAfterSignedOut ||
        !hasKnownState
      );

    const sessionReason = sessionActive
      ? ""
      : explicitlySignedOut
        ? "signed_out"
        : staleIosPresenceAllowed
          ? "ios_background_geofence"
          : androidRecoveryGraceAllowed
            ? "android_presence_recovery"
            : String(sessionStatus?.reason || "").trim();

    return {
      identityMatches,
      eligibleForArming,
      unknownWhileMonitored,
      sessionActive,
      sessionAllowsPresence,
      staleIosPresenceAllowed,
      androidRecoveryGraceAllowed,
      sessionReason,
      reactivatedAfterSignedOut,
      needsSessionCleanup:
        identityMatches && !sessionAllowsPresence,
      state,
      rawState,
      event,
      monitoringEligible,
      monitoringAvailable,
      monitoringWarnings,
      monitoringBlockingReason,
      monitoringHealth,
      monitoringHealthReason,
      monitoringHealthStale,
      lastConfirmedAt,
      storedMonitoringEligible:
        presence.monitoringEligible === true,
      storedMonitoringAvailable:
        presence.monitoringAvailable === true,
      storedMonitoringBlockingReason,
      updatedAt: presenceUpdatedAt,
    };
  }

  function runtimeSignature(runtime) {
    const value = asObject(runtime);

    return JSON.stringify({
      status: String(value.status || ""),
      totalMemberCount: Number(value.totalMemberCount || 0),
      participantCount: Number(value.participantCount || 0),
      memberCount: Number(value.memberCount || 0),
      eligibleMemberCount: Number(
        value.eligibleMemberCount || 0,
      ),
      excludedCount: Number(value.excludedCount || 0),
      insideCount: Number(value.insideCount || 0),
      outsideCount: Number(value.outsideCount || 0),
      unknownCount: Number(value.unknownCount || 0),
      knownLocationCount: Number(
        value.knownLocationCount || 0,
      ),
      armingInsideCount: Number(
        value.armingInsideCount || 0,
      ),
      armingOutsideCount: Number(
        value.armingOutsideCount || 0,
      ),
      armingUnknownCount: Number(
        value.armingUnknownCount || 0,
      ),
      allOutsideSince: Number(value.allOutsideSince || 0),
      insideCandidateSince: Number(
        value.insideCandidateSince || 0,
      ),
      rearmBlockedUntil: Number(
        value.rearmBlockedUntil || 0,
      ),
      cycleArmed: value.cycleArmed === true,
      manualNormalSnoozeUntil: Number(
        value.manualNormalSnoozeUntil || 0,
      ),
      insideOverrideUid: String(
        value.insideOverrideUid || "",
      ),
      insideOverrideAt: Number(
        value.insideOverrideAt || 0,
      ),
    });
  }

  function buildRuntime({
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
      knownLocationCount ??
        safeInsideCount + safeOutsideCount,
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
      insideCandidateSince:
        Number(insideCandidateSince || 0) || null,
      rearmBlockedUntil:
        Number(rearmBlockedUntil || 0) || null,
      cycleArmed: cycleArmed === true,
      manualNormalSnoozeUntil:
        Number(manualNormalSnoozeUntil || 0) || null,
      insideOverrideUid:
        String(insideOverrideUid || "").trim() || null,
      insideOverrideAt:
        Number(insideOverrideAt || 0) || null,
      updatedAt: now,
    };
  }

  function presenceSummarySignature(summary) {
    const value = asObject(summary);

    return JSON.stringify({
      totalMemberCount: Number(value.totalMemberCount || 0),
      participantCount: Number(value.participantCount || 0),
      participantInsideCount: Number(
        value.participantInsideCount || 0,
      ),
      participantOutsideCount: Number(
        value.participantOutsideCount || 0,
      ),
      participantUnknownCount: Number(
        value.participantUnknownCount || 0,
      ),
      signedInCount: Number(value.signedInCount || 0),
      onlineCount: Number(value.onlineCount || 0),
      connectedCount: Number(value.connectedCount || 0),
      memberCount: Number(value.memberCount || 0),
      eligibleMemberCount: Number(
        value.eligibleMemberCount || 0,
      ),
      excludedCount: Number(value.excludedCount || 0),
      insideCount: Number(value.insideCount || 0),
      outsideCount: Number(value.outsideCount || 0),
      unknownCount: Number(value.unknownCount || 0),
      knownLocationCount: Number(
        value.knownLocationCount || 0,
      ),
      armingInsideCount: Number(
        value.armingInsideCount || 0,
      ),
      armingOutsideCount: Number(
        value.armingOutsideCount || 0,
      ),
      armingUnknownCount: Number(
        value.armingUnknownCount || 0,
      ),
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
      participantInsideCount: Number(
        participantInsideCount || 0,
      ),
      participantOutsideCount: Number(
        participantOutsideCount || 0,
      ),
      participantUnknownCount: Number(
        participantUnknownCount || 0,
      ),
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
      const sessionStatusByUid = new Map();
      const pendingPresenceCleanupRuntimeUpdates = [];

      const presenceRecoveryCandidateByUid = new Map();
      const presenceRecoveryGraceByUid = new Map();

      for (const [accountUid, rawAccount] of Object.entries(accounts)) {
        const account = asObject(rawAccount);

        sessionStatusByUid.set(
          accountUid,
          getAccountSessionStatus(
            account,
            currentTime,
          ),
        );

        const candidate = getPresenceRecoveryCandidate(
          accountUid,
          account,
        );

        if (candidate) {
          presenceRecoveryCandidateByUid.set(
            accountUid,
            candidate,
          );
        }
      }

      for (const [accountUid, candidate] of
        presenceRecoveryCandidateByUid.entries()) {
        const plan = presenceRecoveryCoordinator.evaluate(
          candidate,
          currentTime,
        );

        if (plan.shouldRequest) {
          let result = { sent: 0 };

          try {
            result = await sendPushToUser(
              accountUid,
              buildPresenceRecoveryMessage({
                requestedAt: currentTime,
                attemptNumber: plan.attemptNumber,
              }),
              "PRESENCE RECOVERY",
            );
          } catch (error) {
            logs.push(
              `⚠️ PRESENCE RECOVERY PUSH ERROR: ${accountUid} ${error.message}`,
            );
          }

          presenceRecoveryCoordinator.recordAttempt(
            plan,
            result,
            currentTime,
          );

          logs.push(
            `📍 PRESENCE RECOVERY REQUEST: ${accountUid} attempt=${plan.attemptNumber} sent=${Number(result.sent || 0)}`,
          );
        }

        const currentRecovery =
          presenceRecoveryCoordinator.evaluate(
            candidate,
            currentTime,
          );

        if (currentRecovery.graceActive) {
          presenceRecoveryGraceByUid.set(
            accountUid,
            true,
          );
        }
      }

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
      `sessionStale=${Math.round(ACCOUNT_SESSION_STALE_MS / 60000)}m`,
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
