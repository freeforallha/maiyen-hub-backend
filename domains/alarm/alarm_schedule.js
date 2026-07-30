"use strict";

const DEVICE_ALARM_POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  notificationEnabled: true,
  physicalSirenEnabled: true,
  fullscreenEnabled: true,
});

function resolveDate(value) {
  return value instanceof Date
    ? value
    : new Date();
}

function toMin(value) {
  const [hour, minute] = String(value || "00:00")
    .split(":")
    .map(Number);

  return hour * 60 + minute;
}

function isValidHHMM(value) {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(
    String(value || "").trim(),
  );
}

function isNowInRange(startTime, endTime, date = null) {
  const now = resolveDate(date);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = toMin(startTime || "23:00");
  const end = toMin(endTime || "06:00");

  if (start > end) {
    return nowMin >= start || nowMin < end;
  }

  return nowMin >= start && nowMin < end;
}

function normalizeRepeatMinutes(value) {
  const minutes = Number.parseInt(value || 0, 10);

  if (!Number.isFinite(minutes) || minutes < 0) {
    return 0;
  }

  return minutes;
}

function normalizeAlarmDays(value) {
  const days = [];

  if (Array.isArray(value)) {
    for (const rawDay of value) {
      const day = Number.parseInt(rawDay, 10);

      if (
        Number.isFinite(day) &&
        day >= 1 &&
        day <= 7 &&
        !days.includes(day)
      ) {
        days.push(day);
      }
    }
  }

  days.sort((a, b) => a - b);

  // Legacy Alarm data without days means every day.
  return days.length > 0
    ? days
    : [1, 2, 3, 4, 5, 6, 7];
}

function getCurrentAlarmWeekdayForSchedule(
  startTime,
  endTime,
  date = null,
) {
  const now = resolveDate(date);
  const jsDay = now.getDay(); // 0 = Sunday
  let weekday = jsDay === 0 ? 7 : jsDay;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = toMin(startTime || "23:00");
  const end = toMin(endTime || "06:00");

  // After midnight still belongs to the occurrence started the day before.
  if (start > end && nowMin < end) {
    weekday -= 1;

    if (weekday < 1) {
      weekday = 7;
    }
  }

  return weekday;
}

function isAlarmAllowedToday(alarm, date = null) {
  const days = normalizeAlarmDays(alarm?.days);
  const activeWeekday = getCurrentAlarmWeekdayForSchedule(
    alarm?.start,
    alarm?.end,
    date,
  );

  return days.includes(activeWeekday);
}

function getWeekdayFromDate(date) {
  const jsDay = date.getDay();

  return jsDay === 0 ? 7 : jsDay;
}

function getDateStart(timestamp) {
  const date = new Date(Number(timestamp || Date.now()));

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
}

function alarmInstanceOverlapsPause(
  alarm,
  pauseStartAt,
  pauseEndAt,
) {
  if (
    !alarm ||
    alarm.enabled !== true ||
    !isValidHHMM(alarm.start) ||
    !isValidHHMM(alarm.end)
  ) {
    return false;
  }

  const days = normalizeAlarmDays(alarm.days);
  const pauseStart = Number(pauseStartAt);
  const pauseEnd = Number(pauseEndAt);

  if (
    !Number.isFinite(pauseStart) ||
    !Number.isFinite(pauseEnd) ||
    pauseEnd <= pauseStart
  ) {
    return false;
  }

  const startMinute = toMin(alarm.start);
  const endMinute = toMin(alarm.end);
  const baseDate = getDateStart(pauseStart).getTime();

  // Previous day through two days ahead covers overnight occurrences.
  for (let offset = -1; offset <= 2; offset++) {
    const startDate = new Date(
      baseDate + offset * 24 * 60 * 60 * 1000,
    );

    if (!days.includes(getWeekdayFromDate(startDate))) {
      continue;
    }

    const alarmStart =
      startDate.getTime() + startMinute * 60 * 1000;
    let alarmEnd =
      startDate.getTime() + endMinute * 60 * 1000;

    if (alarmEnd <= alarmStart) {
      alarmEnd += 24 * 60 * 60 * 1000;
    }

    if (pauseStart < alarmEnd && alarmStart < pauseEnd) {
      return true;
    }
  }

  return false;
}

