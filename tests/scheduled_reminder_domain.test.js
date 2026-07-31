"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildScheduledReminderSummary,
  createScheduledReminderDomain,
  normalizeReminderCollection,
} = require("../domains/notifications/scheduled_reminder");

function createHarness({
  accounts = {},
  sharedHomes = {},
  currentTime = "22:30",
  safety = () => ({ safe: true, unsafeDevices: [] }),
  now = () => 1_000_000,
} = {}) {
  const pushes = [];
  const notifications = [];
  const logs = [];
  const timeoutCallbacks = [];
  const intervalCallbacks = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];

  const db = {
    ref(path) {
      return {
        async once(eventName) {
          assert.equal(eventName, "value");
          return {
            val: () => sharedHomes[path] || null,
          };
        },
      };
    },
  };

  const runtime = createScheduledReminderDomain({
    db,
    getCachedAccountsObject: () => accounts,
    getCurrentHHMM: () => currentTime,
    getHomeNotificationSafety: safety,
    sendPushToUser: async (uid, message, label) => {
      pushes.push({ uid, message, label });
      return { total: 1, sent: 1, failed: 0, removed: 0 };
    },
    addHomeNotificationFromBackend: async (value) => {
      notifications.push(value);
    },
    now,
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timeoutCallbacks.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => clearedTimeouts.push(timer),
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      intervalCallbacks.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => clearedIntervals.push(timer),
    log: (...args) => logs.push(args),
  });

  return {
    runtime,
    pushes,
    notifications,
    logs,
    timeoutCallbacks,
    intervalCallbacks,
    clearedTimeouts,
    clearedIntervals,
  };
}

test("Reminder collection accepts arrays and keyed objects", () => {
  const a = { enabled: true, time: "22:30" };
  const b = { enabled: false, time: "23:00" };

  assert.deepEqual(normalizeReminderCollection([a, null, b]), [a, b]);
  assert.deepEqual(
    normalizeReminderCollection({ one: a, empty: null, two: b }),
    [a, b],
  );
  assert.deepEqual(normalizeReminderCollection(null), []);
});

test("summary deduplicates homes and keeps unsafe reasons", () => {
  const summary = buildScheduledReminderSummary([
    {
      homeId: "h1",
      homeName: "Nhà 1",
      isSafe: false,
      reason: "Cửa mở",
      text: "unsafe",
      reminderItems: [
        { homeId: "h1", homeName: "Nhà 1", reasons: ["Cửa mở"] },
      ],
    },
    {
      homeId: "h1",
      homeName: "Nhà 1",
      isSafe: false,
      reason: "Cửa mở",
      text: "duplicate",
      reminderItems: [
        { homeId: "h1", homeName: "Nhà 1", reasons: ["Cửa mở"] },
      ],
    },
    {
      homeId: "h2",
      homeName: "Nhà 2",
      isSafe: true,
      reason: "",
      text: "safe",
      reminderItems: [
        { homeId: "h2", homeName: "Nhà 2", reasons: [] },
      ],
    },
  ]);

  assert.equal(summary.uniqueItems.length, 2);
  assert.equal(summary.allSafe, false);
  assert.equal(summary.title, "Nhắc nhở MaiYen");
  assert.equal(summary.body, "1/2 nhà đang có vấn đề cần kiểm tra.");
  assert.equal(summary.reason, "Nhà 1: Cửa mở");
  assert.deepEqual(
    summary.reminderItems.map((item) => item.homeId),
    ["h1", "h2"],
  );
});

test("scheduled notification is deduplicated within the current minute", async () => {
  const harness = createHarness();
  const input = {
    uid: "u1",
    homeId: "h1",
    homeName: "Nhà 1",
    text: "Nhắc nhở",
    isSafe: true,
  };

  assert.equal(await harness.runtime.sendScheduledNotification(input), true);
  assert.equal(await harness.runtime.sendScheduledNotification(input), false);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.timeoutCallbacks.length, 1);

  await harness.timeoutCallbacks[0].callback();
  assert.equal(harness.pushes.length, 1);
  assert.equal(
    harness.pushes[0].message.data.type,
    "schedule_notification",
  );
  assert.equal(
    harness.pushes[0].message.apns.payload.aps.category,
    "SAFEHOME_REMINDER",
  );
});

