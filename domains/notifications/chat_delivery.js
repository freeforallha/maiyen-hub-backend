"use strict";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeChatMessage(messageId, rawMessage) {
  const message = asObject(rawMessage);
  const time = Number(message.time || 0);

  return {
    messageId: String(messageId || "").trim(),
    senderUid: String(message.uid || "").trim(),
    time: Number.isFinite(time) && time > 0 ? time : 0,
  };
}

function buildChatPushContent({
  homeName,
  senderName,
  text,
  unreadCount,
} = {}) {
  const cleanHomeName = String(homeName || "").trim() || "HomeChat";
  const cleanSenderName =
    String(senderName || "").trim() || "Một thành viên";
  const cleanText = String(text || "").trim();
  const normalizedUnreadCount = Math.max(
    0,
    Math.floor(Number(unreadCount || 0)),
  );

  return {
    title:
      normalizedUnreadCount > 1
        ? `${cleanHomeName} · ${normalizedUnreadCount} tin nhắn mới`
        : cleanHomeName,
    body: `${cleanSenderName}: ${cleanText}`,
    homeName: cleanHomeName,
    senderName: cleanSenderName,
    unreadCount: normalizedUnreadCount,
  };
}

function createChatDeliveryDomain({
  db,
  getCachedAccountsObject,
  getCachedSharedByHomeObject,
  sendPushToUser,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("Chat Delivery requires db.ref");
  }
  if (typeof getCachedAccountsObject !== "function") {
    throw new TypeError("Chat Delivery requires getCachedAccountsObject");
  }
  if (typeof getCachedSharedByHomeObject !== "function") {
    throw new TypeError(
      "Chat Delivery requires getCachedSharedByHomeObject",
    );
  }
  if (typeof sendPushToUser !== "function") {
    throw new TypeError("Chat Delivery requires sendPushToUser");
  }

  let migrationPromise = null;

  async function migrateLegacyChatUnreadCounters() {
    const markerRef = db.ref("system/migrations/chatUnreadCounterV1");
    const markerSnapshot = await markerRef.once("value");
    const marker = asObject(markerSnapshot.val());

    if (marker.completed === true) {
      return {
        skipped: true,
        migratedHomes: 0,
        migratedCounters: 0,
      };
    }

    const chatsSnapshot = await db.ref("homeChats").once("value");
    const accounts = asObject(getCachedAccountsObject());
    const chats = asObject(chatsSnapshot.val());
    const sharedByHome = asObject(getCachedSharedByHomeObject());
    const homeOwners = new Map();

    for (const [ownerUid, rawAccount] of Object.entries(accounts)) {
      for (const homeId of Object.keys(asObject(asObject(rawAccount).homes))) {
        homeOwners.set(homeId, ownerUid);
      }
    }

    const updates = {};
    const now = Date.now();
    let migratedHomes = 0;
    let migratedCounters = 0;

    for (const [homeId, rawChat] of Object.entries(chats)) {
      const ownerUid = String(homeOwners.get(homeId) || "").trim();

      if (!ownerUid) {
        continue;
      }

      const chat = asObject(rawChat);
      const lastReadMap = asObject(chat.lastRead);
      const messages = Object.entries(asObject(chat.messages))
        .map(([messageId, rawMessage]) => {
          return normalizeChatMessage(messageId, rawMessage);
        })
        .filter((message) => {
          return message.messageId && message.senderUid && message.time > 0;
        });

      const migratedThroughAt = messages.reduce(
        (latest, message) => Math.max(latest, message.time),
        0,
      );
      const recipients = new Set([ownerUid]);

      for (const sharedUid of Object.keys(
        asObject(sharedByHome[homeId]),
      )) {
        const cleanUid = String(sharedUid || "").trim();
        if (cleanUid) recipients.add(cleanUid);
      }

      for (const receiverUid of recipients) {
        const lastReadAt = Number(lastReadMap[receiverUid] || 0);
        let count = 0;
        let lastMessageAt = 0;
        let lastMessageId = "";

        for (const message of messages) {
          if (
            message.senderUid === receiverUid ||
            message.time <= lastReadAt
          ) {
            continue;
          }

          count += 1;

          if (message.time >= lastMessageAt) {
            lastMessageAt = message.time;
            lastMessageId = message.messageId;
          }
        }

        updates[`accounts/${receiverUid}/chatUnread/${homeId}`] = {
          count,
          lastReadAt:
            Number.isFinite(lastReadAt) && lastReadAt > 0 ? lastReadAt : 0,
          lastMessageAt,
          lastMessageId,
          lastIncrementedMessageId: "",
          migratedThroughAt,
          updatedAt: now,
        };

        migratedCounters += 1;
      }

      migratedHomes += 1;
    }

    updates["system/migrations/chatUnreadCounterV1"] = {
      completed: true,
      completedAt: now,
      migratedHomes,
      migratedCounters,
    };

    await db.ref().update(updates);

    log(
      "💬 CHAT UNREAD MIGRATION COMPLETED:",
      `homes=${migratedHomes}`,
      `counters=${migratedCounters}`,
    );

    return { skipped: false, migratedHomes, migratedCounters };
  }

  function ensureChatUnreadCounterMigration() {
    if (!migrationPromise) {
      migrationPromise = migrateLegacyChatUnreadCounters().catch((error) => {
        migrationPromise = null;
        log("CHAT UNREAD MIGRATION ERROR:", error.message);
        throw error;
      });
    }

    return migrationPromise;
  }

  async function incrementChatUnreadCounter({
    receiverUid,
    homeId,
    messageId,
    messageTime,
  } = {}) {
    await ensureChatUnreadCounterMigration();

    const cleanReceiverUid = String(receiverUid || "").trim();
    const cleanHomeId = String(homeId || "").trim();
    const cleanMessageId = String(messageId || "").trim();
    const normalizedMessageTime = Number(messageTime || 0);

    if (
      !cleanReceiverUid ||
      !cleanHomeId ||
      !cleanMessageId ||
      !Number.isFinite(normalizedMessageTime) ||
      normalizedMessageTime <= 0
    ) {
      return 0;
    }

    const counterRef = db.ref(
      `accounts/${cleanReceiverUid}/chatUnread/${cleanHomeId}`,
    );
    let incremented = false;

    const result = await counterRef.transaction((rawCurrent) => {
      incremented = false;
      const current = asObject(rawCurrent);
      const currentCount = Number(
        typeof rawCurrent === "number" ? rawCurrent : current.count || 0,
      );
      const lastReadAt = Number(current.lastReadAt || 0);
      const migratedThroughAt = Number(current.migratedThroughAt || 0);
      const lastIncrementedMessageId = String(
        current.lastIncrementedMessageId || "",
      );

      if (
        cleanMessageId === lastIncrementedMessageId ||
        normalizedMessageTime <= lastReadAt ||
        normalizedMessageTime <= migratedThroughAt
      ) {
        return current;
      }

      incremented = true;

      return {
        ...current,
        count: Math.min(
          9999,
          Number.isFinite(currentCount) && currentCount > 0
            ? Math.floor(currentCount) + 1
            : 1,
        ),
        lastMessageAt: Math.max(
          Number(current.lastMessageAt || 0),
          normalizedMessageTime,
        ),
        lastMessageId: cleanMessageId,
        lastIncrementedMessageId: cleanMessageId,
        updatedAt: Date.now(),
      };
    });

    if (!result.committed || !incremented) {
      return 0;
    }

    const count = Number(asObject(result.snapshot.val()).count || 0);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  async function sendChatNotificationPush({
    receiverUid,
    ownerUid,
    homeId,
    homeName,
    senderUid,
    senderName,
    messageId,
    text,
    unreadCount,
  } = {}) {
    const content = buildChatPushContent({
      homeName,
      senderName,
      text,
      unreadCount,
    });

    if (content.unreadCount <= 0) {
      return { sent: 0, failed: 0, skipped: true };
    }

    const data = {
      type: "chat",
      title: content.title,
      body: content.body,
      ownerUid: String(ownerUid || ""),
      homeId: String(homeId || ""),
      homeName: content.homeName,
      senderUid: String(senderUid || ""),
      senderName: content.senderName,
      messageId: String(messageId || ""),
      unreadCount: String(content.unreadCount),
      clickAction: "home_chat",
    };

    const pushResult = await sendPushToUser(
      receiverUid,
      {
        data,
        android: { priority: "high" },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              alert: { title: content.title, body: content.body },
              sound: "default",
              badge: content.unreadCount,
              threadId: `home_chat_${homeId}`,
            },
          },
        },
      },
      "CHAT",
    );

    if (pushResult.sent > 0) {
      log(
        "💬 CHAT PUSH SENT:",
        receiverUid,
        homeId,
        content.unreadCount,
        `devices=${pushResult.sent}`,
      );
    }

    return pushResult;
  }

  function stopChatDeliveryRuntime() {
    migrationPromise = null;
    return true;
  }

  return {
    ensureChatUnreadCounterMigration,
    incrementChatUnreadCounter,
    migrateLegacyChatUnreadCounters,
    sendChatNotificationPush,
    stopChatDeliveryRuntime,
  };
}

module.exports = {
  buildChatPushContent,
  createChatDeliveryDomain,
  normalizeChatMessage,
};
