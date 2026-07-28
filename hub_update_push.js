"use strict";

const crypto = require("crypto");
const {
  getHubUpdatePushText,
} = require("./hub_update_push_localizations");

const HUB_UPDATE_PUSH_SCHEMA_VERSION = 1;
const DEFAULT_HUB_UPDATE_PUSH_RETRY_INTERVAL_MS =
  15 * 60 * 1000;
const DEFAULT_HUB_UPDATE_PUSH_MARKER_ROOT =
  "system/hubUpdatePushState";

function cleanString(value) {
  return String(value || "").trim();
}

function buildHubUpdatePushMarkerKey({
  ownerUid,
  homeId,
  receiverUid,
}) {
  return crypto
    .createHash("sha256")
    .update(
      [
        cleanString(ownerUid),
        cleanString(homeId),
        cleanString(receiverUid),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 40);
}

function buildHubUpdatePushMessage({
  manifest,
  ownerUid,
  homeId,
  homeName = "",
  languageCode = "vi",
}) {
  const releaseId = cleanString(manifest?.releaseId);
  const cleanOwnerUid = cleanString(ownerUid);
  const cleanHomeId = cleanString(homeId);
  const cleanHomeName = cleanString(homeName);

  if (!releaseId || !cleanOwnerUid || !cleanHomeId) {
    throw new Error("invalid_hub_update_push_context");
  }

  const critical = manifest?.critical === true;
  const localized = getHubUpdatePushText({
    languageCode,
    releaseId,
    critical,
    homeName: cleanHomeName,
  });

  const data = {
    type: "hub_update_available",
    title: localized.title,
    body: localized.body,
    ownerUid: cleanOwnerUid,
    homeId: cleanHomeId,
    homeName: cleanHomeName,
    releaseId,
    backendVersion: cleanString(manifest?.backendVersion),
    hubFirmwareVersion: cleanString(
      manifest?.hubFirmwareVersion,
    ),
    protocolVersion: cleanString(
      manifest?.protocolVersion,
    ),
    critical: critical ? "true" : "false",
    publishedAt: String(
      Number(manifest?.publishedAt) || 0,
    ),
    clickAction: "hub_update",
  };

  const threadKey = crypto
    .createHash("sha256")
    .update(`${cleanOwnerUid}|${cleanHomeId}`)
    .digest("hex")
    .slice(0, 20);

  return {
    data,

    // Android nhận data-only push để background handler của App tạo đúng
    // local notification, đúng channel và đúng ngôn ngữ đang chọn.
    android: {
      priority: "high",
    },

    // iOS cần APNs alert để vẫn hiện thông báo khi App ở background hoặc
    // đã bị đóng. Data vẫn đi kèm để mở đúng nhà khi người dùng chạm.
    apns: {
      headers: {
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: {
            title: localized.title,
            body: localized.body,
          },
          sound: "default",
          "thread-id": `hub_update_${threadKey}`,
        },
      },
    },
  };
}

