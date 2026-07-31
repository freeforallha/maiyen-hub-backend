"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChatPushContent,
  createChatDeliveryDomain,
  normalizeChatMessage,
} = require("../domains/notifications/chat_delivery");

function createHarness({ marker = {}, chats = {}, accounts = {}, shared = {} } = {}) {
  const rootUpdates = [];
  const pushes = [];
  const counters = new Map();
  let homeChatReads = 0;

  const db = {
    ref(path = "") {
      return {
        async once() {
          if (path === "system/migrations/chatUnreadCounterV1") {
            return { val: () => marker };
          }
          if (path === "homeChats") {
            homeChatReads += 1;
            return { val: () => chats };
          }
          return { val: () => null };
        },
        async update(value) {
          rootUpdates.push(value);
        },
        async transaction(handler) {
          const current = counters.get(path) || null;
          const next = handler(current);
          counters.set(path, next);
          return {
            committed: true,
            snapshot: { val: () => next },
          };
        },
      };
    },
  };

  const domain = createChatDeliveryDomain({
    db,
    getCachedAccountsObject: () => accounts,
    getCachedSharedByHomeObject: () => shared,
    sendPushToUser: async (...args) => {
      pushes.push(args);
      return { sent: 1, failed: 0 };
    },
    log: () => {},
  });

  return {
    counters,
    domain,
    get homeChatReads() {
      return homeChatReads;
    },
    pushes,
    rootUpdates,
  };
}

test("chat message normalization rejects invalid timestamps", () => {
  assert.deepEqual(normalizeChatMessage("m1", { uid: " u1 ", time: 20 }), {
    messageId: "m1",
    senderUid: "u1",
    time: 20,
  });
  assert.equal(normalizeChatMessage("m2", { uid: "u1", time: -1 }).time, 0);
});

test("chat push content keeps stable title and fallback names", () => {
  assert.deepEqual(
    buildChatPushContent({ unreadCount: 2, text: "Xin chào" }),
    {
      title: "HomeChat · 2 tin nhắn mới",
      body: "Một thành viên: Xin chào",
      homeName: "HomeChat",
      senderName: "Một thành viên",
      unreadCount: 2,
    },
  );
});

test("completed migration marker skips Home Chat scan", async () => {
  const harness = createHarness({ marker: { completed: true } });
  const result = await harness.domain.migrateLegacyChatUnreadCounters();
  assert.equal(result.skipped, true);
  assert.equal(harness.homeChatReads, 0);
  assert.equal(harness.rootUpdates.length, 0);
});

test("migration writes deterministic unread counters for Owner and members", async () => {
  const harness = createHarness({
    accounts: { owner: { homes: { h1: {} } } },
    shared: { h1: { member: {} } },
    chats: {
      h1: {
        lastRead: { owner: 10, member: 0 },
        messages: {
          m1: { uid: "owner", time: 20 },
          m2: { uid: "member", time: 30 },
        },
      },
    },
  });

  const result = await harness.domain.migrateLegacyChatUnreadCounters();
  const updates = harness.rootUpdates[0];

  assert.deepEqual(result, {
    skipped: false,
    migratedHomes: 1,
    migratedCounters: 2,
  });
  assert.equal(updates["accounts/owner/chatUnread/h1"].count, 1);
  assert.equal(updates["accounts/member/chatUnread/h1"].count, 1);
  assert.equal(updates["system/migrations/chatUnreadCounterV1"].completed, true);
});

test("concurrent migration calls share one in-flight scan", async () => {
  const harness = createHarness();
  await Promise.all([
    harness.domain.ensureChatUnreadCounterMigration(),
    harness.domain.ensureChatUnreadCounterMigration(),
  ]);
  assert.equal(harness.homeChatReads, 1);
});

test("unread increment is idempotent and respects migrated boundary", async () => {
  const harness = createHarness({ marker: { completed: true } });
  const path = "accounts/u1/chatUnread/h1";
  harness.counters.set(path, {
    count: 2,
    lastReadAt: 10,
    migratedThroughAt: 20,
    lastIncrementedMessageId: "",
  });

  assert.equal(
    await harness.domain.incrementChatUnreadCounter({
      receiverUid: "u1",
      homeId: "h1",
      messageId: "m1",
      messageTime: 30,
    }),
    3,
  );
  assert.equal(
    await harness.domain.incrementChatUnreadCounter({
      receiverUid: "u1",
      homeId: "h1",
      messageId: "m1",
      messageTime: 30,
    }),
    0,
  );
});

test("chat push uses high priority, badge and Home thread identity", async () => {
  const harness = createHarness();
  const result = await harness.domain.sendChatNotificationPush({
    receiverUid: "u2",
    ownerUid: "u1",
    homeId: "h1",
    homeName: "Nhà kho",
    senderUid: "u1",
    senderName: "Mai",
    messageId: "m1",
    text: "Đã đóng cửa",
    unreadCount: 3,
  });

  const [uid, payload, label] = harness.pushes[0];
  assert.equal(result.sent, 1);
  assert.equal(uid, "u2");
  assert.equal(label, "CHAT");
  assert.equal(payload.android.priority, "high");
  assert.equal(payload.apns.payload.aps.badge, 3);
  assert.equal(payload.apns.payload.aps.threadId, "home_chat_h1");
  assert.equal(payload.data.unreadCount, "3");
});

test("zero unread count skips push delivery", async () => {
  const harness = createHarness();
  const result = await harness.domain.sendChatNotificationPush({
    receiverUid: "u2",
    unreadCount: 0,
  });
  assert.equal(result.skipped, true);
  assert.equal(harness.pushes.length, 0);
});