test("owner Reminder uses the Home schedule at the current minute", async () => {
  const accounts = {
    u1: {
      homes: {
        h1: {
          name: "Nhà 1",
          schedules: {
            notifications: {
              bedtime: { enabled: true, time: "22:30" },
            },
          },
        },
      },
    },
  };
  const harness = createHarness({ accounts });

  await harness.runtime.checkScheduledNotifications();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].uid, "u1");
  assert.equal(harness.notifications[0].homeId, "h1");
  assert.equal(harness.notifications[0].severity, "success");
});

test("shared Reminder custom mode uses only the receiver custom items", async () => {
  const accounts = {
    member: {
      sharedHomes: {
        h1: { ownerUid: "owner" },
      },
      customRules: {
        h1: {
          reminderMode: "custom",
          notifications: {
            items: {
              personal: { enabled: true, time: "22:30" },
            },
          },
        },
      },
    },
  };
  const sharedHomes = {
    "accounts/owner/homes/h1": {
      name: "Nhà chung",
      schedules: {
        notifications: {
          ignored: { enabled: false, time: "22:30" },
        },
      },
    },
  };
  const harness = createHarness({ accounts, sharedHomes });

  await harness.runtime.checkScheduledNotifications();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].uid, "member");
  assert.equal(harness.notifications[0].homeName, "Nhà chung");
});

test("shared Reminder home mode falls back to the owner Home schedule", async () => {
  const accounts = {
    member: {
      sharedHomes: {
        h1: { ownerUid: "owner" },
      },
      customRules: {
        h1: {
          reminderMode: "home",
          notifications: {
            items: {
              ignored: { enabled: false, time: "22:30" },
            },
          },
        },
      },
    },
  };
  const sharedHomes = {
    "accounts/owner/homes/h1": {
      name: "Nhà chung",
      schedules: {
        notifications: {
          common: { enabled: true, time: "22:30" },
        },
      },
    },
  };
  const harness = createHarness({
    accounts,
    sharedHomes,
    safety: () => ({
      safe: false,
      unsafeDevices: ["Cửa chính", "Khóa cửa"],
    }),
  });

  await harness.runtime.checkScheduledNotifications();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].severity, "warning");
  assert.match(harness.notifications[0].message, /Cửa chính, Khóa cửa/);
});

test("concurrent schedule checks share one in-flight scan", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const accounts = {
    member: {
      sharedHomes: { h1: { ownerUid: "owner" } },
    },
  };
  const harness = createHarness({ accounts });
  const originalRef = harness.runtime;
  // Rebuild with a deferred Firebase read so both calls overlap.
  const deferred = createScheduledReminderDomain({
    db: {
      ref() {
        return {
          async once() {
            await gate;
            return { val: () => null };
          },
        };
      },
    },
    getCachedAccountsObject: () => accounts,
    getCurrentHHMM: () => "22:30",
    getHomeNotificationSafety: () => ({ safe: true, unsafeDevices: [] }),
    sendPushToUser: async () => ({ total: 0, sent: 0, failed: 0, removed: 0 }),
    addHomeNotificationFromBackend: async () => {},
    log: () => {},
  });

  assert.ok(originalRef);
  const first = deferred.checkScheduledNotifications();
  const second = deferred.checkScheduledNotifications();
  assert.strictEqual(first, second);
  release();
  await first;
});

test("Reminder monitor starts once and stops all timers", () => {
  const harness = createHarness();

  assert.equal(harness.runtime.startScheduledReminderMonitor(), true);
  assert.equal(harness.runtime.startScheduledReminderMonitor(), false);
  assert.equal(harness.intervalCallbacks.length, 1);

  harness.runtime.queueScheduledReminder("u1", {
    homeId: "h1",
    isSafe: true,
  });
  assert.equal(harness.timeoutCallbacks.length, 1);

  harness.runtime.stopScheduledReminderMonitor();
  assert.equal(harness.clearedIntervals.length, 1);
  assert.equal(harness.clearedTimeouts.length, 1);
});