function createHubUpdatePushCoordinator({
  db,
  deviceId,
  getLinkedHomes,
  getReceiverUids,
  getHomeData,
  getLanguageCode,
  sendPushToUser,
  markerRoot = DEFAULT_HUB_UPDATE_PUSH_MARKER_ROOT,
  retryIntervalMs =
    DEFAULT_HUB_UPDATE_PUSH_RETRY_INTERVAL_MS,
  now = () => Date.now(),
}) {
  if (!db || typeof db.ref !== "function") {
    throw new Error("hub_update_push_requires_database");
  }

  if (typeof getLinkedHomes !== "function") {
    throw new Error(
      "hub_update_push_requires_linked_home_provider",
    );
  }

  if (typeof getReceiverUids !== "function") {
    throw new Error(
      "hub_update_push_requires_receiver_provider",
    );
  }

  if (typeof sendPushToUser !== "function") {
    throw new Error("hub_update_push_requires_sender");
  }

  const cleanDeviceId = cleanString(deviceId);

  if (!cleanDeviceId) {
    throw new Error("hub_update_push_requires_device_id");
  }

  const effectiveRetryIntervalMs = Math.max(
    60 * 1000,
    Number(retryIntervalMs) ||
      DEFAULT_HUB_UPDATE_PUSH_RETRY_INTERVAL_MS,
  );

  let checkInProgress = false;

  async function sendForReceiver({
    manifest,
    ownerUid,
    homeId,
    homeName,
    receiverUid,
  }) {
    const releaseId = cleanString(manifest?.releaseId);
    const cleanReceiverUid = cleanString(receiverUid);

    if (!releaseId || !cleanReceiverUid) {
      return {
        status: "invalid",
        sent: 0,
      };
    }

    const markerKey = buildHubUpdatePushMarkerKey({
      ownerUid,
      homeId,
      receiverUid: cleanReceiverUid,
    });

    const markerRef = db.ref(
      `${cleanString(markerRoot)}/${cleanDeviceId}/${markerKey}`,
    );

    const currentSnapshot = await markerRef.once("value");
    const current = currentSnapshot.val() || {};
    const currentTime = Number(now()) || Date.now();
    const sameRelease =
      cleanString(current.releaseId) === releaseId;
    const lastAttemptAt = Number(current.lastAttemptAt) || 0;

    if (sameRelease && current.status === "sent") {
      return {
        status: "already_sent",
        sent: 0,
      };
    }

    if (
      sameRelease &&
      lastAttemptAt > 0 &&
      currentTime - lastAttemptAt <
        effectiveRetryIntervalMs
    ) {
      return {
        status: "retry_wait",
        sent: 0,
      };
    }

    const failedAttempts = sameRelease
      ? Math.max(0, Number(current.failedAttempts) || 0)
      : 0;

    await markerRef.set({
      schemaVersion: HUB_UPDATE_PUSH_SCHEMA_VERSION,
      hubId: cleanDeviceId,
      ownerUid: cleanString(ownerUid),
      homeId: cleanString(homeId),
      receiverUid: cleanReceiverUid,
      releaseId,
      status: "sending",
      lastAttemptAt: currentTime,
      sentAt: 0,
      failedAttempts,
      lastError: "",
    });

    const languageCode =
      typeof getLanguageCode === "function"
        ? getLanguageCode(cleanReceiverUid)
        : "vi";

    const message = buildHubUpdatePushMessage({
      manifest,
      ownerUid,
      homeId,
      homeName,
      languageCode,
    });

    try {
      const result = await sendPushToUser(
        cleanReceiverUid,
        message,
        "HUB UPDATE AVAILABLE",
      );

      const sent = Math.max(0, Number(result?.sent) || 0);
      const failed = Math.max(
        0,
        Number(result?.failed) || 0,
      );

      if (sent > 0) {
        await markerRef.set({
          schemaVersion: HUB_UPDATE_PUSH_SCHEMA_VERSION,
          hubId: cleanDeviceId,
          ownerUid: cleanString(ownerUid),
          homeId: cleanString(homeId),
          receiverUid: cleanReceiverUid,
          releaseId,
          status: "sent",
          lastAttemptAt: currentTime,
          sentAt: Number(now()) || currentTime,
          failedAttempts,
          lastError: "",
        });

        return {
          status: "sent",
          sent,
        };
      }

      const lastError =
        failed > 0
          ? "push_delivery_failed"
          : "no_active_fcm_target";

      await markerRef.set({
        schemaVersion: HUB_UPDATE_PUSH_SCHEMA_VERSION,
        hubId: cleanDeviceId,
        ownerUid: cleanString(ownerUid),
        homeId: cleanString(homeId),
        receiverUid: cleanReceiverUid,
        releaseId,
        status: "pending",
        lastAttemptAt: currentTime,
        sentAt: 0,
        failedAttempts: failedAttempts + 1,
        lastError,
      });

      return {
        status: "pending",
        sent: 0,
      };
    } catch (error) {
      const lastError = cleanString(
        error?.message || error || "push_error",
      ).slice(0, 300);

      await markerRef.set({
        schemaVersion: HUB_UPDATE_PUSH_SCHEMA_VERSION,
        hubId: cleanDeviceId,
        ownerUid: cleanString(ownerUid),
        homeId: cleanString(homeId),
        receiverUid: cleanReceiverUid,
        releaseId,
        status: "pending",
        lastAttemptAt: currentTime,
        sentAt: 0,
        failedAttempts: failedAttempts + 1,
        lastError,
      });

      return {
        status: "pending",
        sent: 0,
      };
    }
  }

  async function handleReleaseCheck({
    manifest,
    updateAvailable,
  }) {
    if (updateAvailable !== true || !manifest) {
      return {
        homes: 0,
        receivers: 0,
        sent: 0,
      };
    }

    if (checkInProgress) {
      return {
        homes: 0,
        receivers: 0,
        sent: 0,
        skipped: "in_progress",
      };
    }

    checkInProgress = true;

    let homeCount = 0;
    let receiverCount = 0;
    let sentCount = 0;

    try {
      const linkedHomes = await getLinkedHomes();
      const uniqueHomes = new Map();

      for (const rawHome of linkedHomes || []) {
        const ownerUid = cleanString(rawHome?.uid);
        const homeId = cleanString(rawHome?.homeId);

        if (!ownerUid || !homeId) {
          continue;
        }

        uniqueHomes.set(`${ownerUid}|${homeId}`, {
          ownerUid,
          homeId,
        });
      }

      for (const linkedHome of uniqueHomes.values()) {
        homeCount++;

        const homeData =
          typeof getHomeData === "function"
            ? getHomeData(
                linkedHome.ownerUid,
                linkedHome.homeId,
              ) || {}
            : {};

        const homeName = cleanString(homeData?.name);
        const receiverUids = Array.from(
          new Set(
            (getReceiverUids(
              linkedHome.ownerUid,
              linkedHome.homeId,
            ) || [])
              .map(cleanString)
              .filter(Boolean),
          ),
        );

        for (const receiverUid of receiverUids) {
          receiverCount++;

          const result = await sendForReceiver({
            manifest,
            ownerUid: linkedHome.ownerUid,
            homeId: linkedHome.homeId,
            homeName,
            receiverUid,
          });

          sentCount += Math.max(
            0,
            Number(result?.sent) || 0,
          );
        }
      }

      if (sentCount > 0) {
        console.log(
          "⬆️ HUB UPDATE PUSH SENT:",
          manifest.releaseId,
          `homes=${homeCount}`,
          `receivers=${receiverCount}`,
          `devices=${sentCount}`,
        );
      }

      return {
        homes: homeCount,
        receivers: receiverCount,
        sent: sentCount,
      };
    } finally {
      checkInProgress = false;
    }
  }

  return {
    handleReleaseCheck,
  };
}

module.exports = {
  DEFAULT_HUB_UPDATE_PUSH_MARKER_ROOT,
  DEFAULT_HUB_UPDATE_PUSH_RETRY_INTERVAL_MS,
  HUB_UPDATE_PUSH_SCHEMA_VERSION,
  buildHubUpdatePushMarkerKey,
  buildHubUpdatePushMessage,
  createHubUpdatePushCoordinator,
};
