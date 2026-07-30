"use strict";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }

  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} must be an object`);
  }

  return value;
}

function createFcmDeliveryDomain(options = {}) {
  const db = requireObject(options.db, "db");
  const admin = requireObject(options.admin, "admin");
  const accountCache = requireObject(
    options.accountCache,
    "accountCache",
  );
  const normalizeLanguageCode = requireFunction(
    options.normalizeLanguageCode,
    "normalizeLanguageCode",
  );
  const localizeBackendText = requireFunction(
    options.localizeBackendText,
    "localizeBackendText",
  );
  const localizeAlarmItemsJson = requireFunction(
    options.localizeAlarmItemsJson,
    "localizeAlarmItemsJson",
  );
  const log =
    typeof options.log === "function"
      ? options.log
      : () => {};

  requireFunction(db.ref, "db.ref");
  requireFunction(admin.messaging, "admin.messaging");
  requireFunction(accountCache.get, "accountCache.get");

  function normalizeFcmToken(raw) {
    return String(raw || "").trim();
  }

  function getUserLanguageCode(uid) {
    const cleanUid = String(uid || "").trim();
    const account = cleanUid
      ? accountCache.get(cleanUid)
      : null;

    return normalizeLanguageCode(
      account?.languageCode ||
      account?.profile?.languageCode ||
      "vi",
    );
  }

  function localizePushMessageForUser(uid, rawMessage) {
    const languageCode = getUserLanguageCode(uid);
    const message = JSON.parse(
      JSON.stringify(rawMessage || {}),
    );

    if (message.data && typeof message.data === "object") {
      for (const field of [
        "title",
        "body",
        "message",
        "text",
        "subtitle",
        "reason",
        "statusText",
      ]) {
        if (typeof message.data[field] === "string") {
          message.data[field] = localizeBackendText(
            languageCode,
            message.data[field],
          );
        }
      }

      if (typeof message.data.alarmItems === "string") {
        message.data.alarmItems = localizeAlarmItemsJson(
          languageCode,
          message.data.alarmItems,
        );
      }

      message.data.languageCode = languageCode;
    }

    if (
      message.notification &&
      typeof message.notification === "object"
    ) {
      if (
        typeof message.notification.title === "string"
      ) {
        message.notification.title = localizeBackendText(
          languageCode,
          message.notification.title,
        );
      }

      if (
        typeof message.notification.body === "string"
      ) {
        message.notification.body = localizeBackendText(
          languageCode,
          message.notification.body,
        );
      }
    }

    const apnsAlert = message?.apns?.payload?.aps?.alert;

    if (typeof apnsAlert === "string") {
      message.apns.payload.aps.alert = localizeBackendText(
        languageCode,
        apnsAlert,
      );
    } else if (
      apnsAlert &&
      typeof apnsAlert === "object"
    ) {
      if (typeof apnsAlert.title === "string") {
        apnsAlert.title = localizeBackendText(
          languageCode,
          apnsAlert.title,
        );
      }

      if (typeof apnsAlert.body === "string") {
        apnsAlert.body = localizeBackendText(
          languageCode,
          apnsAlert.body,
        );
      }
    }

    return message;
  }

  async function getUserFcmTargets(uid) {
    const cleanUid = String(uid || "").trim();

    if (!cleanUid) {
      return [];
    }

    const accountSnap = await db
      .ref(`accounts/${cleanUid}`)
      .once("value");

    const account = accountSnap.val() || {};
    const activeSession =
      account.activeSession &&
      typeof account.activeSession === "object"
        ? account.activeSession
        : {};

    const installationId = String(
      activeSession.installationId || "",
    ).trim();
    const sessionId = String(
      activeSession.sessionId || "",
    ).trim();

    if (!installationId || !sessionId) {
      log(
        "❌ NO ACTIVE SESSION FOR PUSH:",
        cleanUid,
      );
      return [];
    }

    const session =
      account.sessions?.[installationId] &&
      typeof account.sessions[installationId] === "object"
        ? account.sessions[installationId]
        : null;

    if (
      session &&
      (
        String(session.sessionId || "").trim() !==
          sessionId ||
        session.signedIn === false
      )
    ) {
      log(
        "❌ ACTIVE SESSION RECORD MISMATCH:",
        cleanUid,
        installationId,
      );
      return [];
    }

    const tokenEntry =
      account.fcmTokens?.[installationId];

    if (
      !tokenEntry ||
      typeof tokenEntry !== "object"
    ) {
      log(
        "❌ NO ACTIVE INSTALLATION TOKEN:",
        cleanUid,
        installationId,
      );
      return [];
    }

    const tokenSessionId = String(
      tokenEntry.sessionId || "",
    ).trim();
    const token = normalizeFcmToken(tokenEntry.token);

    if (!token || tokenSessionId !== sessionId) {
      log(
        "❌ ACTIVE TOKEN SESSION MISMATCH:",
        cleanUid,
        installationId,
      );
      return [];
    }

    return [
      {
        token,
        paths: [
          `accounts/${cleanUid}/fcmTokens/${installationId}`,
        ],
      },
    ];
  }

  function isInvalidFcmTokenError(error) {
    const code = String(
      error?.errorInfo?.code ||
      error?.code ||
      "",
    );

    return (
      code ===
        "messaging/registration-token-not-registered" ||
      code ===
        "messaging/invalid-registration-token"
    );
  }

  async function removeInvalidFcmTokenPaths(paths) {
    const updates = {};

    for (const path of paths || []) {
      if (path) {
        updates[path] = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    await db.ref().update(updates);
  }

  async function sendPushToUser(
    uid,
    message,
    logLabel = "PUSH",
  ) {
    const targets = await getUserFcmTargets(uid);
    const localizedMessage =
      localizePushMessageForUser(uid, message);

    if (targets.length === 0) {
      log(
        "❌ NO FCM TOKEN:",
        uid,
        logLabel,
      );

      return {
        total: 0,
        sent: 0,
        failed: 0,
        removed: 0,
      };
    }

    let sent = 0;
    let failed = 0;
    const invalidPaths = new Set();

    for (const target of targets) {
      try {
        await admin.messaging().send({
          ...localizedMessage,
          token: target.token,
        });

        sent++;
      } catch (error) {
        failed++;

        if (isInvalidFcmTokenError(error)) {
          for (const path of target.paths) {
            invalidPaths.add(path);
          }

          log(
            "🧹 INVALID FCM TOKEN:",
            uid,
            logLabel,
            error?.errorInfo?.code ||
              error?.code ||
              error.message,
          );

          continue;
        }

        log(
          "FCM TARGET SEND ERROR:",
          uid,
          logLabel,
          error.message,
        );
      }
    }

    if (invalidPaths.size > 0) {
      try {
        await removeInvalidFcmTokenPaths(
          Array.from(invalidPaths),
        );
      } catch (error) {
        log(
          "FCM TOKEN CLEANUP ERROR:",
          uid,
          logLabel,
          error.message,
        );
      }
    }

    log(
      "📨 MULTI-DEVICE PUSH:",
      uid,
      logLabel,
      `sent=${sent}`,
      `failed=${failed}`,
      `targets=${targets.length}`,
    );

    return {
      total: targets.length,
      sent,
      failed,
      removed: invalidPaths.size,
    };
  }

  return {
    normalizeFcmToken,
    getUserLanguageCode,
    localizePushMessageForUser,
    getUserFcmTargets,
    isInvalidFcmTokenError,
    removeInvalidFcmTokenPaths,
    sendPushToUser,
  };
}

module.exports = {
  createFcmDeliveryDomain,
};
