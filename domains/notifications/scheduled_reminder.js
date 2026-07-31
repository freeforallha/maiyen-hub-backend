"use strict";

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_SUMMARY_DELAY_MS = 8 * 1000;
const DEFAULT_DEDUPE_WINDOW_MS = 70 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeReminderCollection(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  return Object.values(asObject(value)).filter(Boolean);
}

function dedupeScheduledReminderItems(items) {
  const uniqueItems = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;

    const exists = uniqueItems.some((oldItem) => {
      return (
        oldItem.homeId === item.homeId &&
        oldItem.isSafe === item.isSafe &&
        oldItem.reason === item.reason
      );
    });

    if (!exists) {
      uniqueItems.push(item);
    }
  }

  return uniqueItems;
}

function buildScheduledReminderSummary(items) {
  const uniqueItems = dedupeScheduledReminderItems(items);
  const allSafe =
    uniqueItems.length > 0 &&
    uniqueItems.every((item) => item.isSafe === true);
  const unsafeItems = uniqueItems.filter(
    (item) => item.isSafe !== true,
  );
  const reminderItems = [];

  for (const item of uniqueItems) {
    const rawItems = Array.isArray(item.reminderItems)
      ? item.reminderItems
      : [];

    for (const reminderItem of rawItems) {
      if (!reminderItem) continue;

      const exists = reminderItems.some((oldItem) => {
        return oldItem.homeId === reminderItem.homeId;
      });

      if (!exists) {
        reminderItems.push(reminderItem);
      }
    }
  }

  const title =
    uniqueItems.length === 1
      ? uniqueItems[0].homeName || "Nhà"
      : "Nhắc nhở MaiYen";

  let body = "";

  if (uniqueItems.length === 1) {
    body = uniqueItems[0].text || "";
  } else if (allSafe) {
    body =
      `${uniqueItems.length} nhà đã an toàn. ` +
      "Hãy an tâm nghỉ ngơi.";
  } else if (uniqueItems.length > 0) {
    body =
      `${unsafeItems.length}/${uniqueItems.length} nhà ` +
      "đang có vấn đề cần kiểm tra.";
  }

  const reason = unsafeItems
    .map((item) => {
      const homeName = item.homeName || "Nhà";
      const detail = item.reason || "Có vấn đề cần kiểm tra";

      return `${homeName}: ${detail}`;
    })
    .join("\n");

  return {
    uniqueItems,
    allSafe,
    unsafeItems,
    reminderItems,
    title,
    body,
    reason,
  };
}