function normalizeDeviceAlarmScheduleEntry(
  rawAlarm,
  {
    scheduleId = "legacy",
    scope = "home",
  } = {},
) {
  if (!rawAlarm || typeof rawAlarm !== "object") {
    return null;
  }

  return {
    enabled: rawAlarm.enabled === true,
    start: isValidHHMM(rawAlarm.start)
      ? String(rawAlarm.start)
      : "23:00",
    end: isValidHHMM(rawAlarm.end)
      ? String(rawAlarm.end)
      : "06:00",
    repeatMinutes: normalizeRepeatMinutes(
      rawAlarm.repeatMinutes,
    ),
    days: normalizeAlarmDays(rawAlarm.days),
    scheduleId: String(scheduleId || "legacy"),
    scheduleScope: String(scope || "home"),
  };
}

function normalizeDeviceAlarmScheduleCollection(
  rawSchedules,
  { scope = "home" } = {},
) {
  const schedules = [];

  if (
    rawSchedules &&
    typeof rawSchedules === "object" &&
    !Array.isArray(rawSchedules)
  ) {
    for (const [scheduleId, rawSchedule] of Object.entries(
      rawSchedules,
    )) {
      const normalized = normalizeDeviceAlarmScheduleEntry(
        rawSchedule,
        { scheduleId, scope },
      );

      if (normalized) schedules.push(normalized);
    }
  }

  return schedules;
}

function normalizeSecurityModeRepeatMinutes(value) {
  const minutes = Number.parseInt(value || 0, 10);

  return [0, 15, 30, 60].includes(minutes)
    ? minutes
    : 0;
}

function getActiveScheduleOccurrenceIdentity(
  alarm,
  date = null,
) {
  if (!alarm || typeof alarm !== "object") {
    return "";
  }

  const now = resolveDate(date);
  const startText = String(alarm.start || "00:00");
  const endText = String(alarm.end || "00:00");
  const [startHour, startMinute] = startText
    .split(":")
    .map((value) => Number.parseInt(value || 0, 10) || 0);
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const start = toMin(startText);
  const end = toMin(endText);
  const occurrenceStart = new Date(now);

  if (start > end && nowMinute < end) {
    occurrenceStart.setDate(occurrenceStart.getDate() - 1);
  }

  occurrenceStart.setHours(startHour, startMinute, 0, 0);

  return String(occurrenceStart.getTime());
}

function isDeviceAlarmScheduleActive(alarm, date = null) {
  return Boolean(
    alarm &&
    typeof alarm === "object" &&
    alarm.enabled === true &&
    isAlarmAllowedToday(alarm, date) &&
    isNowInRange(alarm.start, alarm.end, date),
  );
}

function getDeviceAlarmScheduleRuntimeIdentity(scope, alarm) {
  if (!alarm || typeof alarm !== "object") {
    return "";
  }

  return [
    String(scope || alarm.scheduleScope || "schedule"),
    String(alarm.scheduleId || "legacy"),
    String(alarm.start || ""),
    String(alarm.end || ""),
    normalizeAlarmDays(alarm.days).join("-"),
    normalizeRepeatMinutes(alarm.repeatMinutes),
  ].join(":");
}

