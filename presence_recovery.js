"use strict";

const DEFAULT_TRIGGER_AGE_MS = 8 * 60 * 1000;
const DEFAULT_RETRY_COOLDOWN_MS = 3 * 60 * 1000;
const DEFAULT_GRACE_MS = 3 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeTimestamp(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function createPresenceRecoveryCoordinator(options = {}) {
  const triggerAgeMs = Number(
    options.triggerAgeMs || DEFAULT_TRIGGER_AGE_MS,
  );
  const retryCooldownMs = Number(
    options.retryCooldownMs || DEFAULT_RETRY_COOLDOWN_MS,
  );
  const graceMs = Number(
    options.graceMs || DEFAULT_GRACE_MS,
  );
  const maxAttempts = Number(
    options.maxAttempts || DEFAULT_MAX_ATTEMPTS,
  );
  const stateRetentionMs = Number(
    options.stateRetentionMs || DEFAULT_STATE_RETENTION_MS,
  );
  const stateByInstallation = new Map();

  function keyFor(candidate) {
    const uid = normalizeText(candidate?.uid);
    const installationId = normalizeText(
      candidate?.installationId,
    );

    return uid && installationId
      ? `${uid}:${installationId}`
      : "";
  }

  function prune(now) {
    for (const [key, state] of stateByInstallation.entries()) {
      const freshestActivityAt = Math.max(
        normalizeTimestamp(state.lastAttemptAt),
        normalizeTimestamp(state.lastSuccessfulAt),
        normalizeTimestamp(state.baselineSeenAt),
      );

      if (
        freshestActivityAt > 0 &&
        now - freshestActivityAt > stateRetentionMs
      ) {
        stateByInstallation.delete(key);
      }
    }
  }

  function evaluate(candidate, now = Date.now()) {
    const key = keyFor(candidate);
    const platform = normalizeText(candidate?.platform).toLowerCase();
    const lastSeenAt = normalizeTimestamp(candidate?.lastSeenAt);
    const signedIn = candidate?.signedIn === true;

    prune(now);

    if (!key || platform !== "android" || !signedIn || lastSeenAt <= 0) {
      if (key) {
        stateByInstallation.delete(key);
      }

      return {
        eligible: false,
        shouldRequest: false,
        graceActive: false,
        attemptNumber: 0,
        key,
      };
    }

    const ageMs = Math.max(0, now - lastSeenAt);

    if (ageMs < triggerAgeMs) {
      stateByInstallation.delete(key);

      return {
        eligible: true,
        shouldRequest: false,
        graceActive: false,
        attemptNumber: 0,
        key,
        ageMs,
      };
    }

    let state = stateByInstallation.get(key);

    if (!state || state.baselineSeenAt !== lastSeenAt) {
      state = {
        baselineSeenAt: lastSeenAt,
        attemptCount: 0,
        lastAttemptAt: 0,
        lastSuccessfulAt: 0,
      };
      stateByInstallation.set(key, state);
    }

    const graceActive =
      state.lastSuccessfulAt > 0 &&
      now - state.lastSuccessfulAt <= graceMs;
    const cooldownElapsed =
      state.lastAttemptAt <= 0 ||
      now - state.lastAttemptAt >= retryCooldownMs;
    const shouldRequest =
      state.attemptCount < maxAttempts && cooldownElapsed;

    return {
      eligible: true,
      shouldRequest,
      graceActive,
      attemptNumber: shouldRequest
        ? state.attemptCount + 1
        : state.attemptCount,
      key,
      ageMs,
      baselineSeenAt: lastSeenAt,
    };
  }

  function recordAttempt(plan, result, now = Date.now()) {
    const key = normalizeText(plan?.key);

    if (!key || plan?.eligible !== true || plan?.shouldRequest !== true) {
      return;
    }

    const state = stateByInstallation.get(key);

    if (!state || state.baselineSeenAt !== plan.baselineSeenAt) {
      return;
    }

    state.attemptCount = Math.min(
      maxAttempts,
      state.attemptCount + 1,
    );
    state.lastAttemptAt = now;

    if (Number(result?.sent || 0) > 0) {
      state.lastSuccessfulAt = now;
    }
  }

  return {
    evaluate,
    recordAttempt,
    _stateByInstallation: stateByInstallation,
  };
}

function buildPresenceRecoveryMessage({
  requestedAt = Date.now(),
  attemptNumber = 1,
} = {}) {
  return {
    data: {
      type: "presence_recovery",
      trigger: "session_stale_watchdog",
      requestedAt: String(requestedAt),
      attemptNumber: String(attemptNumber),
    },
    android: {
      priority: "high",
      collapseKey: "maiyen_presence_recovery",
      ttl: 60 * 1000,
    },
  };
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_COOLDOWN_MS,
  DEFAULT_STATE_RETENTION_MS,
  DEFAULT_TRIGGER_AGE_MS,
  buildPresenceRecoveryMessage,
  createPresenceRecoveryCoordinator,
};
