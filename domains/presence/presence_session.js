"use strict";

const {
  buildPresenceRecoveryMessage,
  createPresenceRecoveryCoordinator,
} = require("../../presence_recovery");

const DEFAULT_ACCOUNT_SESSION_STALE_MS = 12 * 60 * 1000;
const DEFAULT_IOS_STALE_PRESENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MONITORING_HEALTH_STALE_MS = 24 * 60 * 60 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function createPresenceSessionCoordinator({
  sendPushToUser,
  now = () => Date.now(),
  accountSessionStaleMs = DEFAULT_ACCOUNT_SESSION_STALE_MS,
  iosStalePresenceMaxAgeMs = DEFAULT_IOS_STALE_PRESENCE_MAX_AGE_MS,
  monitoringHealthStaleMs = DEFAULT_MONITORING_HEALTH_STALE_MS,
  recoveryTriggerAgeMs = 8 * 60 * 1000,
  recoveryRetryCooldownMs = 3 * 60 * 1000,
  recoveryGraceMs = 3 * 60 * 1000,
  recoveryMaxAttempts = 2,
} = {}) {
  if (typeof sendPushToUser !== "function") {
    throw new TypeError(
      "createPresenceSessionCoordinator requires sendPushToUser",
    );
  }

  const presenceRecoveryCoordinator =
    createPresenceRecoveryCoordinator({
      triggerAgeMs: recoveryTriggerAgeMs,
      retryCooldownMs: recoveryRetryCooldownMs,
      graceMs: recoveryGraceMs,
      maxAttempts: recoveryMaxAttempts,
    });

  function getAccountSessionStatus(account, currentTime = now()) {
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
        platform: "",
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
        currentTime - lastSeenAt <= accountSessionStaleMs;

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
      reason: signedInCount > 0 ? "session_stale" : "signed_out",
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

    if (legacyReason === "battery_optimization_required") {
      warnings.add("battery_optimization_recommended");
    } else if (legacyReason === "background_restricted") {
      warnings.add("background_activity_restricted");
    } else if (legacyReason === "auto_start_required") {
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

    if (
      Object.prototype.hasOwnProperty.call(
        value,
        "locationAlwaysGranted",
      )
    ) {
      return value.locationAlwaysGranted === true;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        value,
        "monitoringAvailable",
      )
    ) {
      return value.monitoringAvailable === true;
    }

    return value.monitoringEligible !== false;
  }

  function getMemberPresenceStatus(
    accounts,
    memberUid,
    ownerUid,
    homeId,
    sessionStatus,
    currentTime = now(),
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
      storedOwnerUid === ownerUid && storedHomeId === homeId;
    const rawState = String(
      presence.state || "unknown",
    ).trim();
    const event = String(presence.event || "").trim();
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
    const sessionActive = sessionStatus?.active === true;
    const sessionPlatform = String(
      sessionStatus?.platform || "",
    ).trim();
    const hasKnownState =
      rawState === "inside" || rawState === "outside";
    const presenceUpdatedAt = Number(presence.updatedAt || 0);
    const lastConfirmedAt = Math.max(
      Number(presence.lastConfirmedAt || 0),
      Number(presence.lastEventOccurredAt || 0),
      presenceUpdatedAt,
    );
    const sessionFreshestSeenAt = Number(
      sessionStatus?.freshestSeenAt || 0,
    );
    const iosFreshestActivityAt = Math.max(
      sessionFreshestSeenAt,
      lastConfirmedAt,
    );
    const iosPresenceExpired =
      sessionPlatform === "ios" &&
      (
        iosFreshestActivityAt <= 0 ||
        currentTime - iosFreshestActivityAt >
          iosStalePresenceMaxAgeMs
      );
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
    const explicitlySignedOut =
      hasSignedOutMarker && !sessionActive;
    const reactivatedAfterSignedOut =
      hasSignedOutMarker && sessionActive;
    const monitoringHealthStale =
      monitoringAvailable &&
      hasKnownState &&
      lastConfirmedAt > 0 &&
      currentTime - lastConfirmedAt > monitoringHealthStaleMs;
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
    const monitoringEligible = monitoringAvailable;
    const monitoringBlockingReason =
      storedMonitoringBlockingReason === "signed_out"
        ? "signed_out"
        : monitoringAvailable
          ? ""
          : "permission_required";
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
      (reactivatedAfterSignedOut || !hasKnownState);
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

  async function prepareSessionContext(
    accounts,
    currentTime = now(),
  ) {
    const safeAccounts = asObject(accounts);
    const sessionStatusByUid = new Map();
    const recoveryCandidateByUid = new Map();
    const recoveryGraceByUid = new Map();
    const logs = [];

    for (const [uid, rawAccount] of Object.entries(safeAccounts)) {
      const account = asObject(rawAccount);
      sessionStatusByUid.set(
        uid,
        getAccountSessionStatus(account, currentTime),
      );

      const candidate = getPresenceRecoveryCandidate(uid, account);

      if (candidate) {
        recoveryCandidateByUid.set(uid, candidate);
      }
    }

    for (const [uid, candidate] of recoveryCandidateByUid.entries()) {
      const plan = presenceRecoveryCoordinator.evaluate(
        candidate,
        currentTime,
      );

      if (plan.shouldRequest) {
        let result = { sent: 0 };

        try {
          result = await sendPushToUser(
            uid,
            buildPresenceRecoveryMessage({
              requestedAt: currentTime,
              attemptNumber: plan.attemptNumber,
            }),
            "PRESENCE RECOVERY",
          );
        } catch (error) {
          logs.push(
            `⚠️ PRESENCE RECOVERY PUSH ERROR: ${uid} ${error.message}`,
          );
        }

        presenceRecoveryCoordinator.recordAttempt(
          plan,
          result,
          currentTime,
        );

        logs.push(
          `📍 PRESENCE RECOVERY REQUEST: ${uid} attempt=${plan.attemptNumber} sent=${Number(result.sent || 0)}`,
        );
      }

      const currentRecovery = presenceRecoveryCoordinator.evaluate(
        candidate,
        currentTime,
      );

      if (currentRecovery.graceActive) {
        recoveryGraceByUid.set(uid, true);
      }
    }

    return {
      sessionStatusByUid,
      recoveryGraceByUid,
      logs,
    };
  }

  return {
    accountSessionStaleMs,
    getAccountSessionStatus,
    getPresenceRecoveryCandidate,
    normalizePresenceMonitoringWarnings,
    monitoringWarningsToFirebaseMap,
    getPresenceMonitoringAvailability,
    getMemberPresenceStatus,
    prepareSessionContext,
  };
}

module.exports = {
  DEFAULT_ACCOUNT_SESSION_STALE_MS,
  DEFAULT_IOS_STALE_PRESENCE_MAX_AGE_MS,
  DEFAULT_MONITORING_HEALTH_STALE_MS,
  createPresenceSessionCoordinator,
};