function resolveActiveDeviceSchedule(configuration, date = null) {
  const allActiveHomeSchedules =
    (configuration?.homeSchedules || []).filter((alarm) =>
      isDeviceAlarmScheduleActive(alarm, date),
    );
  const followsHomeSchedule =
    configuration?.followHomeSchedule !== false;
  const activeHomeSchedules = followsHomeSchedule
    ? allActiveHomeSchedules
    : [];
  const independentPersonalSchedules = followsHomeSchedule
    ? []
    : (configuration?.personalSchedules || []).filter((alarm) =>
        isDeviceAlarmScheduleActive(alarm, date),
      );
  const activePersonalSchedules = followsHomeSchedule
    ? allActiveHomeSchedules
    : independentPersonalSchedules;
  const policy = configuration?.policy ||
    DEVICE_ALARM_POLICY_DEFAULTS;

  const physicalSirenAllowed = Boolean(
    configuration?.isOwnerReceiver === true &&
    allActiveHomeSchedules.length > 0 &&
    policy.physicalSirenEnabled !== false,
  );

  if (
    activeHomeSchedules.length === 0 &&
    independentPersonalSchedules.length === 0 &&
    !physicalSirenAllowed
  ) {
    return null;
  }

  const effectiveHomeSchedules = activeHomeSchedules.length > 0
    ? activeHomeSchedules
    : physicalSirenAllowed
      ? allActiveHomeSchedules
      : [];
  const activeAlarms = [
    ...effectiveHomeSchedules,
    ...independentPersonalSchedules,
  ];
  const scheduleIdentities = [
    ...effectiveHomeSchedules.map((alarm) =>
      getDeviceAlarmScheduleRuntimeIdentity("home", alarm),
    ),
    ...independentPersonalSchedules.map((alarm) =>
      getDeviceAlarmScheduleRuntimeIdentity("personal", alarm),
    ),
  ].sort();
  const positiveRepeatMinutes = activeAlarms
    .map((alarm) =>
      normalizeRepeatMinutes(alarm?.repeatMinutes),
    )
    .filter((minutes) => minutes > 0);
  const repeatMinutes = positiveRepeatMinutes.length > 0
    ? Math.min(...positiveRepeatMinutes)
    : 0;
  const primaryAlarm =
    effectiveHomeSchedules[0] || independentPersonalSchedules[0];
  const scheduleIdentity = scheduleIdentities.join("||");

  const notificationAllowed = Boolean(
    followsHomeSchedule
      ? (
          allActiveHomeSchedules.length > 0 &&
          policy.notificationEnabled !== false
        )
      : (
          independentPersonalSchedules.length > 0 &&
          configuration?.personalNotificationEnabled !== false
        ),
  );
  const fullscreenAllowed =
    activePersonalSchedules.length > 0 &&
    configuration?.fullscreenEnabled !== false;

  return {
    alarm: {
      ...(primaryAlarm || {}),
      enabled: true,
      repeatMinutes,
      scheduleIdentity,
    },
    source: "scheduled_alarm",
    homeActive: allActiveHomeSchedules.length > 0,
    personalActive: activePersonalSchedules.length > 0,
    activeHomeSchedules,
    allActiveHomeSchedules,
    activePersonalSchedules,
    scheduleIdentity,
    notificationAllowed,
    fullscreenAllowed,
    physicalSirenAllowed,
  };
}

function isScheduledAlarmSource(source) {
  return [
    "scheduled_alarm",
    "home_schedule",
    "personal_schedule",
  ].includes(String(source || "").trim());
}

module.exports = {
  DEVICE_ALARM_POLICY_DEFAULTS,
  toMin,
  isValidHHMM,
  isNowInRange,
  normalizeRepeatMinutes,
  normalizeAlarmDays,
  getCurrentAlarmWeekdayForSchedule,
  isAlarmAllowedToday,
  getWeekdayFromDate,
  getDateStart,
  alarmInstanceOverlapsPause,
  normalizeDeviceAlarmScheduleEntry,
  normalizeDeviceAlarmScheduleCollection,
  normalizeSecurityModeRepeatMinutes,
  getActiveScheduleOccurrenceIdentity,
  isDeviceAlarmScheduleActive,
  getDeviceAlarmScheduleRuntimeIdentity,
  resolveActiveDeviceSchedule,
  isScheduledAlarmSource,
};
