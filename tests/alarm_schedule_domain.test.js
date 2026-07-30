"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  toMin,
  isValidHHMM,
  isNowInRange,
  normalizeRepeatMinutes,
  normalizeAlarmDays,
  getCurrentAlarmWeekdayForSchedule,
  isAlarmAllowedToday,
  alarmInstanceOverlapsPause,
  normalizeDeviceAlarmScheduleCollection,
  normalizeSecurityModeRepeatMinutes,
  getActiveScheduleOccurrenceIdentity,
  getDeviceAlarmScheduleRuntimeIdentity,
  resolveActiveDeviceSchedule,
  isScheduledAlarmSource,
} = require("../domains/alarm/alarm_schedule");

function localDate(year, monthIndex, day, hour, minute = 0) {
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

function schedule({
  id,
  scope = "home",
  start = "00:00",
  end = "23:59",
  repeatMinutes = 0,
  days = [1, 2, 3, 4, 5, 6, 7],
} = {}) {
  return {
    enabled: true,
    scheduleId: id,
    scheduleScope: scope,
    start,
    end,
    repeatMinutes,
    days,
  };
}

test("schedule normalization keeps safe defaults and rejects invalid containers", () => {
  assert.equal(toMin("01:30"), 90);
  assert.equal(isValidHHMM("23:59"), true);
  assert.equal(isValidHHMM("24:00"), false);
  assert.equal(normalizeRepeatMinutes(-15), 0);
  assert.equal(normalizeRepeatMinutes("30"), 30);
  assert.equal(normalizeSecurityModeRepeatMinutes(30), 30);
  assert.equal(normalizeSecurityModeRepeatMinutes(45), 0);
  assert.deepEqual(normalizeAlarmDays([7, "1", 1, 9, 3]), [1, 3, 7]);
  assert.deepEqual(normalizeAlarmDays(null), [1, 2, 3, 4, 5, 6, 7]);

  const normalized = normalizeDeviceAlarmScheduleCollection({
    night: {
      enabled: true,
      start: "bad",
      end: "06:00",
      repeatMinutes: "15",
      days: [1, 2],
    },
  });

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].scheduleId, "night");
  assert.equal(normalized[0].start, "23:00");
  assert.equal(normalized[0].end, "06:00");
  assert.deepEqual(normalizeDeviceAlarmScheduleCollection([]), []);
});

test("overnight schedules use the starting weekday and exclude the end minute", () => {
  const mondayLate = localDate(2026, 6, 20, 23, 0);
  const tuesdayEarly = localDate(2026, 6, 21, 1, 0);
  const tuesdayEnd = localDate(2026, 6, 21, 6, 0);

  assert.equal(isNowInRange("23:00", "06:00", mondayLate), true);
  assert.equal(isNowInRange("23:00", "06:00", tuesdayEarly), true);
  assert.equal(isNowInRange("23:00", "06:00", tuesdayEnd), false);
  assert.equal(
    getCurrentAlarmWeekdayForSchedule(
      "23:00",
      "06:00",
      tuesdayEarly,
    ),
    1,
  );
  assert.equal(
    isAlarmAllowedToday(
      schedule({
        id: "monday-night",
        start: "23:00",
        end: "06:00",
        days: [1],
      }),
      tuesdayEarly,
    ),
    true,
  );
});

test("pause overlap covers overnight occurrences without false positives", () => {
  const mondayNight = schedule({
    id: "night",
    start: "23:00",
    end: "06:00",
    days: [1],
  });

  assert.equal(
    alarmInstanceOverlapsPause(
      mondayNight,
      localDate(2026, 6, 21, 1, 0).getTime(),
      localDate(2026, 6, 21, 2, 0).getTime(),
    ),
    true,
  );
  assert.equal(
    alarmInstanceOverlapsPause(
      mondayNight,
      localDate(2026, 6, 21, 7, 0).getTime(),
      localDate(2026, 6, 21, 8, 0).getTime(),
    ),
    false,
  );
});

test("active schedule selection deduplicates identities and uses shortest repeat", () => {
  const now = localDate(2026, 6, 20, 12, 0);
  const result = resolveActiveDeviceSchedule({
    homeSchedules: [
      schedule({ id: "all-day", repeatMinutes: 30 }),
      schedule({ id: "short", repeatMinutes: 15 }),
    ],
    personalSchedules: [],
    followHomeSchedule: true,
    isOwnerReceiver: true,
    fullscreenEnabled: true,
    policy: {
      notificationEnabled: true,
      physicalSirenEnabled: true,
    },
  }, now);

  assert.ok(result);
  assert.equal(result.alarm.repeatMinutes, 15);
  assert.equal(result.notificationAllowed, true);
  assert.equal(result.fullscreenAllowed, true);
  assert.equal(result.physicalSirenAllowed, true);
  assert.equal(result.activeHomeSchedules.length, 2);
  assert.match(result.scheduleIdentity, /home:all-day/);
  assert.match(result.scheduleIdentity, /home:short/);
});

test("independent personal schedule disables home notification but Owner keeps home siren", () => {
  const now = localDate(2026, 6, 20, 12, 0);
  const personal = resolveActiveDeviceSchedule({
    homeSchedules: [schedule({ id: "home", repeatMinutes: 30 })],
    personalSchedules: [
      schedule({ id: "mine", scope: "personal", repeatMinutes: 15 }),
    ],
    followHomeSchedule: false,
    isOwnerReceiver: false,
    personalNotificationEnabled: true,
    fullscreenEnabled: true,
    policy: {
      notificationEnabled: true,
      physicalSirenEnabled: true,
    },
  }, now);

  assert.ok(personal);
  assert.equal(personal.alarm.scheduleId, "mine");
  assert.equal(personal.notificationAllowed, true);
  assert.equal(personal.fullscreenAllowed, true);
  assert.equal(personal.physicalSirenAllowed, false);

  const ownerActuator = resolveActiveDeviceSchedule({
    homeSchedules: [schedule({ id: "home", repeatMinutes: 30 })],
    personalSchedules: [],
    followHomeSchedule: false,
    isOwnerReceiver: true,
    personalNotificationEnabled: false,
    fullscreenEnabled: false,
    policy: {
      notificationEnabled: false,
      physicalSirenEnabled: true,
    },
  }, now);

  assert.ok(ownerActuator);
  assert.equal(ownerActuator.notificationAllowed, false);
  assert.equal(ownerActuator.fullscreenAllowed, false);
  assert.equal(ownerActuator.physicalSirenAllowed, true);
});

test("runtime identities preserve occurrence and supported schedule sources", () => {
  const overnight = schedule({
    id: "night",
    start: "23:00",
    end: "06:00",
    days: [1],
    repeatMinutes: 15,
  });
  const mondayStart = localDate(2026, 6, 20, 23, 0);
  const tuesdayEarly = localDate(2026, 6, 21, 1, 0);

  assert.equal(
    getActiveScheduleOccurrenceIdentity(overnight, mondayStart),
    getActiveScheduleOccurrenceIdentity(overnight, tuesdayEarly),
  );
  assert.equal(
    getDeviceAlarmScheduleRuntimeIdentity("home", overnight),
    "home:night:23:00:06:00:1:15",
  );
  assert.equal(isScheduledAlarmSource("scheduled_alarm"), true);
  assert.equal(isScheduledAlarmSource("personal_schedule"), true);
  assert.equal(isScheduledAlarmSource("security_mode"), false);
});
