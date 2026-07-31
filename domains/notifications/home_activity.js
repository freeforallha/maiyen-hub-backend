"use strict";

const DEFAULT_HOME_NOTIFICATION_STORAGE_LIMIT = 120;
const DEFAULT_HOME_EVENT_STORAGE_LIMIT = 200;
const DEFAULT_REQUEST_RESULT_TTL_MS = 30 * 1000;

function createHomeActivityDomain({
  db,
  getUserLanguageCode,
  localizeBackendText,
  queueOrderedListCleanup,
  getAlarmReceiverUidsForHome,
  lastNotificationMap = {},
  getCachedAccountData,
  buildUserDirectoryData,
  incrementChatUnreadCounter,
  sendChatNotificationPush,
  homeNotificationStorageLimit = DEFAULT_HOME_NOTIFICATION_STORAGE_LIMIT,
  homeEventStorageLimit = DEFAULT_HOME_EVENT_STORAGE_LIMIT,
  resultTtlMs = DEFAULT_REQUEST_RESULT_TTL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("Home Activity requires db.ref");
  }
  if (typeof getUserLanguageCode !== "function") {
    throw new TypeError("Home Activity requires getUserLanguageCode");
  }
  if (typeof localizeBackendText !== "function") {
    throw new TypeError("Home Activity requires localizeBackendText");
  }
  if (typeof queueOrderedListCleanup !== "function") {
    throw new TypeError("Home Activity requires queueOrderedListCleanup");
  }
  if (typeof getAlarmReceiverUidsForHome !== "function") {
    throw new TypeError(
      "Home Activity requires getAlarmReceiverUidsForHome",
    );
  }
  if (typeof getCachedAccountData !== "function") {
    throw new TypeError("Home Activity requires getCachedAccountData");
  }
  if (typeof buildUserDirectoryData !== "function") {
    throw new TypeError("Home Activity requires buildUserDirectoryData");
  }
  if (typeof incrementChatUnreadCounter !== "function") {
    throw new TypeError(
      "Home Activity requires incrementChatUnreadCounter",
    );
  }
  if (typeof sendChatNotificationPush !== "function") {
    throw new TypeError("Home Activity requires sendChatNotificationPush");
  }

  const resultCleanupTimers = new Set();
  const processedChatNotificationMessages = new Set();
  let requestRef = null;
  let requestListener = null;
  let requestMonitorStarted = false;

async function addHomeNotificationFromBackend({
  uid,
  homeId,
  homeName,
  type,
  title,
  message,
  category = "home",
  severity = "info",

  eventCategory = "",
  alarmLevel = "",

  ownerUid = "",
  deviceId = "",
  actorUid = "",
  entityType = "home",
  entityId = "",
  data = {},
}) {
  try {
    if (!uid || !homeId) {
      return;
    }

    const now = Date.now();
    const resolvedHomeName =
      String(homeName || "").trim() || homeId;
    const languageCode = getUserLanguageCode(uid);
    const localizedTitle = localizeBackendText(
      languageCode,
      String(title || ""),
    );
    const localizedMessage = localizeBackendText(
      languageCode,
      String(message || ""),
    );

    const listRef = db.ref(
      `accounts/${uid}/notifications`,
    );

    const notificationRef = listRef.push();

    const notificationData = {
      ...(data && typeof data === "object" ? data : {}),
      homeName: resolvedHomeName,
    };
    const notificationPayload = {
      id: notificationRef.key,
      type,
      category,
      severity,

      // Chuẩn Alarm Engine dùng chung cho backend/Firebase/app.
      // Giữ severity cũ để tương thích với frontend hiện tại.
      eventCategory: String(eventCategory || ""),
      alarmLevel: String(alarmLevel || ""),

      title: localizedTitle,
      message: localizedMessage,
      languageCode,
      homeId,
      homeName: resolvedHomeName,
      entityType,
      entityId: entityId || homeId,
      data: notificationData,
      time: now,
      read: false,
    };

    const cleanOwnerUid = String(ownerUid || "").trim();
    const cleanDeviceId = String(deviceId || "").trim();
    const cleanActorUid = String(actorUid || "").trim();

    if (cleanOwnerUid) notificationPayload.ownerUid = cleanOwnerUid;
    if (cleanDeviceId) notificationPayload.deviceId = cleanDeviceId;
    if (cleanActorUid) notificationPayload.actorUid = cleanActorUid;

    await notificationRef.set(notificationPayload);

    queueOrderedListCleanup(
      `home_notifications:${uid}`,
      listRef,
      homeNotificationStorageLimit,
    );

    log(
      "🏠 HOME NOTIFICATION:",
      uid,
      type,
      homeId,
    );
  } catch (err) {
    log(
      "HOME NOTIFICATION ERROR:",
      err.message,
    );
  }
}
function getCachedUserDisplayName(uid) {
  const cleanUid = String(uid || "").trim();
  const account = cleanUid ? getCachedAccountData(cleanUid) : null;
  const directory = buildUserDirectoryData(account || {});

  return String(
    directory.name ||
    directory.email ||
    "Một thành viên",
  ).trim() || "Một thành viên";
}

async function addHomeNotificationToHomeRecipients({
  ownerUid,
  homeId,
  homeName,
  type,
  title,
  message,
  category = "home",
  severity = "info",
  eventCategory = "",
  alarmLevel = "",
  deviceId = "",
  actorUid = "",
  entityType = "home",
  entityId = "",
  data = {},
  recipientUids = null,
  dedupeKey = "",
  dedupeMs = 0,
}) {
  const cleanOwnerUid = String(ownerUid || "").trim();
  const cleanHomeId = String(homeId || "").trim();

  if (!cleanOwnerUid || !cleanHomeId) return;

  const receivers = Array.isArray(recipientUids)
    ? recipientUids
    : getAlarmReceiverUidsForHome(cleanOwnerUid, cleanHomeId);

  for (const rawUid of receivers) {
    const uid = String(rawUid || "").trim();
    if (!uid) continue;

    const runtimeKey = dedupeKey
      ? `home_notification:${uid}:${dedupeKey}`
      : "";
    const now = Date.now();

    if (
      runtimeKey &&
      Number(lastNotificationMap[runtimeKey] || 0) > 0 &&
      now - Number(lastNotificationMap[runtimeKey]) < Math.max(0, dedupeMs)
    ) {
      continue;
    }

    if (runtimeKey) lastNotificationMap[runtimeKey] = now;

    await addHomeNotificationFromBackend({
      uid,
      ownerUid: cleanOwnerUid,
      homeId: cleanHomeId,
      homeName,
      type,
      title,
      message,
      category,
      severity,
      eventCategory,
      alarmLevel,
      deviceId,
      actorUid,
      entityType,
      entityId: entityId || deviceId || cleanHomeId,
      data,
    });
  }
}


const homeNotificationRequestInProgress = new Set();
const lastHomeNotificationRequestMap = {};

async function processHomeNotificationRequestSnapshot(snap) {
  const req = snap.val();
  const requestId = snap.key;

  async function publishRequestResult(status, reason = "") {
    const resultUid = String(
      req?.requestedBy || "",
    ).trim();

    if (!resultUid || !requestId) {
      return;
    }

    const resultRef = db.ref(
      `accounts/${resultUid}/homeNotificationRequestResults/${requestId}`,
    );
    const result = {
      status,
      processedAt: Date.now(),
    };

    if (reason) {
      result.reason = String(reason).slice(0, 200);
    }

    try {
      await resultRef.set(result);

      const cleanupTimer = setTimeoutFn(async () => {
        resultCleanupTimers.delete(cleanupTimer);

        try {
          await resultRef.remove();
        } catch (_) {}
      }, Math.max(1, Number(resultTtlMs) || DEFAULT_REQUEST_RESULT_TTL_MS));

      cleanupTimer?.unref?.();
      resultCleanupTimers.add(cleanupTimer);
    } catch (error) {
      log(
        "HOME NOTIFICATION RESULT ERROR:",
        requestId,
        error.message,
      );
    }
  }

  async function rejectRequest(reason) {
    log(
      "❌ HOME NOTIFICATION REQUEST REJECTED:",
      requestId,
      reason,
    );

    await publishRequestResult("rejected", reason);

    try {
      await snap.ref.remove();
    } catch (_) {}
  }

  try {
    if (!req || !requestId) {
      return;
    }

    if (homeNotificationRequestInProgress.has(requestId)) {
      return;
    }

    homeNotificationRequestInProgress.add(requestId);

    const requestedBy = String(
      req.requestedBy || "",
    ).trim();

    const ownerUid = String(
      req.ownerUid || "",
    ).trim();

    const homeId = String(
      req.homeId || "",
    ).trim();

    const recipientUid = String(
      req.recipientUid || "",
    ).trim();

    const type = String(
      req.type || "",
    ).trim();

    const category = String(
      req.category || "",
    ).trim();

    const severity = String(
      req.severity || "",
    ).trim();

    const title = String(
      req.title || "",
    ).trim();

    const message = String(
      req.message || "",
    ).trim();

    const deviceId = String(
      req.deviceId || "",
    ).trim();

    const entityType = String(
      req.entityType || "",
    ).trim();

    const entityId = String(
      req.entityId || "",
    ).trim();

    const requestTime = Number(req.time);
    const now = Date.now();

    const allowedCategories = new Set([
      "home",
      "device",
      "member",
      "alarm",
      "reminder",
      "chat",
    ]);

    const allowedSeverities = new Set([
      "info",
      "success",
      "warning",
    ]);

    const requestTargetedTypes = new Set([
      "share_request",
      "join_request",
      "transfer_owner_request",
      "share_request_denied",
      "join_request_denied",
      "transfer_owner_failed",
    ]);

    const memberTargetedTypes = new Set([
      "share_request_accepted",
      "join_request_accepted",
      "member_join",
      "transfer_owner_accepted",
      "role_changed",
      "member_removed",
    ]);

    const targetedTypes = new Set([
      ...requestTargetedTypes,
      ...memberTargetedTypes,
    ]);

    const invalidRequest =
      req.status !== "pending" ||
      requestedBy.length === 0 ||
      requestedBy.length > 128 ||
      ownerUid.length === 0 ||
      ownerUid.length > 128 ||
      homeId.length === 0 ||
      homeId.length > 120 ||
      recipientUid.length > 128 ||
      type.length === 0 ||
      type.length > 80 ||
      !allowedCategories.has(category) ||
      !allowedSeverities.has(severity) ||
      title.length === 0 ||
      title.length > 160 ||
      message.length === 0 ||
      message.length > 1000 ||
      typeof req.includeActor !== "boolean" ||
      typeof req.writeHomeTimeline !== "boolean" ||
      !Number.isFinite(requestTime) ||
      requestTime > now + 1000 ||
      requestTime < now - 5 * 60 * 1000;

    if (invalidRequest) {
      await rejectRequest("INVALID DATA");
      return;
    }

    const isTargeted = recipientUid.length > 0;
    const isChatMessage =
      !isTargeted &&
      type === "chat";

    if (isTargeted && !targetedTypes.has(type)) {
      await rejectRequest("TARGET TYPE NOT ALLOWED");
      return;
    }

    if (
      isTargeted &&
      req.writeHomeTimeline !== false
    ) {
      await rejectRequest("TARGET TIMELINE NOT ALLOWED");
      return;
    }

    if (!isTargeted && targetedTypes.has(type)) {
      await rejectRequest("RECIPIENT REQUIRED");
      return;
    }

    const rateKey =
      `${requestedBy}_${homeId}_${recipientUid}_${type}`;

    const lastRequestTime =
      lastHomeNotificationRequestMap[rateKey] || 0;

    const rateLimitMillis =
      isChatMessage ? 150 : 750;

    if (
      now - lastRequestTime <
      rateLimitMillis
    ) {
      await rejectRequest("RATE LIMITED");
      return;
    }

    lastHomeNotificationRequestMap[rateKey] = now;

    const homeSnap = await db
      .ref(`accounts/${ownerUid}/homes/${homeId}`)
      .once("value");

    if (!homeSnap.exists()) {
      await rejectRequest("HOME NOT FOUND");
      return;
    }

    const home = homeSnap.val() || {};
    let role = "owner";

    if (
      isTargeted &&
      type === "join_request"
    ) {
      if (recipientUid !== ownerUid) {
        await rejectRequest("INVALID JOIN RECIPIENT");
        return;
      }

      const joinRequestSnap = await db
        .ref(
          `accounts/${ownerUid}/shareRequests/${homeId}_${requestedBy}`,
        )
        .once("value");

      const joinRequest =
        joinRequestSnap.val() || {};

      if (
        joinRequest.type !== "join_request" ||
        joinRequest.ownerUid !== ownerUid ||
        joinRequest.targetUid !== requestedBy ||
        joinRequest.homeId !== homeId
      ) {
        await rejectRequest("JOIN REQUEST NOT FOUND");
        return;
      }

      role = "requester";
    } else if (
      isTargeted &&
      type === "share_request_denied"
    ) {
      if (recipientUid !== ownerUid) {
        await rejectRequest("INVALID SHARE DENIAL RECIPIENT");
        return;
      }

      const shareRequestSnap = await db
        .ref(
          `accounts/${requestedBy}/shareRequests/${homeId}`,
        )
        .once("value");

      const shareRequest =
        shareRequestSnap.val() || {};

      if (
        shareRequest.type !== "share_request" ||
        shareRequest.ownerUid !== ownerUid ||
        shareRequest.targetUid !== requestedBy ||
        shareRequest.homeId !== homeId
      ) {
        await rejectRequest("SHARE DENIAL REQUEST NOT FOUND");
        return;
      }

      role = "invitee";
    } else if (
      isTargeted &&
      type === "transfer_owner_failed"
    ) {
      if (recipientUid !== ownerUid) {
        await rejectRequest("INVALID TRANSFER FAILURE RECIPIENT");
        return;
      }

      const transferRequestSnap = await db
        .ref(
          `accounts/${requestedBy}/shareRequests/transfer_${homeId}_${ownerUid}`,
        )
        .once("value");

      const transferRequest =
        transferRequestSnap.val() || {};

      if (
        transferRequest.type !== "transfer_owner_request" ||
        transferRequest.homeId !== homeId ||
        transferRequest.oldOwnerUid !== ownerUid ||
        transferRequest.newOwnerUid !== requestedBy
      ) {
        await rejectRequest("TRANSFER FAILURE REQUEST NOT FOUND");
        return;
      }

      role = "transfer_target";
    } else if (requestedBy !== ownerUid) {
      const [sharedHomeSnap, sharedMemberSnap] =
        await Promise.all([
          db
            .ref(
              `accounts/${requestedBy}/sharedHomes/${homeId}`,
            )
            .once("value"),

          db
            .ref(
              `sharedByHome/${homeId}/${requestedBy}`,
            )
            .once("value"),
        ]);

      const sharedHome =
        sharedHomeSnap.val() || {};

      if (
        sharedHome.ownerUid !== ownerUid ||
        !sharedMemberSnap.exists()
      ) {
        await rejectRequest("MEMBERSHIP NOT FOUND");
        return;
      }

      role = String(
        sharedHome.role || "",
      ).trim();

      if (
        role !== "admin" &&
        role !== "member"
      ) {
        await rejectRequest("INVALID ROLE");
        return;
      }
    }

    if (
      isTargeted &&
      type === "share_request"
    ) {
      if (
        role !== "owner" &&
        role !== "admin"
      ) {
        await rejectRequest("NO SHARE PERMISSION");
        return;
      }

      const shareRequestSnap = await db
        .ref(
          `accounts/${recipientUid}/shareRequests/${homeId}`,
        )
        .once("value");

      const shareRequest =
        shareRequestSnap.val() || {};

      if (
        shareRequest.type !== "share_request" ||
        shareRequest.ownerUid !== ownerUid ||
        shareRequest.targetUid !== recipientUid ||
        shareRequest.homeId !== homeId
      ) {
        await rejectRequest("SHARE REQUEST NOT FOUND");
        return;
      }
    }

    if (
      isTargeted &&
      type === "transfer_owner_request"
    ) {
      if (
        requestedBy !== ownerUid ||
        recipientUid === ownerUid
      ) {
        await rejectRequest("NO TRANSFER PERMISSION");
        return;
      }

      const transferRequestSnap = await db
        .ref(
          `accounts/${recipientUid}/shareRequests/transfer_${homeId}_${ownerUid}`,
        )
        .once("value");

      const transferRequest =
        transferRequestSnap.val() || {};

      if (
        transferRequest.type !==
          "transfer_owner_request" ||
        transferRequest.homeId !== homeId ||
        transferRequest.oldOwnerUid !== ownerUid ||
        transferRequest.newOwnerUid !== recipientUid
      ) {
        await rejectRequest(
          "TRANSFER REQUEST NOT FOUND",
        );
        return;
      }
    }

    if (
      isTargeted &&
      type === "join_request_denied"
    ) {
      if (
        recipientUid === ownerUid ||
        (role !== "owner" && role !== "admin")
      ) {
        await rejectRequest("NO JOIN DENIAL PERMISSION");
        return;
      }

      const joinRequestSnap = await db
        .ref(
          `accounts/${requestedBy}/shareRequests/${homeId}_${recipientUid}`,
        )
        .once("value");

      const joinRequest =
        joinRequestSnap.val() || {};

      if (
        joinRequest.type !== "join_request" ||
        joinRequest.ownerUid !== ownerUid ||
        joinRequest.targetUid !== recipientUid ||
        joinRequest.homeId !== homeId
      ) {
        await rejectRequest("JOIN DENIAL REQUEST NOT FOUND");
        return;
      }
    }

    if (
      isTargeted &&
      memberTargetedTypes.has(type)
    ) {
      const recipientAccountSnap = await db
        .ref(`accounts/${recipientUid}`)
        .once("value");

      if (!recipientAccountSnap.exists()) {
        await rejectRequest("RECIPIENT NOT FOUND");
        return;
      }

      let recipientIsMember =
        recipientUid === ownerUid;

      if (!recipientIsMember && type !== "member_removed") {
        const [recipientHomeSnap, recipientMemberSnap] =
          await Promise.all([
            db
              .ref(
                `accounts/${recipientUid}/sharedHomes/${homeId}`,
              )
              .once("value"),

            db
              .ref(
                `sharedByHome/${homeId}/${recipientUid}`,
              )
              .once("value"),
          ]);

        const recipientHome =
          recipientHomeSnap.val() || {};

        recipientIsMember =
          recipientHome.ownerUid === ownerUid &&
          recipientMemberSnap.exists();
      }

      if (
        !recipientIsMember &&
        type !== "member_removed"
      ) {
        await rejectRequest(
          "RECIPIENT MEMBERSHIP NOT FOUND",
        );
        return;
      }

      if (
        (
          type === "join_request_accepted" ||
          type === "member_join"
        ) &&
        role !== "owner" &&
        role !== "admin"
      ) {
        await rejectRequest("NO ACCEPT PERMISSION");
        return;
      }

      if (
        type === "role_changed" &&
        requestedBy !== ownerUid
      ) {
        await rejectRequest("ONLY OWNER CAN CHANGE ROLE");
        return;
      }

      if (
        type === "member_removed" &&
        (
          recipientUid === ownerUid ||
          (
            role !== "owner" &&
            role !== "admin"
          )
        )
      ) {
        await rejectRequest("NO REMOVE PERMISSION");
        return;
      }

      if (
        type === "transfer_owner_accepted" &&
        requestedBy !== ownerUid
      ) {
        await rejectRequest(
          "ONLY NEW OWNER CAN CONFIRM TRANSFER",
        );
        return;
      }
    }

    let verifiedChatMessage = null;
    let verifiedChatMessageId = "";

    if (isChatMessage) {
      const requestData =
        req.data &&
        typeof req.data === "object"
          ? req.data
          : {};

      verifiedChatMessageId =
        String(
          requestData.messageId ||
          entityId ||
          "",
        ).trim();

      const invalidChatRequest =
        category !== "chat" ||
        severity !== "info" ||
        deviceId.length > 0 ||
        entityType !== "chat" ||
        verifiedChatMessageId.length === 0 ||
        verifiedChatMessageId.length > 160 ||
        entityId !== verifiedChatMessageId ||
        req.includeActor !== false ||
        req.writeHomeTimeline !== false;

      if (invalidChatRequest) {
        await rejectRequest(
          "INVALID CHAT REQUEST",
        );
        return;
      }

      const dedupeKey =
        `${homeId}_${verifiedChatMessageId}`;

      if (
        processedChatNotificationMessages.has(
          dedupeKey,
        )
      ) {
        await snap.ref.remove();
        return;
      }

      const chatMessageSnap = await db
        .ref(
          `homeChats/${homeId}/messages/${verifiedChatMessageId}`,
        )
        .once("value");

      if (!chatMessageSnap.exists()) {
        await rejectRequest(
          "CHAT MESSAGE NOT FOUND",
        );
        return;
      }

      verifiedChatMessage =
        chatMessageSnap.val() || {};

      const chatSenderUid =
        String(
          verifiedChatMessage.uid || "",
        ).trim();

      const chatText =
        String(
          verifiedChatMessage.text || "",
        ).trim();

      const chatTime =
        Number(verifiedChatMessage.time);

      if (
        chatSenderUid !== requestedBy ||
        chatText.length === 0 ||
        chatText.length > 1000 ||
        !Number.isFinite(chatTime) ||
        chatTime > now + 1000 ||
        chatTime < now - 5 * 60 * 1000
      ) {
        await rejectRequest(
          "INVALID CHAT MESSAGE",
        );
        return;
      }

      processedChatNotificationMessages.add(
        dedupeKey,
      );

      if (
        processedChatNotificationMessages.size >
        2000
      ) {
        const oldestKey =
          processedChatNotificationMessages
            .values()
            .next()
            .value;

        if (oldestKey) {
          processedChatNotificationMessages.delete(
            oldestKey,
          );
        }
      }
    }

    const isMemberLeave =
      !isTargeted &&
      role === "member" &&
      type === "member_leave";

    if (
      !isTargeted &&
      role === "member" &&
      !isMemberLeave &&
      !isChatMessage
    ) {
      await rejectRequest("MEMBER TYPE NOT ALLOWED");
      return;
    }

    if (
      isMemberLeave &&
      (
        category !== "member" ||
        severity !== "warning" ||
        entityType !== "member" ||
        entityId !== requestedBy ||
        req.includeActor !== false
      )
    ) {
      await rejectRequest("INVALID MEMBER LEAVE");
      return;
    }

    if (
      !isTargeted &&
      category === "device"
    ) {
      const allowsNoDeviceId =
        type === "pair_started";

      if (allowsNoDeviceId) {
        if (
          deviceId.length > 0 ||
          entityType === "device"
        ) {
          await rejectRequest(
            "INVALID DEVICE TARGET",
          );
          return;
        }
      } else if (
        deviceId.length === 0 ||
        !homeSnap
          .child("devices")
          .child(deviceId)
          .exists()
      ) {
        await rejectRequest("DEVICE NOT FOUND");
        return;
      }
    }

    if (
      entityType.length > 0 &&
      entityType !== "home" &&
      entityType !== "device" &&
      entityType !== "member" &&
      entityType !== "chat"
    ) {
      await rejectRequest("INVALID ENTITY TYPE");
      return;
    }

    if (
      !isTargeted &&
      entityType === "device" &&
      (
        deviceId.length === 0 ||
        entityId !== deviceId
      )
    ) {
      await rejectRequest("INVALID DEVICE ENTITY");
      return;
    }

    const actorSnap = await db
      .ref(`accounts/${requestedBy}`)
      .once("value");

    const actor = actorSnap.val() || {};
    const actorProfile = actor.profile || {};

    const actorName =
      String(
        actorProfile.name ||
        actor.name ||
        actor.email ||
        "Một thành viên",
      ).trim() || "Một thành viên";

    const homeName =
      String(home.name || "").trim() || homeId;

    const requestDataForDisplay =
      req.data && typeof req.data === "object"
        ? req.data
        : {};

    let finalType = type;
    let finalCategory = category;
    let finalSeverity = severity;
    let finalTitle = title;
    let finalMessage = message;
    let finalEntityType =
      entityType || (deviceId ? "device" : "home");
    let finalEntityId =
      entityId || deviceId || homeId;

    if (isMemberLeave) {
      finalCategory = "member";
      finalSeverity = "warning";
      finalTitle = "Thành viên rời nhà";
      finalMessage =
        `${actorName} đã rời khỏi nhà "${homeName}".`;
      finalEntityType = "member";
      finalEntityId = requestedBy;
    }

    if (
      isTargeted &&
      type === "share_request"
    ) {
      finalCategory = "member";
      finalSeverity = "info";
      finalTitle = "Lời mời chia sẻ nhà";
      finalMessage =
        `${actorName} đã mời bạn tham gia nhà "${homeName}".`;
      finalEntityType = "home";
      finalEntityId = homeId;
    }

    if (
      isTargeted &&
      type === "join_request"
    ) {
      finalCategory = "member";
      finalSeverity = "info";
      finalTitle = "Yêu cầu gia nhập nhà";
      finalMessage =
        `${actorName} đang xin gia nhập nhà "${homeName}".`;
      finalEntityType = "member";
      finalEntityId = requestedBy;
    }

    if (
      isTargeted &&
      type === "transfer_owner_request"
    ) {
      finalCategory = "member";
      finalSeverity = "info";
      finalTitle = "Yêu cầu chuyển quyền chủ nhà";
      finalMessage =
        `${actorName} muốn chuyển quyền chủ nhà "${homeName}" cho bạn.`;
      finalEntityType = "home";
      finalEntityId = homeId;
    }

    if (
      isTargeted &&
      type === "share_request_accepted"
    ) {
      finalCategory = "member";
      finalSeverity = "success";
      finalTitle = "Lời mời chia sẻ nhà";
      finalMessage =
        `${actorName} đã chấp nhận lời mời tham gia nhà "${homeName}".`;
      finalEntityType = "member";
      finalEntityId = requestedBy;
    }

    if (
      isTargeted &&
      type === "share_request_denied"
    ) {
      finalCategory = "member";
      finalSeverity = "warning";
      finalTitle = "Lời mời chia sẻ nhà";
      finalMessage =
        `${actorName} đã từ chối lời mời tham gia nhà "${homeName}".`;
      finalEntityType = "member";
      finalEntityId = requestedBy;
    }

    if (
      isTargeted &&
      type === "join_request_accepted"
    ) {
      finalCategory = "member";
      finalSeverity = "success";
      finalTitle = "Yêu cầu gia nhập nhà";
      finalMessage =
        `Yêu cầu gia nhập nhà "${homeName}" đã được chấp nhận.`;
      finalEntityType = "member";
      finalEntityId = recipientUid;
    }

    if (
      isTargeted &&
      type === "join_request_denied"
    ) {
      finalCategory = "member";
      finalSeverity = "warning";
      finalTitle = "Yêu cầu gia nhập nhà";
      finalMessage =
        `Yêu cầu gia nhập nhà "${homeName}" đã bị từ chối.`;
      finalEntityType = "member";
      finalEntityId = recipientUid;
    }

    if (
      isTargeted &&
      type === "member_removed"
    ) {
      const removedMemberName = String(
        requestDataForDisplay.memberName ||
        requestDataForDisplay.targetName ||
        "thành viên",
      ).trim() || "thành viên";

      finalCategory = "member";
      finalSeverity = "warning";
      finalTitle = "Đã xoá thành viên";
      finalMessage =
        `${actorName} đã xoá ${removedMemberName} khỏi nhà "${homeName}".`;
      finalEntityType = "member";
      finalEntityId = recipientUid;
    }

    if (
      isTargeted &&
      type === "transfer_owner_failed"
    ) {
      finalCategory = "member";
      finalSeverity = "warning";
      finalTitle = "Yêu cầu chuyển quyền chủ nhà";
      finalMessage =
        `Yêu cầu chuyển quyền chủ nhà "${homeName}" không được hoàn tất.`;
      finalEntityType = "home";
      finalEntityId = homeId;
    }

    if (
      isChatMessage &&
      verifiedChatMessage
    ) {
      const verifiedText =
        String(
          verifiedChatMessage.text || "",
        ).trim();

      finalType = "chat";
      finalCategory = "chat";
      finalSeverity = "info";
      finalTitle = homeName;
      finalMessage =
        `${actorName}: ${verifiedText}`;
      finalEntityType = "chat";
      finalEntityId =
        verifiedChatMessageId;
    }

    const recipientUids = new Set();

    if (isTargeted) {
      recipientUids.add(recipientUid);
    } else {
      recipientUids.add(ownerUid);

      const sharedSnap = await db
        .ref(`sharedByHome/${homeId}`)
        .once("value");

      const sharedUsers =
        sharedSnap.val() || {};

      for (const sharedUid of Object.keys(sharedUsers)) {
        const membershipSnap = await db
          .ref(
            `accounts/${sharedUid}/sharedHomes/${homeId}`,
          )
          .once("value");

        const membership =
          membershipSnap.val() || {};

        if (membership.ownerUid === ownerUid) {
          recipientUids.add(sharedUid);
        }
      }

      if (
        isMemberLeave ||
        req.includeActor !== true
      ) {
        recipientUids.delete(requestedBy);
      }
    }

    for (const targetUid of recipientUids) {
      if (
        isChatMessage &&
        verifiedChatMessage
      ) {
        const unreadCount =
          await incrementChatUnreadCounter({
            receiverUid: targetUid,
            homeId,
            messageId: verifiedChatMessageId,
            messageTime: Number(
              verifiedChatMessage.time || 0,
            ),
          });

        await sendChatNotificationPush({
          receiverUid: targetUid,
          ownerUid,
          homeId,
          homeName,
          senderUid: requestedBy,
          senderName: actorName,
          messageId:
            verifiedChatMessageId,
          text:
            String(
              verifiedChatMessage.text || "",
            ).trim(),
          unreadCount,
        });

        continue;
      }

      const requestNotificationData =
        req.data && typeof req.data === "object"
          ? req.data
          : {};

      await addHomeNotificationFromBackend({
        uid: targetUid,
        ownerUid,
        homeId,
        homeName,
        type: finalType,
        category: finalCategory,
        severity: finalSeverity,
        title: finalTitle,
        message: finalMessage,
        deviceId,
        actorUid: requestedBy,
        entityType: finalEntityType,
        entityId: finalEntityId,
        data: {
          ...requestNotificationData,
          actorName,
          requestedBy,
        },
      });
    }

    if (
      !isTargeted &&
      !isChatMessage &&
      req.writeHomeTimeline === true
    ) {
      const eventsRef = db.ref(
        `accounts/${ownerUid}/homes/${homeId}/events`,
      );

      const eventRef = eventsRef.push();

      await eventRef.set({
        time: Date.now(),
        text: finalMessage,
        type: finalType,
        senderUid: requestedBy,
        senderName: actorName,
        senderRole: role,
        deviceId: deviceId || "",
        deviceName:
          deviceId &&
          home.devices &&
          home.devices[deviceId]
            ? String(
                home.devices[deviceId].name ||
                deviceId,
              )
            : "",
      });

      queueOrderedListCleanup(
        `home_events:${ownerUid}:${homeId}`,
        eventsRef,
        homeEventStorageLimit,
      );
    }

    await publishRequestResult("completed");
    await snap.ref.remove();

    log(
      "✅ HOME NOTIFICATION REQUEST APPLIED:",
      requestId,
      requestedBy,
      role,
      finalType,
      recipientUids.size,
    );
  } catch (err) {
    log(
      "HOME NOTIFICATION REQUEST ERROR:",
      requestId,
      err.message,
    );

    await publishRequestResult(
      "failed",
      err.message || "UNKNOWN ERROR",
    );

    try {
      await snap.ref.remove();
    } catch (_) {}
  } finally {
    if (requestId) {
      homeNotificationRequestInProgress.delete(
        requestId,
      );
    }
  }
}

  function startHomeActivityMonitor() {
    if (requestMonitorStarted) {
      return false;
    }

    requestRef = db.ref("home_notification_requests");
    requestListener = (snap) => {
      void processHomeNotificationRequestSnapshot(snap);
    };
    requestRef.on("child_added", requestListener);
    requestMonitorStarted = true;

    log("🏠 HOME ACTIVITY MONITOR STARTED");
    return true;
  }

  function stopHomeActivityMonitor() {
    if (requestMonitorStarted && requestRef && requestListener) {
      requestRef.off?.("child_added", requestListener);
    }

    requestMonitorStarted = false;
    requestRef = null;
    requestListener = null;

    for (const timer of resultCleanupTimers) {
      clearTimeoutFn(timer);
    }

    resultCleanupTimers.clear();
    homeNotificationRequestInProgress.clear();
    processedChatNotificationMessages.clear();
  }

  return {
    addHomeNotificationFromBackend,
    addHomeNotificationToHomeRecipients,
    getCachedUserDisplayName,
    processHomeNotificationRequestSnapshot,
    startHomeActivityMonitor,
    stopHomeActivityMonitor,
  };
}

module.exports = {
  DEFAULT_HOME_NOTIFICATION_STORAGE_LIMIT,
  DEFAULT_HOME_EVENT_STORAGE_LIMIT,
  DEFAULT_REQUEST_RESULT_TTL_MS,
  createHomeActivityDomain,
};