function createScheduledReminderDomain({
  db,
  getCachedAccountsObject,
  getCurrentHHMM,
  getHomeNotificationSafety,
  sendPushToUser,
  addHomeNotificationFromBackend,
  debugEnabled = false,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  summaryDelayMs = DEFAULT_SUMMARY_DELAY_MS,
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new TypeError("Scheduled Reminder requires db.ref");
  }
  if (typeof getCachedAccountsObject !== "function") {
    throw new TypeError(
      "Scheduled Reminder requires getCachedAccountsObject",
    );
  }
  if (typeof getCurrentHHMM !== "function") {
    throw new TypeError("Scheduled Reminder requires getCurrentHHMM");
  }
  if (typeof getHomeNotificationSafety !== "function") {
    throw new TypeError(
      "Scheduled Reminder requires getHomeNotificationSafety",
    );
  }
  if (typeof sendPushToUser !== "function") {
    throw new TypeError("Scheduled Reminder requires sendPushToUser");
  }
  if (typeof addHomeNotificationFromBackend !== "function") {
    throw new TypeError(
      "Scheduled Reminder requires addHomeNotificationFromBackend",
    );
  }

  const pendingByUid = new Map();
  const pendingTimerByUid = new Map();
  const lastNotificationByKey = new Map();
  let monitorTimer = null;
  let checkInFlight = null;

  async function sendScheduledReminderSummary(uid, items) {
    try {
      const summary = buildScheduledReminderSummary(items);

      if (summary.uniqueItems.length === 0) {
        return {
          total: 0,
          sent: 0,
          failed: 0,
          removed: 0,
        };
      }

      const pushResult = await sendPushToUser(
        uid,
        {
          data: {
            type: "schedule_notification",
            title: summary.title,
            body: summary.body,
            homeId:
              summary.uniqueItems.length === 1
                ? summary.uniqueItems[0].homeId || ""
                : "",
            uid: uid || "",
            isSafe: summary.allSafe ? "true" : "false",
            reason: summary.reason,
            reminderItems: JSON.stringify(summary.reminderItems),
            clickAction: "schedule_SCREEN",
          },
          android: {
            priority: "high",
          },
          apns: {
            headers: {
              "apns-priority": "10",
            },
            payload: {
              aps: {
                alert: {
                  title: summary.title,
                  body: summary.body,
                },
                sound: "default",
                // Legacy app identifiers remain stable for installed clients.
                category: "SAFEHOME_REMINDER",
                "thread-id": "safehome_reminder",
              },
            },
          },
        },
        "SCHEDULE SUMMARY",
      );

      if (pushResult.sent > 0) {
        log(
          "🔔 SCHEDULE SUMMARY SENT:",
          uid,
          summary.uniqueItems.length,
          `devices=${pushResult.sent}`,
        );
      }

      return pushResult;
    } catch (error) {
      log("SCHEDULE SUMMARY ERROR:", error.message);
      return {
        total: 0,
        sent: 0,
        failed: 1,
        removed: 0,
      };
    }
  }

  function queueScheduledReminder(uid, item) {
    const receiverUid = String(uid || "").trim();

    if (!receiverUid || !item) {
      return false;
    }

    const pending = pendingByUid.get(receiverUid) || [];
    pending.push(item);
    pendingByUid.set(receiverUid, pending);

    if (pendingTimerByUid.has(receiverUid)) {
      return false;
    }

    const timer = setTimeoutFn(async () => {
      const items = pendingByUid.get(receiverUid) || [];
      pendingByUid.delete(receiverUid);
      pendingTimerByUid.delete(receiverUid);
      await sendScheduledReminderSummary(receiverUid, items);
    }, Math.max(0, Number(summaryDelayMs) || 0));

    timer?.unref?.();
    pendingTimerByUid.set(receiverUid, timer);
    return true;
  }

  async function sendScheduledNotification({
    uid,
    homeId,
    homeName,
    text,
    isSafe,
    reason = "",
    reminderItems = [],
  }) {
    try {
      const receiverUid = String(uid || "").trim();
      const safeHomeId = String(homeId || "").trim();
      const current = getCurrentHHMM();
      const key = `${receiverUid}_${safeHomeId}_${text}_${current}`;
      const currentTimestamp = Number(now()) || Date.now();
      const previous = Number(lastNotificationByKey.get(key) || 0);

      if (
        previous > 0 &&
        currentTimestamp - previous <
          Math.max(0, Number(dedupeWindowMs) || 0)
      ) {
        return false;
      }

      lastNotificationByKey.set(key, currentTimestamp);

      await addHomeNotificationFromBackend({
        uid: receiverUid,
        homeId: safeHomeId,
        homeName,
        type: "reminder_triggered",
        category: "reminder",
        severity: isSafe ? "success" : "warning",
        title: isSafe
          ? "Nhắc nhở: Nhà đã an toàn"
          : "Nhắc nhở: Cần kiểm tra",
        message: isSafe
          ? "Nhà đang an toàn. Hãy an tâm nghỉ ngơi."
          : `Cần kiểm tra: ${
              reason || "Nhà đang có vấn đề cần chú ý."
            }`,
        entityType: "home",
        entityId: safeHomeId,
      });

      queueScheduledReminder(receiverUid, {
        homeId: safeHomeId,
        homeName,
        text,
        isSafe,
        reason,
        reminderItems,
      });

      return true;
    } catch (error) {
      log("NOTIFICATION SEND ERROR:", error.message);
      return false;
    }
  }

  async function collectHomesToCheck(uid, user) {
    const ownHomes = asObject(user?.homes);
    const sharedHomes = asObject(user?.sharedHomes);
    const homesToCheck = [];

    for (const [homeId, home] of Object.entries(ownHomes)) {
      homesToCheck.push({
        receiverUid: uid,
        ownerUid: uid,
        homeId,
        home,
        source: "owner",
      });
    }

    for (const [homeId, sharedInfo] of Object.entries(sharedHomes)) {
      const ownerUid = String(sharedInfo?.ownerUid || "").trim();
      if (!ownerUid) continue;

      const homeSnap = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}`)
        .once("value");
      const sharedHome = homeSnap.val();
      if (!sharedHome) continue;

      homesToCheck.push({
        receiverUid: uid,
        ownerUid,
        homeId,
        home: sharedHome,
        source: "shared",
      });
    }

    return homesToCheck;
  }

  function getReminderSchedules(user, homeId, home, source) {
    const customHomeRules = asObject(user?.customRules?.[homeId]);
    const reminderMode = String(
      customHomeRules.reminderMode || "home",
    );

    if (source === "shared" && reminderMode === "custom") {
      return normalizeReminderCollection(
        customHomeRules.notifications?.items || {},
      );
    }

    return normalizeReminderCollection(
      asObject(home?.schedules).notifications || {},
    );
  }

  async function runScheduledNotificationCheck() {
    const accounts = asObject(getCachedAccountsObject());
    const current = getCurrentHHMM();

    log("⏰ CHECK SCHEDULE:", current);

    for (const [uid, user] of Object.entries(accounts)) {
      const homesToCheck = await collectHomesToCheck(uid, user);

      for (const homeEntry of homesToCheck) {
        const {
          receiverUid,
          homeId,
          home,
          source,
        } = homeEntry;
        const notifications = getReminderSchedules(
          user,
          homeId,
          home,
          source,
        );

        for (const item of notifications) {
          if (debugEnabled) {
            log(
              "🔎 REMINDER DEBUG:",
              receiverUid,
              homeId,
              source,
              JSON.stringify(item),
              "CURRENT:",
              current,
            );
          }

          if (!item || item.enabled !== true) continue;
          if (String(item.time || "").trim() !== current) continue;

          const homeName = home.name || homeId;
          const safety = getHomeNotificationSafety(home);

          if (safety.safe) {
            await sendScheduledNotification({
              uid: receiverUid,
              homeId,
              homeName,
              text: `Nhà bạn đã an toàn, hãy an tâm đi ngủ.\n\nNếu hôm nay bạn có kế hoạch ra/vào nhà trong thời gian Báo động hoạt động,\nhãy thiết lập "Tạm tắt Báo động hôm nay" để tránh làm phiền các thành viên khác.`,
              isSafe: true,
              reason: "",
              reminderItems: [
                {
                  homeId,
                  homeName,
                  reasons: [],
                },
              ],
            });
          } else {
            const unsafeDevices = Array.isArray(safety.unsafeDevices)
              ? safety.unsafeDevices
              : [];
            const detail = unsafeDevices.slice(0, 3).join(", ");

            await sendScheduledNotification({
              uid: receiverUid,
              homeId,
              homeName,
              text: `⚠️ Nhà ${homeName} chưa an toàn: ${detail}\n\nNếu hôm nay bạn có kế hoạch ra/vào nhà trong thời gian Báo động hoạt động,\nhãy thiết lập "Tạm tắt Báo động hôm nay" để tránh làm phiền các thành viên khác.`,
              isSafe: false,
              reason: detail,
              reminderItems: [
                {
                  homeId,
                  homeName,
                  reasons: unsafeDevices,
                },
              ],
            });
          }
        }
      }
    }
  }

  function checkScheduledNotifications() {
    if (checkInFlight) {
      return checkInFlight;
    }

    checkInFlight = runScheduledNotificationCheck()
      .catch((error) => {
        log("SCHEDULE CHECK ERROR:", error.message);
      })
      .finally(() => {
        checkInFlight = null;
      });

    return checkInFlight;
  }

  function startScheduledReminderMonitor() {
    if (monitorTimer) {
      return false;
    }

    monitorTimer = setIntervalFn(() => {
      void checkScheduledNotifications();
    }, Math.max(1, Number(checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS));
    monitorTimer?.unref?.();

    log(
      "🔔 REMINDER MONITOR STARTED:",
      `interval=${Math.max(
        1,
        Number(checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS,
      )}ms`,
    );
    return true;
  }

  function stopScheduledReminderMonitor() {
    if (monitorTimer) {
      clearIntervalFn(monitorTimer);
      monitorTimer = null;
    }

    for (const timer of pendingTimerByUid.values()) {
      clearTimeoutFn(timer);
    }

    pendingTimerByUid.clear();
    pendingByUid.clear();
  }

  return {
    buildScheduledReminderSummary,
    checkScheduledNotifications,
    getReminderSchedules,
    queueScheduledReminder,
    sendScheduledNotification,
    sendScheduledReminderSummary,
    startScheduledReminderMonitor,
    stopScheduledReminderMonitor,
  };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_SUMMARY_DELAY_MS,
  DEFAULT_DEDUPE_WINDOW_MS,
  normalizeReminderCollection,
  dedupeScheduledReminderItems,
  buildScheduledReminderSummary,
  createScheduledReminderDomain,
};
