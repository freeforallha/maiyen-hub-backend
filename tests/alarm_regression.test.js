"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  createSystemHealthDomain,
} = require("../domains/system_health/system_health");
const alarmSchedule = require(
  "../domains/alarm/alarm_schedule",
);
const alarmIncident = require(
  "../domains/alarm/alarm_incident",
);
const sensorAlarmEngine = require(
  "../domains/alarm/sensor_alarm_engine",
);

const INDEX_PATH = path.resolve(__dirname, "..", "index.js");
const AUTO_AWAY_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "auto_away",
  "auto_away.js",
);
const DEVICE_PROFILE_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "devices",
  "device_profile.js",
);
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, "utf8");
const AUTO_AWAY_SOURCE = fs.readFileSync(AUTO_AWAY_PATH, "utf8");
const DEVICE_PROFILE_SOURCE = fs.readFileSync(
  DEVICE_PROFILE_PATH,
  "utf8",
);
const ALARM_SCHEDULE_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "alarm",
  "alarm_schedule.js",
);
const ALARM_SCHEDULE_SOURCE = fs.readFileSync(
  ALARM_SCHEDULE_PATH,
  "utf8",
);
const ALARM_INCIDENT_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "alarm",
  "alarm_incident.js",
);
const ALARM_INCIDENT_SOURCE = fs.readFileSync(
  ALARM_INCIDENT_PATH,
  "utf8",
);
const PHYSICAL_SIREN_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "alarm",
  "physical_siren.js",
);
const PHYSICAL_SIREN_SOURCE = fs.readFileSync(
  PHYSICAL_SIREN_PATH,
  "utf8",
);
const ALARM_INCIDENT_LIFECYCLE_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "alarm",
  "alarm_incident_lifecycle.js",
);
const ALARM_INCIDENT_LIFECYCLE_SOURCE = fs.readFileSync(
  ALARM_INCIDENT_LIFECYCLE_PATH,
  "utf8",
);
const ALARM_INCIDENT_PERSISTENCE_PATH = path.resolve(
  __dirname,
  "..",
  "domains",
  "alarm",
  "alarm_incident_persistence.js",
);
const ALARM_INCIDENT_PERSISTENCE_SOURCE = fs.readFileSync(
  ALARM_INCIDENT_PERSISTENCE_PATH,
  "utf8",
);

function findDeclarationStart(source, pattern, label) {
  const match = pattern.exec(source);
  assert.ok(match, `Không tìm thấy ${label} trong backend/index.js`);
  return match.index;
}

function scanBalancedBlock(source, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === openChar) depth++;
    if (char === closeChar) {
      depth--;
      if (depth === 0) return index;
    }
  }

  throw new Error(`Không tìm thấy dấu đóng ${closeChar}`);
}

function extractFunctionSourceFrom(source, name, sourceLabel) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = findDeclarationStart(
    source,
    new RegExp(`(?:async\\s+)?function\\s+${escapedName}\\s*\\(`),
    `hàm ${name}() trong ${sourceLabel}`,
  );
  const paramsStart = source.indexOf("(", start);
  assert.notEqual(paramsStart, -1, `Hàm ${name}() không có danh sách tham số`);
  const paramsEnd = scanBalancedBlock(source, paramsStart, "(", ")");
  const bodyStart = source.indexOf("{", paramsEnd);
  assert.notEqual(bodyStart, -1, `Hàm ${name}() không có thân hàm`);
  const bodyEnd = scanBalancedBlock(source, bodyStart, "{", "}");
  return source.slice(start, bodyEnd + 1);
}

function extractFunctionSource(name) {
  return extractFunctionSourceFrom(INDEX_SOURCE, name, "backend/index.js");
}

function extractAutoAwayFunctionSource(name) {
  return extractFunctionSourceFrom(
    AUTO_AWAY_SOURCE,
    name,
    "domains/auto_away/auto_away.js",
  );
}

function extractDeviceProfileFunctionSource(name) {
  return extractFunctionSourceFrom(
    DEVICE_PROFILE_SOURCE,
    name,
    "domains/devices/device_profile.js",
  );
}

function extractAlarmIncidentFunctionSource(name) {
  return extractFunctionSourceFrom(
    ALARM_INCIDENT_SOURCE,
    name,
    "domains/alarm/alarm_incident.js",
  );
}

function extractPhysicalSirenFunctionSource(name) {
  return extractFunctionSourceFrom(
    PHYSICAL_SIREN_SOURCE,
    name,
    "domains/alarm/physical_siren.js",
  );
}

function extractAlarmIncidentLifecycleFunctionSource(name) {
  return extractFunctionSourceFrom(
    ALARM_INCIDENT_LIFECYCLE_SOURCE,
    name,
    "domains/alarm/alarm_incident_lifecycle.js",
  );
}

function extractAlarmIncidentPersistenceFunctionSource(name) {
  return extractFunctionSourceFrom(
    ALARM_INCIDENT_PERSISTENCE_SOURCE,
    name,
    "domains/alarm/alarm_incident_persistence.js",
  );
}

function extractConstSource(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = findDeclarationStart(
    INDEX_SOURCE,
    new RegExp(`const\\s+${escapedName}\\s*=`),
    `hằng ${name}`,
  );

  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let round = 0;
  let square = 0;
  let curly = 0;

  for (let index = start; index < INDEX_SOURCE.length; index++) {
    const char = INDEX_SOURCE[index];
    const next = INDEX_SOURCE[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") round++;
    if (char === ")") round--;
    if (char === "[") square++;
    if (char === "]") square--;
    if (char === "{") curly++;
    if (char === "}") curly--;

    if (
      char === ";" &&
      round === 0 &&
      square === 0 &&
      curly === 0
    ) {
      return INDEX_SOURCE.slice(start, index + 1);
    }
  }

  throw new Error(`Không tìm thấy cuối khai báo const ${name}`);
}

function createAlarmRuntime(initialNow) {
  const clock = {
    now: Number(initialNow ?? new Date(2026, 6, 20, 12, 0, 0).getTime()),
  };

  class ControlledDate extends Date {
    constructor(...args) {
      super(...(args.length === 0 ? [clock.now] : args));
    }

    static now() {
      return clock.now;
    }
  }

  const getControlledNow = () => new Date(clock.now);
  const scheduleRuntime = {
    ...alarmSchedule,
    isNowInRange(startTime, endTime) {
      return alarmSchedule.isNowInRange(
        startTime,
        endTime,
        getControlledNow(),
      );
    },
    getCurrentAlarmWeekdayForSchedule(startTime, endTime) {
      return alarmSchedule.getCurrentAlarmWeekdayForSchedule(
        startTime,
        endTime,
        getControlledNow(),
      );
    },
    isAlarmAllowedToday(alarm) {
      return alarmSchedule.isAlarmAllowedToday(
        alarm,
        getControlledNow(),
      );
    },
    getActiveScheduleOccurrenceIdentity(alarm) {
      return alarmSchedule.getActiveScheduleOccurrenceIdentity(
        alarm,
        getControlledNow(),
      );
    },
    isDeviceAlarmScheduleActive(alarm) {
      return alarmSchedule.isDeviceAlarmScheduleActive(
        alarm,
        getControlledNow(),
      );
    },
    resolveActiveDeviceSchedule(configuration) {
      return alarmSchedule.resolveActiveDeviceSchedule(
        configuration,
        getControlledNow(),
      );
    },
  };

  const sensorRuntime = sensorAlarmEngine.createSensorAlarmEngine({
    db: {
      ref() {
        return {
          async update() {},
        };
      },
    },
    getCachedAccountData: () => null,
    normalizeAlarmIncidentItems:
      alarmIncident.normalizeAlarmIncidentItems,
    isSecurityDeviceType: alarmIncident.isSecurityDeviceType,
    isEmergencyDeviceType: alarmIncident.isEmergencyDeviceType,
    vibrationActiveWindowMs: 15 * 1000,
    emergencyStatusHoldMs: 5 * 60 * 1000,
    nowFn: () => clock.now,
    log() {},
  });

  const context = vm.createContext({
    console: {
      log() {},
      error() {},
      warn() {},
    },
    Date: ControlledDate,
    Map,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Set,
    ...scheduleRuntime,
    ...alarmIncident,
    ...sensorRuntime,
    normalizeHomeSecurityMode:
      sensorAlarmEngine.normalizeHomeSecurityMode,
    SAME_ALARM_EVENT_MIN_INTERVAL_MS:
      sensorAlarmEngine.SAME_ALARM_EVENT_MIN_INTERVAL_MS,
    SENSOR_EVENT_CATEGORY:
      sensorAlarmEngine.SENSOR_EVENT_CATEGORY,
    SENSOR_EVENT_SEVERITY:
      sensorAlarmEngine.SENSOR_EVENT_SEVERITY,
  });

  const constNames = [
    "OFFLINE_TRANSIENT_ALARM_TTL_MS",
    "UNPROTECTED_TRANSIENT_REPLAY_WINDOW_MS",
    "VIBRATION_ACTIVE_WINDOW_MS",
  ];

  const deviceProfileFunctionNames = [
    "isActiveSignal",
    "normalizeLockState",
    "isVibrationAction",
    "isGlassBreakAction",
  ];

  const scheduleFunctionNames = [
    "toMin",
    "isNowInRange",
    "isValidHHMM",
    "normalizeRepeatMinutes",
    "normalizeAlarmDays",
    "getCurrentAlarmWeekdayForSchedule",
    "isAlarmAllowedToday",
    "getWeekdayFromDate",
    "getDateStart",
    "alarmInstanceOverlapsPause",
    "normalizeDeviceAlarmScheduleEntry",
    "normalizeDeviceAlarmScheduleCollection",
    "normalizeSecurityModeRepeatMinutes",
    "getActiveScheduleOccurrenceIdentity",
    "isDeviceAlarmScheduleActive",
    "getDeviceAlarmScheduleRuntimeIdentity",
    "resolveActiveDeviceSchedule",
    "isScheduledAlarmSource",
  ];

  const functionNames = [
    "getCurrentEmergencyReason",
    "resolveDeviceAlarmConfigurationForReceiver",
  ];

  const sensorFunctionNames = [
    "normalizeDeviceAlarmPolicy",
    "normalizeHomeSecurityMode",
    "resolveAlarmActivationPriority",
    "buildAlarmTriggerFromSensorEvent",
    "getSensorAlarmEventCode",
    "getSensorAlarmDebounceMs",
    "cleanupSensorAlarmDebounceMap",
    "shouldAcceptSensorAlarmTrigger",
  ];

  const setupSource = [
    ...constNames.map(extractConstSource),
    ...deviceProfileFunctionNames.map(
      extractDeviceProfileFunctionSource,
    ),
    ...functionNames.map(extractFunctionSource),
    `this.__alarm = {
      ${deviceProfileFunctionNames.join(",\n      ")},
      ${scheduleFunctionNames.join(",\n      ")},
      isSecurityDeviceType,
      isEmergencyDeviceType,
      ${functionNames.join(",\n      ")},
      ${sensorFunctionNames.join(",\n      ")},
      DEVICE_ALARM_POLICY_DEFAULTS,
      OFFLINE_TRANSIENT_ALARM_TTL_MS,
      UNPROTECTED_TRANSIENT_REPLAY_WINDOW_MS,
      SAME_ALARM_EVENT_MIN_INTERVAL_MS,
    };`,
  ].join("\n\n");

  vm.runInContext(setupSource, context, {
    filename: "alarm_regression_runtime.vm.js",
  });

  return {
    api: context.__alarm,
    setNow(value) {
      clock.now = Number(value);
    },
    advance(ms) {
      clock.now += Number(ms);
    },
  };
}

function localTime(year, monthIndex, day, hour, minute = 0) {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

test("lịch không có days được hiểu là chạy hằng ngày", () => {
  const { api } = createAlarmRuntime();

  assert.deepEqual(
    Array.from(api.normalizeAlarmDays(null)),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    Array.from(api.normalizeAlarmDays([7, "1", 1, 9, 0, 3])),
    [1, 3, 7],
  );
});

test("lịch qua nửa đêm dùng ngày bắt đầu của ca báo động", () => {
  // 01:00 thứ Ba 21/07/2026 thuộc ca bắt đầu tối thứ Hai.
  const runtime = createAlarmRuntime(localTime(2026, 6, 21, 1, 0));
  const { api } = runtime;

  assert.equal(
    api.getCurrentAlarmWeekdayForSchedule("23:00", "06:00"),
    1,
  );
  assert.equal(
    api.isAlarmAllowedToday({
      start: "23:00",
      end: "06:00",
      days: [1],
    }),
    true,
  );
  assert.equal(
    api.isAlarmAllowedToday({
      start: "23:00",
      end: "06:00",
      days: [2],
    }),
    false,
  );
});

test("giờ bắt đầu được tính, giờ kết thúc bị loại trừ", () => {
  const runtime = createAlarmRuntime(localTime(2026, 6, 20, 23, 0));

  assert.equal(runtime.api.isNowInRange("23:00", "06:00"), true);

  runtime.setNow(localTime(2026, 6, 21, 5, 59));
  assert.equal(runtime.api.isNowInRange("23:00", "06:00"), true);

  runtime.setNow(localTime(2026, 6, 21, 6, 0));
  assert.equal(runtime.api.isNowInRange("23:00", "06:00"), false);
});

test("chỉ alarmSchedules mới được chuẩn hóa thành lịch Alarm", () => {
  const { api } = createAlarmRuntime();
  const schedules = {
    night: {
      enabled: true,
      start: "22:00",
      end: "06:00",
      repeatMinutes: 30,
      days: [1, 2, 3, 4, 5],
    },
  };

  const result = api.normalizeDeviceAlarmScheduleCollection(
    schedules,
    { scope: "home" },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].scheduleId, "night");
  assert.deepEqual(
    Array.from(
      api.normalizeDeviceAlarmScheduleCollection(
        null,
        { scope: "home" },
      ),
    ),
    [],
  );
  assert.deepEqual(
    Array.from(
      api.normalizeDeviceAlarmScheduleCollection(
        [schedules.night],
        { scope: "home" },
      ),
    ),
    [],
  );
});

test("schema v2 và followHomeSchedule false dùng lịch Alarm cá nhân", async () => {
  const { api } = createAlarmRuntime();
  const configuration = await api.resolveDeviceAlarmConfigurationForReceiver(
    "memberA",
    "homeA",
    "doorA",
    {
      _ownerUid: "ownerA",
      devices: {
        doorA: {
          type: "door",
          alarmSchedules: {
            home: {
              enabled: true,
              start: "00:00",
              end: "23:59",
              repeatMinutes: 30,
              days: [1],
            },
          },
        },
      },
    },
    {
      customRules: {
        homeA: {
          mode: "home",
          alarmMode: "home",
          devices: {
            doorA: {
              alarmSchedules: {
                personal: {
                  enabled: true,
                  start: "00:00",
                  end: "23:59",
                  repeatMinutes: 15,
                  days: [1],
                },
              },
              alarmPreferences: {
                followHomeSchedule: false,
                scheduleModelVersion: 2,
              },
            },
          },
        },
      },
    },
    "ownerA",
  );

  assert.equal(configuration.followHomeSchedule, false);
  assert.equal(configuration.scheduleModelVersion, 2);
  assert.equal(configuration.personalSchedules.length, 1);
  assert.equal(configuration.personalSchedules[0].scheduleId, "personal");

  const active = api.resolveActiveDeviceSchedule(configuration);
  assert.ok(active);
  assert.equal(active.alarm.scheduleId, "personal");
  assert.equal(active.alarm.scheduleScope, "personal");
});

test("mode custom thiếu schema mới không kích hoạt Alarm legacy cá nhân", async () => {
  const { api } = createAlarmRuntime();
  const configuration = await api.resolveDeviceAlarmConfigurationForReceiver(
    "memberA",
    "homeA",
    "doorA",
    {
      _ownerUid: "ownerA",
      devices: {
        doorA: {
          type: "door",
        },
      },
    },
    {
      customRules: {
        homeA: {
          mode: "custom",
          devices: {
            doorA: {
              alarm: {
                enabled: true,
                start: "00:00",
                end: "23:59",
                repeatMinutes: 15,
                days: [1],
              },
              alarmPreferences: {
                followHomeSchedule: false,
                scheduleModelVersion: 2,
              },
            },
          },
        },
      },
    },
    "ownerA",
  );

  assert.equal(configuration.followHomeSchedule, false);
  assert.equal(configuration.scheduleModelVersion, 2);
  assert.deepEqual(Array.from(configuration.personalSchedules), []);
  assert.equal(
    Object.prototype.hasOwnProperty.call(configuration, "personalAlarm"),
    false,
  );
});

test("trạng thái siren device.alarm không bị biến thành lịch Alarm", async () => {
  const { api } = createAlarmRuntime();
  const configuration = await api.resolveDeviceAlarmConfigurationForReceiver(
    "ownerA",
    "homeA",
    "sirenA",
    {
      _ownerUid: "ownerA",
      devices: {
        sirenA: {
          type: "siren",
          alarm: true,
        },
      },
    },
    {
      customRules: {
        homeA: {
          mode: "custom",
          alarmMode: "custom",
          devices: {
            sirenA: {
              alarmSchedules: {
                personal: {
                  enabled: true,
                  start: "00:00",
                  end: "23:59",
                  repeatMinutes: 15,
                  days: [1],
                },
              },
              alarmPreferences: {
                followHomeSchedule: true,
                scheduleModelVersion: 2,
              },
            },
          },
        },
      },
    },
    "ownerA",
  );

  assert.equal(configuration.followHomeSchedule, true);
  assert.deepEqual(Array.from(configuration.homeSchedules), []);
  assert.deepEqual(Array.from(configuration.personalSchedules), []);
  assert.equal(api.resolveActiveDeviceSchedule(configuration), null);
});

test("tạm tắt giao với đúng lịch qua đêm", () => {
  const { api } = createAlarmRuntime();
  const alarm = {
    enabled: true,
    start: "23:00",
    end: "06:00",
    days: [1], // Thứ Hai
  };

  const pauseInside = {
    start: localTime(2026, 6, 21, 1, 0), // Thứ Ba
    end: localTime(2026, 6, 21, 2, 0),
  };
  const pauseOutside = {
    start: localTime(2026, 6, 21, 7, 0),
    end: localTime(2026, 6, 21, 8, 0),
  };

  assert.equal(
    api.alarmInstanceOverlapsPause(
      alarm,
      pauseInside.start,
      pauseInside.end,
    ),
    true,
  );
  assert.equal(
    api.alarmInstanceOverlapsPause(
      alarm,
      pauseOutside.start,
      pauseOutside.end,
    ),
    false,
  );
});

test("cấu hình thiết bị mặc định giữ đủ ba kênh cảnh báo", () => {
  const { api } = createAlarmRuntime();

  assert.deepEqual(
    { ...api.normalizeDeviceAlarmPolicy({}, "door") },
    {
      enabled: true,
      notificationEnabled: true,
      physicalSirenEnabled: true,
      fullscreenEnabled: true,
    },
  );

  assert.equal(
    api.normalizeDeviceAlarmPolicy(
      { alarmPolicy: { enabled: false } },
      "smoke",
    ).enabled,
    true,
  );
});

test("theo lịch chung: thông báo/fullscreen theo cấu hình, còi chỉ Owner bật", () => {
  const runtime = createAlarmRuntime(localTime(2026, 6, 20, 22, 30));
  const { api } = runtime;
  const homeSchedule = {
    enabled: true,
    start: "22:00",
    end: "23:00",
    days: [1],
    repeatMinutes: 30,
    scheduleId: "night",
    scheduleScope: "home",
  };

  const ownerResult = api.resolveActiveDeviceSchedule({
    homeSchedules: [homeSchedule],
    personalSchedules: [],
    followHomeSchedule: true,
    personalNotificationEnabled: true,
    fullscreenEnabled: true,
    isOwnerReceiver: true,
    policy: {
      enabled: true,
      notificationEnabled: false,
      physicalSirenEnabled: true,
      fullscreenEnabled: true,
    },
  });

  assert.ok(ownerResult);
  assert.equal(ownerResult.notificationAllowed, false);
  assert.equal(ownerResult.fullscreenAllowed, true);
  assert.equal(ownerResult.physicalSirenAllowed, true);

  const memberResult = api.resolveActiveDeviceSchedule({
    homeSchedules: [homeSchedule],
    personalSchedules: [],
    followHomeSchedule: true,
    personalNotificationEnabled: true,
    fullscreenEnabled: true,
    isOwnerReceiver: false,
    policy: {
      enabled: true,
      notificationEnabled: true,
      physicalSirenEnabled: true,
      fullscreenEnabled: true,
    },
  });

  assert.ok(memberResult);
  assert.equal(memberResult.notificationAllowed, true);
  assert.equal(memberResult.fullscreenAllowed, true);
  assert.equal(memberResult.physicalSirenAllowed, false);
});

test("tắt theo lịch chung thì chỉ lịch cá nhân độc lập có hiệu lực", () => {
  const runtime = createAlarmRuntime(localTime(2026, 6, 20, 22, 30));
  const { api } = runtime;
  const homeSchedule = {
    enabled: true,
    start: "22:00",
    end: "23:00",
    days: [1],
    repeatMinutes: 30,
    scheduleId: "home",
  };
  const personalSchedule = {
    enabled: true,
    start: "22:00",
    end: "23:00",
    days: [1],
    repeatMinutes: 15,
    scheduleId: "personal",
  };

  const result = api.resolveActiveDeviceSchedule({
    homeSchedules: [homeSchedule],
    personalSchedules: [personalSchedule],
    followHomeSchedule: false,
    personalNotificationEnabled: false,
    fullscreenEnabled: true,
    isOwnerReceiver: false,
    policy: {
      enabled: true,
      notificationEnabled: true,
      physicalSirenEnabled: true,
      fullscreenEnabled: true,
    },
  });

  assert.ok(result);
  assert.equal(result.homeActive, true);
  assert.equal(result.personalActive, true);
  assert.equal(result.notificationAllowed, false);
  assert.equal(result.fullscreenAllowed, true);
  assert.equal(result.physicalSirenAllowed, false);
  assert.equal(result.alarm.repeatMinutes, 15);
  assert.match(result.scheduleIdentity, /personal/);
  assert.doesNotMatch(result.scheduleIdentity, /home:home/);
});

test("nhiều lịch đồng thời dùng chu kỳ lặp ngắn nhất", () => {
  const runtime = createAlarmRuntime(localTime(2026, 6, 20, 22, 30));
  const { api } = runtime;
  const result = api.resolveActiveDeviceSchedule({
    homeSchedules: [
      {
        enabled: true,
        start: "22:00",
        end: "23:00",
        days: [1],
        repeatMinutes: 30,
        scheduleId: "a",
      },
      {
        enabled: true,
        start: "22:15",
        end: "22:45",
        days: [1],
        repeatMinutes: 15,
        scheduleId: "b",
      },
    ],
    personalSchedules: [],
    followHomeSchedule: true,
    fullscreenEnabled: true,
    isOwnerReceiver: true,
    policy: {
      enabled: true,
      notificationEnabled: true,
      physicalSirenEnabled: true,
      fullscreenEnabled: true,
    },
  });

  assert.ok(result);
  assert.equal(result.alarm.repeatMinutes, 15);
});

test("ma trận ưu tiên Alarm đúng Nguy hiểm > Mode Bảo vệ > lịch", () => {
  const { api } = createAlarmRuntime();
  const activeSchedule = {
    alarm: {
      repeatMinutes: 15,
    },
  };

  const emergencyNormal = api.resolveAlarmActivationPriority({
    deviceType: "smoke",
    homeMode: "normal",
    policyEnabled: false,
  });
  assert.equal(emergencyNormal.active, true);
  assert.equal(emergencyNormal.flowType, "emergency");
  assert.equal(emergencyNormal.source, "emergency_sensor");

  const emergencyArmed = api.resolveAlarmActivationPriority({
    deviceType: "sos",
    homeMode: "armed",
    activeSchedule,
  });
  assert.equal(emergencyArmed.active, true);
  assert.equal(emergencyArmed.source, "emergency_sensor");

  const emergencyUnprotected = api.resolveAlarmActivationPriority({
    deviceType: "smoke",
    homeMode: "unprotected",
  });
  assert.equal(emergencyUnprotected.active, false);
  assert.equal(emergencyUnprotected.reason, "home_unprotected");

  const armedSecurity = api.resolveAlarmActivationPriority({
    deviceType: "door",
    homeMode: "armed",
    policyEnabled: true,
    activeSchedule: null,
    alarmPaused: true,
    modeRepeatMinutes: 30,
  });
  assert.equal(armedSecurity.active, true);
  assert.equal(armedSecurity.source, "security_mode");
  assert.equal(armedSecurity.repeatMinutes, 30);

  const scheduledSecurity = api.resolveAlarmActivationPriority({
    deviceType: "door",
    homeMode: "normal",
    policyEnabled: true,
    activeSchedule,
    alarmPaused: false,
  });
  assert.equal(scheduledSecurity.active, true);
  assert.equal(scheduledSecurity.source, "scheduled_alarm");
  assert.equal(scheduledSecurity.repeatMinutes, 15);

  const pausedSchedule = api.resolveAlarmActivationPriority({
    deviceType: "door",
    homeMode: "normal",
    policyEnabled: true,
    activeSchedule,
    alarmPaused: true,
  });
  assert.equal(pausedSchedule.active, false);
  assert.equal(pausedSchedule.reason, "alarm_paused");

  const normalWithoutSchedule = api.resolveAlarmActivationPriority({
    deviceType: "door",
    homeMode: "normal",
    policyEnabled: true,
    activeSchedule: null,
  });
  assert.equal(normalWithoutSchedule.active, false);
  assert.equal(normalWithoutSchedule.reason, "alarm_schedule_inactive");
});

test("thiết bị Nguy hiểm không thể bị tắt tham gia Alarm bằng alarmPolicy", () => {
  const { api } = createAlarmRuntime();
  const policy = api.normalizeDeviceAlarmPolicy(
    {
      alarmPolicy: {
        enabled: false,
        notificationEnabled: false,
        physicalSirenEnabled: false,
        fullscreenEnabled: false,
      },
    },
    "smoke",
  );

  assert.equal(policy.enabled, true);
  assert.equal(policy.notificationEnabled, false);
  assert.equal(policy.physicalSirenEnabled, false);
  assert.equal(policy.fullscreenEnabled, false);
});

test("lịch bắt đầu với sensor đã không an toàn buộc gửi lần đầu và fullscreen", () => {
  const schedulerSource = extractFunctionSource("checkScheduledAlarms");
  const incidentSource = extractAlarmIncidentPersistenceFunctionSource(
    "startOrMergeAlarmIncidents",
  );
  const initSource = extractFunctionSource("init");

  assert.match(
    schedulerSource,
    /firstOccurrence[\s\S]*?bypassEventControl:\s*true[\s\S]*?forceSecurityRedelivery:\s*true/,
  );
  assert.match(
    schedulerSource,
    /repeatMinutes\s*===\s*0\s*&&\s*!firstOccurrence/,
  );
  assert.match(
    incidentSource,
    /forcedRedeliveryItems[\s\S]*?allowFullscreenRedelivery:/,
  );
  assert.match(initSource, /checkScheduledAlarms\(\{ reason: "interval" \}\)/);
  assert.match(initSource, /},\s*10000\);/);
});

test("Mode Không bảo vệ im lặng hoàn toàn và chặn Emergency ở điểm gửi cuối", () => {
  const sensorSource = extractFunctionSource(
    "processSensorEventThroughAlarmEngine",
  );
  const sendSource = extractFunctionSource("sendAlarmStageSummary");
  const advanceSource = extractAlarmIncidentLifecycleFunctionSource(
    "advanceAlarmIncidentToStage",
  );

  assert.doesNotMatch(sensorSource, /sendUnprotectedSensorNotification/);
  assert.match(sensorSource, /SENSOR ALARM SUPPRESSED/);
  assert.match(
    sendSource,
    /isEmergency[\s\S]*?isAlarmItemAllowedByCurrentHomeMode/,
  );
  assert.match(
    advanceSource,
    /allowedEmergencyItems[\s\S]*?isAlarmItemAllowedByCurrentHomeMode/,
  );
});

test("startup Bình thường khôi phục Emergency và lịch đang hoạt động", () => {
  const listenerSource = extractFunctionSource(
    "attachSecurityModeHomeListener",
  );
  const emergencySource = extractFunctionSource(
    "triggerEmergencyForCurrentUnsafeState",
  );

  assert.match(listenerSource, /startup_normal_recheck/);
  assert.match(listenerSource, /triggerEmergencyForCurrentUnsafeState/);
  assert.match(
    emergencySource,
    /bypassEventControl:\s*true/,
  );
});

test("rời Không bảo vệ chỉ phát lại SOS trong 60 giây gần nhất", () => {
  const now = localTime(2026, 6, 20, 12, 0);
  const runtime = createAlarmRuntime(now);
  const { api } = runtime;
  const cutoffAt = now - api.UNPROTECTED_TRANSIENT_REPLAY_WINDOW_MS;

  assert.match(
    api.getCurrentEmergencyReason(
      "SOS",
      "sos",
      {
        last_triggered: now - 59 * 1000,
        sos_active_until: now + 4 * 60 * 1000,
      },
      { transientEventCutoffAt: cutoffAt },
    ),
    /SOS được kích hoạt/,
  );

  assert.equal(
    api.getCurrentEmergencyReason(
      "SOS",
      "sos",
      {
        last_triggered: now - 61 * 1000,
        sos_active_until: now + 4 * 60 * 1000,
      },
      { transientEventCutoffAt: cutoffAt },
    ),
    "",
  );

  // Trạng thái nguy hiểm liên tục không bị giới hạn bởi tuổi sự kiện.
  assert.match(
    api.getCurrentEmergencyReason(
      "Báo khói",
      "smoke",
      { smoke: true },
      { transientEventCutoffAt: cutoffAt },
    ),
    /Phát hiện khói/,
  );
});

test("Bình thường startup vẫn giữ cửa sổ Emergency hiện có", () => {
  const now = localTime(2026, 6, 20, 12, 0);
  const runtime = createAlarmRuntime(now);

  assert.match(
    runtime.api.getCurrentEmergencyReason(
      "SOS",
      "sos",
      { last_triggered: now - 4 * 60 * 1000 },
    ),
    /SOS được kích hoạt/,
  );
});

test("listener truyền cutoff 60 giây khi Không bảo vệ về Bình thường", () => {
  const source = extractFunctionSource(
    "attachSecurityModeHomeListener",
  );

  assert.match(
    source,
    /previousMode === "unprotected"[\s\S]*?Date\.now\(\) - UNPROTECTED_TRANSIENT_REPLAY_WINDOW_MS/,
  );
  assert.match(
    source,
    /triggerEmergencyForCurrentUnsafeState\([\s\S]*?transientEventCutoffAt/,
  );
});

test("MQTT lặp lại cùng trạng thái không tự tạo Alarm không rõ lý do", () => {
  const { api } = createAlarmRuntime();

  assert.equal(
    api.buildAlarmTriggerFromSensorEvent({
      deviceType: "door",
      deviceName: "Cửa chính",
      oldDevice: { contact: false },
      updateData: { contact: false },
    }),
    null,
  );
  assert.equal(
    api.buildAlarmTriggerFromSensorEvent({
      deviceType: "smoke",
      deviceName: "Khói bếp",
      oldDevice: { smoke: true },
      updateData: { smoke: true },
    }),
    null,
  );

  const opened = api.buildAlarmTriggerFromSensorEvent({
    deviceType: "door",
    deviceName: "Cửa chính",
    oldDevice: { contact: true },
    updateData: { contact: false },
  });

  assert.equal(opened?.category, "security");
  assert.match(opened?.reason || "", /Cửa chính/);
});

test("offline Alarm dùng lại đúng ma trận ưu tiên trước khi giữ còi", () => {
  const unsafeSource = extractFunctionSource(
    "isOfflineAlarmDemandStillUnsafe",
  );
  const activateSource = extractFunctionSource(
    "activateOfflineAlarmDemand",
  );
  const reconcileSource = extractFunctionSource(
    "reconcileOfflineAlarmDemandsForHome",
  );

  assert.match(unsafeSource, /resolveAlarmActivationPriority/);
  assert.match(unsafeSource, /resolveActiveDeviceSchedule/);
  assert.match(unsafeSource, /isAlarmPauseActiveFromData/);
  assert.match(
    activateSource,
    /await isOfflineAlarmDemandStillUnsafe\(demand\)/,
  );
  assert.match(
    reconcileSource,
    /await isOfflineAlarmDemandStillUnsafe\(demand\)/,
  );
});

test("bàn giao Mode sang lịch xoá timer báo lại theo Mode cũ", () => {
  const validateSource = extractFunctionSource(
    "validateAndResolveSecurityIncident",
  );
  const repeatSource = extractFunctionSource(
    "ensureSecurityModeRepeatForIncident",
  );

  assert.match(
    validateSource,
    /ensureSecurityModeRepeatForIncident/,
  );
  assert.match(
    repeatSource,
    /clearSecurityModeRepeatTimer\(receiverUid, incidentId\)/,
  );
  assert.match(repeatSource, /repeatMinutes:\s*0/);
  assert.match(repeatSource, /nextRepeatAt:\s*null/);
});

test("cùng thiết bị + cùng event bị chặn 60 giây, event khác không bị chặn", () => {
  const runtime = createAlarmRuntime(localTime(2026, 6, 20, 22, 0));
  const { api } = runtime;
  const base = {
    receiverUid: "member-a",
    ownerUid: "owner-a",
    homeId: "home-a",
    deviceId: "door-a",
    deviceType: "door",
    reason: "Cửa chính: đang mở",
  };

  assert.equal(api.shouldAcceptSensorAlarmTrigger(base), true);
  assert.equal(api.shouldAcceptSensorAlarmTrigger(base), false);

  assert.equal(
    api.shouldAcceptSensorAlarmTrigger({
      ...base,
      deviceId: "door-b",
    }),
    true,
  );
  assert.equal(
    api.shouldAcceptSensorAlarmTrigger({
      ...base,
      reason: "Cửa chính: Thiết bị bị tháo",
    }),
    true,
  );

  runtime.advance(api.SAME_ALARM_EVENT_MIN_INTERVAL_MS - 1);
  assert.equal(api.shouldAcceptSensorAlarmTrigger(base), false);

  runtime.advance(1);
  assert.equal(api.shouldAcceptSensorAlarmTrigger(base), true);
});

test("mã sự kiện phân biệt mở cửa, tháo thiết bị và khẩn cấp", () => {
  const { api } = createAlarmRuntime();

  assert.equal(api.getSensorAlarmEventCode("door", "đang mở"), "door:open");
  assert.equal(
    api.getSensorAlarmEventCode("door", "Thiết bị bị tháo"),
    "door:tamper",
  );
  assert.equal(api.getSensorAlarmEventCode("smoke", "khói"), "smoke:active");
  assert.equal(api.getSensorAlarmEventCode("sos", "nhấn"), "sos:pressed");
});

test("owned-home signature bỏ qua alarm cấp nhà nhưng vẫn theo dõi lịch thiết bị", () => {
  const context = vm.createContext({
    JSON,
    Number,
    Object,
    String,
    normalizeSecurityModeRepeatMinutes:
      alarmSchedule.normalizeSecurityModeRepeatMinutes,
    normalizeHomeSecurityMode:
      sensorAlarmEngine.normalizeHomeSecurityMode,
  });
  const setupSource = [
    extractFunctionSource("getOwnedHomeAlarmControlSignature"),
    "this.__getOwnedHomeAlarmControlSignature = getOwnedHomeAlarmControlSignature;",
  ].join("\n\n");

  vm.runInContext(setupSource, context, {
    filename: "owned_home_alarm_control_signature.vm.js",
  });

  const getSignature = context.__getOwnedHomeAlarmControlSignature;
  const baseHome = {
    alarm: { enabled: true },
    schedules: {
      alarms: {
        legacy: { enabled: true },
      },
    },
    devices: {
      doorA: {
        alarmSchedules: {
          night: {
            enabled: true,
            start: "22:00",
            end: "06:00",
          },
        },
      },
      sirenA: {
        type: "siren",
        alarm: false,
      },
    },
  };
  const originalSignature = getSignature(baseHome);

  assert.equal(
    getSignature({
      ...baseHome,
      alarm: { enabled: false },
    }),
    originalSignature,
  );
  assert.equal(
    getSignature({
      ...baseHome,
      schedules: {
        alarms: {
          legacy: { enabled: false },
        },
      },
    }),
    originalSignature,
  );
  assert.equal(
    getSignature({
      ...baseHome,
      devices: {
        ...baseHome.devices,
        sirenA: {
          ...baseHome.devices.sirenA,
          alarm: true,
        },
      },
    }),
    originalSignature,
  );
  assert.notEqual(
    getSignature({
      ...baseHome,
      devices: {
        doorA: {
          alarmSchedules: {
            night: {
              enabled: true,
              start: "23:00",
              end: "06:00",
            },
          },
        },
      },
    }),
    originalSignature,
  );
});

test("receiver Alarm signature bỏ qua mode và alarmMode", () => {
  const context = vm.createContext({ JSON, Object });
  const setupSource = [
    extractFunctionSource("getReceiverHomeAlarmControlSignature"),
    "this.__getReceiverHomeAlarmControlSignature = getReceiverHomeAlarmControlSignature;",
  ].join("\n\n");

  vm.runInContext(setupSource, context, {
    filename: "receiver_home_alarm_control_signature.vm.js",
  });

  const getSignature = context.__getReceiverHomeAlarmControlSignature;
  const baseAccount = {
    customRules: {
      homeA: {
        mode: "home",
        alarmMode: "home",
        devices: {
          doorA: {
            alarm: {
              enabled: true,
              start: "22:00",
              end: "06:00",
            },
            alarmSchedules: {
              night: {
                enabled: true,
              },
            },
            alarmPreferences: {
              followHomeSchedule: true,
            },
          },
        },
      },
    },
  };
  const originalSignature = getSignature(baseAccount, "homeA");
  const accountWithoutAlarmMode = structuredClone(baseAccount);
  delete accountWithoutAlarmMode.customRules.homeA.alarmMode;
  const modeSignature = getSignature(
    accountWithoutAlarmMode,
    "homeA",
  );
  const modeChanged = structuredClone(accountWithoutAlarmMode);
  const alarmModeChanged = structuredClone(baseAccount);
  const legacyAlarmChanged = structuredClone(baseAccount);
  const schedulesChanged = structuredClone(baseAccount);
  const preferencesChanged = structuredClone(baseAccount);

  modeChanged.customRules.homeA.mode = "custom";
  alarmModeChanged.customRules.homeA.alarmMode = "custom";
  legacyAlarmChanged.customRules.homeA.devices.doorA.alarm.enabled = false;
  schedulesChanged.customRules.homeA.devices.doorA
    .alarmSchedules.night.enabled = false;
  preferencesChanged.customRules.homeA.devices.doorA
    .alarmPreferences.followHomeSchedule = false;

  assert.equal(getSignature(modeChanged, "homeA"), modeSignature);
  assert.equal(getSignature(alarmModeChanged, "homeA"), originalSignature);
  assert.equal(
    getSignature(legacyAlarmChanged, "homeA"),
    originalSignature,
  );
  assert.notEqual(
    getSignature(schedulesChanged, "homeA"),
    originalSignature,
  );
  assert.notEqual(
    getSignature(preferencesChanged, "homeA"),
    originalSignature,
  );
});

test("Alarm Engine không còn đọc device.alarm như lịch legacy", () => {
  const collectionSource = ALARM_SCHEDULE_SOURCE;
  const resolveSource = extractFunctionSource(
    "resolveDeviceAlarmConfigurationForReceiver",
  );
  const pauseSource = extractFunctionSource(
    "doesPauseOverlapEnabledAlarm",
  );

  assert.doesNotMatch(collectionSource, /legacyAlarm/);
  assert.doesNotMatch(resolveSource, /customDevice\?\.alarm(?![A-Za-z])/);
  assert.doesNotMatch(resolveSource, /legacyAlarm:\s*device\?\.alarm/);
  assert.doesNotMatch(pauseSource, /legacyAlarm:\s*device\?\.alarm/);
});

test("logic còi vật lý vẫn đọc device.alarm làm trạng thái actuator", () => {
  const cachedReportSource = extractPhysicalSirenFunctionSource(
    "getCachedHomeSirenReport",
  );
  const waitOffSource = extractPhysicalSirenFunctionSource(
    "waitForHomeSirenReportedOff",
  );

  assert.match(cachedReportSource, /device\.alarm/);
  assert.match(waitOffSource, /device\.alarm/);
});


test("MQTT nhận lệnh không được tự biến còi thành đang kêu", () => {
  const source = extractPhysicalSirenFunctionSource("setPhysicalSirenForHome");

  assert.match(source, /waitForHomeSirenReportedOn/);
  assert.match(source, /commandStatus:\s*"on_command_sent"/);
  assert.doesNotMatch(
    source,
    /alarmOn:\s*true[\s\S]*?on_command_accepted/,
  );
  assert.match(source, /status:\s*"devices_offline"/);
});

test("còi chỉ được xác nhận bật sau packet trạng thái thật", () => {
  const reachableSource = extractPhysicalSirenFunctionSource(
    "isHomeSirenDeviceReachable",
  );
  const waitOnSource = extractPhysicalSirenFunctionSource(
    "waitForHomeSirenReportedOn",
  );

  assert.match(
    reachableSource,
    /isSystemHealthExplicitlyOffline\(availability\)/,
  );
  assert.match(waitOnSource, /report\.alarmOn === true/);
  assert.match(
    waitOnSource,
    /report\.reportedAt >= commandStartedAt/,
  );
  assert.match(waitOnSource, /device\.last_siren_report_at/);
});

test("Reminder chỉ dùng reminderMode rồi fallback home", () => {
  const source = extractFunctionSource("checkScheduledNotifications");

  assert.match(
    source,
    /const reminderMode = String\(\s*customHomeRules\.reminderMode \|\| "home",\s*\);/,
  );
  assert.doesNotMatch(source, /customHomeRules\.mode/);
});


test("Reminder dùng last_seen làm nguồn chính thay vì availability offline sớm", () => {
  const now = new Date("2026-07-23T00:00:00.000Z").getTime();
  const { evaluateDeviceSystemHealth } = createSystemHealthDomain({
    db: {
      ref: () => ({
        update: async () => {},
      }),
    },
    getFirebaseConnected: () => false,
    getAccountsEntries: () => [],
    addHomeNotificationToHomeRecipients: async () => {},
    normalizeLockState: () => "unknown",
    isActiveSignal: () => false,
    isSecurityDeviceType: () => true,
    isEmergencyDeviceType: () => true,
    now: () => now,
    startedAt: 0,
  });

  const freshSmoke = evaluateDeviceSystemHealth(
    "smokeA",
    {
      type: "smoke",
      name: "Báo khói",
      availability: "offline",
      last_seen: now - 2 * 60 * 60 * 1000,
    },
    now,
  );

  assert.equal(
    freshSmoke.some((issue) => issue.code === "device_offline"),
    false,
  );

  const staleSmoke = evaluateDeviceSystemHealth(
    "smokeA",
    {
      type: "smoke",
      name: "Báo khói",
      availability: "online",
      last_seen: now - 32 * 60 * 60 * 1000,
    },
    now,
  );

  assert.equal(
    staleSmoke.some((issue) => issue.code === "device_offline"),
    true,
  );

  const noTimestamp = evaluateDeviceSystemHealth(
    "sosA",
    {
      type: "sos",
      name: "SOS",
      availability: "offline",
    },
    now,
  );

  assert.equal(
    noTimestamp.some((issue) => issue.code === "device_offline"),
    true,
  );
});

test("Reminder có APNs alert để iOS hiện khi app background hoặc đã tắt", () => {
  const source = extractFunctionSource("sendScheduledReminderSummary");

  assert.match(source, /apns:\s*\{/);
  assert.match(source, /"apns-priority":\s*"10"/);
  assert.match(source, /alert:\s*\{\s*title,\s*body,/);
  assert.match(source, /category:\s*"SAFEHOME_REMINDER"/);
});

test("Kiểm tra nhà chỉ xác nhận incident của đúng tài khoản", () => {
  const source = extractFunctionSource(
    "acknowledgeAlarmIncidentForReceiver",
  );

  assert.match(
    source,
    /accounts\/\$\{cleanReceiverUid\}\/alarmIncidents\/\$\{cleanIncidentId\}/,
  );
  assert.match(source, /uid:\s*cleanReceiverUid/);
  assert.doesNotMatch(source, /resolveAlarmIncidentGroupForHome/);
  assert.doesNotMatch(source, /getAlarmReceiverUidsForHome/);
});

test("chu kỳ lặp không gọi lại kênh fullscreen", () => {
  const source = extractFunctionSource("handleSecurityModeRepeatDue");

  assert.match(source, /sendAlarmStageSummary/);
  assert.match(source, /requestPhysicalSirenForIncident/);
  assert.doesNotMatch(source, /deliverSecurityAlarmChannelsImmediately/);
  assert.doesNotMatch(source, /fullscreenEnabled/);
});

test("đã xem fullscreen không được hủy lịch notification báo lại", () => {
  const acknowledgeSource = extractFunctionSource(
    "acknowledgeAlarmIncidentForReceiver",
  );
  const repeatSource = extractFunctionSource(
    "handleSecurityModeRepeatDue",
  );

  assert.match(
    acknowledgeSource,
    /normalizeSecurityModeRepeatMinutes\(incident\.repeatMinutes\)/,
  );
  assert.match(acknowledgeSource, /scheduleSecurityModeRepeatTimer/);
  assert.doesNotMatch(acknowledgeSource, /nextRepeatAt:\s*null/);
  assert.match(
    repeatSource,
    /const repeatNotificationItems = repeatedItems\.filter/,
  );
  assert.doesNotMatch(
    repeatSource,
    /presentationSuppressedAt[\s\S]{0,160}\? \[\]/,
  );
});


test("Mode Bảo vệ về Bình thường bàn giao incident sang lịch đang hoạt động", async () => {
  const activeSchedule = {
    source: "home_schedule",
    alarm: {
      repeatMinutes: 15,
    },
  };
  const context = vm.createContext({
    String,
    Object,
    normalizeHomeSecurityMode(value) {
      const mode = String(value || "").trim().toLowerCase();
      return mode === "armed" || mode === "unprotected"
        ? mode
        : "normal";
    },
    getIncidentDeviceContext() {
      return {
        deviceId: "doorA",
        device: {
          type: "door",
          contact: false,
        },
      };
    },
    async resolveDeviceAlarmConfigurationForReceiver() {
      return {
        marker: "configuration",
        policy: {
          enabled: true,
        },
      };
    },
    isAlarmPauseActiveFromData() {
      return false;
    },
    resolveActiveDeviceSchedule() {
      return activeSchedule;
    },
    resolveAlarmActivationPriority({
      homeMode,
      activeSchedule: schedule,
      policyEnabled,
      modeRepeatMinutes,
    }) {
      if (homeMode === "unprotected") {
        return { active: false, reason: "home_unprotected" };
      }
      if (policyEnabled !== true) {
        return { active: false, reason: "device_alarm_disabled" };
      }
      if (homeMode === "armed") {
        return {
          active: true,
          source: "security_mode",
          repeatMinutes: Number(modeRepeatMinutes || 0),
        };
      }
      return schedule
        ? { active: true, source: "scheduled_alarm", repeatMinutes: 15 }
        : { active: false, reason: "alarm_schedule_inactive" };
    },
    normalizeSecurityModeRepeatMinutes(value) {
      return Number(value || 0);
    },
    getScheduleAlarmKey() {
      return "schedule-key";
    },
    lastScheduleAlarmMap: {},
    Date,
    activeSchedule,
  });

  vm.runInContext(
    `${extractFunctionSource("isSecurityIncidentSourceActive")}
     this.__isSecurityIncidentSourceActive = isSecurityIncidentSourceActive;`,
    context,
    { filename: "security_mode_schedule_handoff.vm.js" },
  );

  const handedOff = await context.__isSecurityIncidentSourceActive({
    receiverUid: "memberA",
    ownerUid: "ownerA",
    homeId: "homeA",
    item: {
      alarmSource: "security_mode",
      deviceId: "doorA",
    },
    home: {
      securityMode: "normal",
    },
    receiverAccount: {},
  });

  assert.equal(handedOff.active, true);
  assert.equal(handedOff.normalizedSource, "scheduled_alarm");
  assert.equal(handedOff.activeSchedule, activeSchedule);
  assert.equal(handedOff.configuration.marker, "configuration");

  context.resolveActiveDeviceSchedule = () => null;

  const noSchedule = await context.__isSecurityIncidentSourceActive({
    receiverUid: "memberA",
    ownerUid: "ownerA",
    homeId: "homeA",
    item: {
      alarmSource: "security_mode",
      deviceId: "doorA",
    },
    home: {
      securityMode: "normal",
    },
    receiverAccount: {},
  });

  assert.equal(noSchedule.active, false);
  assert.equal(noSchedule.reason, "alarm_schedule_inactive");

  context.isAlarmPauseActiveFromData = () => true;

  const armedOverride = await context.__isSecurityIncidentSourceActive({
    receiverUid: "memberA",
    ownerUid: "ownerA",
    homeId: "homeA",
    item: {
      alarmSource: "scheduled_alarm",
      deviceId: "doorA",
    },
    home: {
      securityMode: "armed",
      securityModeRepeatMinutes: 30,
      alarmPauseToday: { active: true },
    },
    receiverAccount: {},
  });

  assert.equal(armedOverride.active, true);
  assert.equal(armedOverride.normalizedSource, "security_mode");
  assert.equal(armedOverride.modeRepeatMinutes, 30);
});

test("Mode Bảo vệ tự động giữ fullscreen theo cấu hình người nhận", () => {
  const realtimeSource = extractFunctionSource(
    "processSensorEventThroughAlarmEngine",
  );
  const offlineSource = extractFunctionSource(
    "resumeOfflineAlarmDemandsFromSnapshot",
  );

  assert.match(
    realtimeSource,
    /fullscreenEnabled:\s*isEmergency\s*\|\|\s*activation\.source\s*===\s*"security_mode"[\s\S]*?\?\s*alarmConfiguration\.fullscreenEnabled/,
  );
  assert.match(
    offlineSource,
    /fullscreenEnabled:[\s\S]*?isEmergency\s*\|\|\s*activation\.source\s*===\s*"security_mode"[\s\S]*?\?\s*configuration\.fullscreenEnabled/,
  );
  assert.doesNotMatch(
    realtimeSource,
    /fullscreenEnabled:[\s\S]{0,120}activation\.source\s*===\s*"security_mode"[\s\S]{0,80}\?\s*false/,
  );
  assert.doesNotMatch(
    offlineSource,
    /fullscreenEnabled:[\s\S]{0,180}activation\.source\s*===\s*"security_mode"[\s\S]{0,80}\?\s*false/,
  );
});

test("sự kiện cảm biến hợp lệ đi thẳng vào Alarm Engine, không gom chờ", () => {
  const source = extractFunctionSource("queueEventAlarm");

  assert.match(source, /startOrMergeAlarmIncidents/);
  assert.doesNotMatch(source, /setTimeout/);
  assert.doesNotMatch(source, /pendingEventAlarm/);
});


test("Reminder debug mặc định bị tắt và chỉ bật bằng biến môi trường", () => {
  const source = extractFunctionSource("checkScheduledNotifications");
  const debugConst = extractConstSource("REMINDER_DEBUG_ENABLED");

  assert.match(debugConst, /MAIYEN_REMINDER_DEBUG/);
  assert.match(debugConst, /SAFEHOME_REMINDER_DEBUG/);
  assert.match(source, /if \(REMINDER_DEBUG_ENABLED\)/);
  assert.match(source, /REMINDER DEBUG/);
});

test("pair thiết bị an ninh mới chỉ tạo alarmPolicy và alarmSchedules", () => {
  const marker = "await db.ref(`accounts/${uid}/homes/${homeId}/devices/${ieee}`).set({";
  const start = INDEX_SOURCE.indexOf(marker);
  const end = INDEX_SOURCE.indexOf(
    "await db.ref(`system/devices_by_ieee/${ieee}`).set({",
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = INDEX_SOURCE.slice(start, end);

  assert.match(source, /alarmPolicy:\s*isSecurityDeviceType\(deviceType\)/);
  assert.match(source, /alarmSchedules:\s*isSecurityDeviceType\(deviceType\)/);
  assert.match(source, /default:\s*\{/);
  assert.doesNotMatch(
    source,
    /alarm:\s*deviceType === "siren"[\s\S]*?isSecurityDeviceType/,
  );
});

test("cấu hình Alarm đã resolve không còn alias legacy", async () => {
  const { api } = createAlarmRuntime();
  const configuration = await api.resolveDeviceAlarmConfigurationForReceiver(
    "ownerA",
    "homeA",
    "doorA",
    {
      _ownerUid: "ownerA",
      devices: {
        doorA: {
          type: "door",
          alarmSchedules: {},
        },
      },
    },
    { customRules: {} },
    "ownerA",
  );

  assert.equal(Object.hasOwn(configuration, "homeAlarm"), false);
  assert.equal(Object.hasOwn(configuration, "personalAlarm"), false);
});

test("log còi periodic được giới hạn nhưng thay đổi trạng thái vẫn log ngay", () => {
  const source = extractPhysicalSirenFunctionSource(
    "shouldLogHomeSirenResult",
  );

  assert.match(
    PHYSICAL_SIREN_SOURCE,
    /HOME_SIREN_PERIODIC_LOG_INTERVAL_MS\s*=\s*5 \* 60 \* 1000/,
  );
  assert.match(source, /reason === "periodic_reconcile"/);
  assert.match(source, /previous\.signature !== signature/);
  assert.match(
    source,
    /now - Number\(previous\.loggedAt \|\| 0\) >=/,
  );
});

test("startup cho phép còi đủ thời gian xác nhận trước khi báo deferred", () => {
  const source = extractFunctionSource("init");

  assert.match(
    source,
    /"PHYSICAL SIREN STARTUP RECONCILE"[\s\S]*?15 \* 1000/,
  );
});

test("chuyển normal sang armed tái kích hoạt trạng thái nguy hiểm đang bị latch", () => {
  const transitionSource = extractFunctionSource(
    "triggerAlarmForUnsafeStateOnArmed",
  );
  const startSource = extractAlarmIncidentPersistenceFunctionSource(
    "startOrMergeAlarmIncidents",
  );

  assert.match(
    transitionSource,
    /startOrMergeAlarmIncidents\([\s\S]*?bypassEventControl:\s*true/,
  );
  assert.match(
    startSource,
    /bypassEventControl\s*\?\s*normalizeAlarmIncidentItems\(groupedItems\)/,
  );
});

test("Mode Bảo vệ tạo cấu hình fullscreen riêng cho từng thành viên", () => {
  const source = extractFunctionSource(
    "triggerAlarmForUnsafeStateOnArmed",
  );

  assert.match(
    source,
    /resolveDeviceAlarmConfigurationForReceiver\([\s\S]*?receiverUid/,
  );
  assert.match(
    source,
    /fullscreenEnabled:\s*configuration\.fullscreenEnabled/,
  );
  assert.match(
    source,
    /notificationEnabled:\s*policy\.notificationEnabled/,
  );
});

test("Mode Bảo vệ tạo presentation mới thay vì tái dùng incident cũ", () => {
  const helperSource = extractFunctionSource(
    "supersedeSecurityIncidentForModeArming",
  );
  const transitionSource = extractFunctionSource(
    "triggerAlarmForUnsafeStateOnArmed",
  );

  assert.match(helperSource, /status`\]:\s*\n\s*"superseded"/);
  assert.match(helperSource, /security_mode_rearmed/);
  assert.match(helperSource, /activeAlarmIncidentByTarget/);
  assert.match(
    transitionSource,
    /sendAlarmResolvedPush\([\s\S]*?hasRemainingActiveIncidents:\s*true/,
  );
});

test("Auto Away cũ chưa có participantUids vẫn dùng toàn bộ thành viên", () => {
  const context = {};

  vm.runInNewContext(
    `${extractAutoAwayFunctionSource("asObject")}\n` +
      `${extractAutoAwayFunctionSource("resolveAutoAwayParticipantSelection")}\n` +
      "this.resolveSelection = resolveAutoAwayParticipantSelection;",
    context,
  );

  const result = context.resolveSelection(
    { enabled: true },
    new Set(["owner", "admin", "member"]),
    "owner",
  );

  assert.deepEqual(
    [...result.participantUids],
    ["admin", "member", "owner"],
  );
  assert.equal(result.hasExplicitSelection, false);
  assert.equal(result.needsNormalization, false);
});

test("Auto Away chỉ dùng những thành viên được chọn còn thuộc nhà", () => {
  const context = {};

  vm.runInNewContext(
    `${extractAutoAwayFunctionSource("asObject")}\n` +
      `${extractAutoAwayFunctionSource("resolveAutoAwayParticipantSelection")}\n` +
      "this.resolveSelection = resolveAutoAwayParticipantSelection;",
    context,
  );

  const result = context.resolveSelection(
    {
      participantUids: {
        admin: true,
        member: true,
        removed_member: true,
      },
    },
    new Set(["owner", "admin", "member", "unselected"]),
    "owner",
  );

  assert.deepEqual(
    [...result.participantUids],
    ["admin", "member"],
  );
  assert.equal(result.participantSet.has("unselected"), false);
  assert.equal(result.needsNormalization, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.normalizedMap)),
    { admin: true, member: true },
  );
});

test("Auto Away fallback Owner khi toàn bộ người được chọn đã rời nhà chia sẻ", () => {
  const context = {};

  vm.runInNewContext(
    `${extractAutoAwayFunctionSource("asObject")}\n` +
      `${extractAutoAwayFunctionSource("resolveAutoAwayParticipantSelection")}\n` +
      "this.resolveSelection = resolveAutoAwayParticipantSelection;",
    context,
  );

  const result = context.resolveSelection(
    {
      participantUids: {
        removed_member: true,
      },
    },
    new Set(["owner", "member"]),
    "owner",
  );

  assert.deepEqual([...result.participantUids], ["owner"]);
  assert.equal(result.needsNormalization, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.normalizedMap)),
    { owner: true },
  );
});

test("Auto Away chỉ dùng participantUids cho quyết định bật và tắt Mode", () => {
  const source = extractAutoAwayFunctionSource("checkAutoAwayHomes");

  assert.match(
    source,
    /autoAwayParticipant:\s*\n?\s*participantSet\.has\(memberUid\)/,
  );
  assert.match(
    source,
    /if \(!participantSet\.has\(memberUid\)\) \{\s*continue;\s*\}/,
  );

  const participantGuards =
    source.match(/!participantSet\.has\(memberUid\)/g) || [];

  // Một guard cho phép tính bật Mode và hai guard cho luồng người trở về.
  assert.ok(participantGuards.length >= 3);
});

test("Presence Summary tách riêng trạng thái nhóm thành viên Auto Away được chọn", () => {
  const context = {};

  vm.runInNewContext(
    `${extractAutoAwayFunctionSource("buildPresenceSummary")}\n` +
      "this.buildSummary = buildPresenceSummary;",
    context,
  );

  const summary = context.buildSummary({
    totalMemberCount: 5,
    participantCount: 3,
    participantInsideCount: 1,
    participantOutsideCount: 1,
    participantUnknownCount: 1,
    signedInCount: 4,
    onlineCount: 4,
    connectedCount: 3,
    memberCount: 5,
    eligibleMemberCount: 2,
    excludedCount: 1,
    insideCount: 2,
    outsideCount: 2,
    unknownCount: 1,
    knownLocationCount: 4,
    armingInsideCount: 1,
    armingOutsideCount: 1,
    armingUnknownCount: 0,
    unavailableCount: 1,
    now: 123456789,
  });

  assert.equal(summary.totalMemberCount, 5);
  assert.equal(summary.participantCount, 3);
  assert.equal(summary.participantInsideCount, 1);
  assert.equal(summary.participantOutsideCount, 1);
  assert.equal(summary.participantUnknownCount, 1);
  assert.equal(
    summary.participantInsideCount +
      summary.participantOutsideCount +
      summary.participantUnknownCount,
    summary.participantCount,
  );

  const source = extractAutoAwayFunctionSource("checkAutoAwayHomes");
  assert.match(source, /const participantStatuses = Object\.entries\(/);
  assert.match(source, /participantSet\.has\(memberUid\)/);
  assert.match(source, /participantInsideCount/);
  assert.match(source, /participantOutsideCount/);
  assert.match(source, /participantUnknownCount/);
});

test("notification báo lại chỉ giữ điều kiện vẫn còn nguy hiểm", () => {
  const context = vm.createContext({
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    JSON,
    Math,
    normalizeRepeatMinutes: alarmSchedule.normalizeRepeatMinutes,
  });

  const source = [
    extractAlarmIncidentFunctionSource("getAlarmIncidentItemIdentity"),
    extractAlarmIncidentFunctionSource("normalizeAlarmIncidentItems"),
    extractAlarmIncidentFunctionSource("getSecurityAlarmSourcePriority"),
    extractAlarmIncidentFunctionSource("getSecurityAlarmConditionIdentity"),
    extractAlarmIncidentFunctionSource("normalizePreferredSecurityIncidentItems"),
    extractAlarmIncidentFunctionSource("filterCurrentSecurityAlarmDeliveryItems"),
    "this.__filter = filterCurrentSecurityAlarmDeliveryItems;",
  ].join("\n\n");

  vm.runInContext(source, context, {
    filename: "alarm_repeat_current_items.vm.js",
  });

  const openDoor = {
    ownerUid: "owner",
    homeId: "home",
    deviceId: "door",
    deviceName: "Cửa chính",
    type: "door",
    reason: "Cửa chính: Cửa đang mở",
    alarmSource: "security_mode",
    notificationEnabled: true,
  };
  const unlockedDoor = {
    ownerUid: "owner",
    homeId: "home",
    deviceId: "lock",
    deviceName: "Khóa cửa",
    type: "door_lock",
    reason: "Khóa cửa: Khóa đang mở",
    alarmSource: "security_mode",
    notificationEnabled: true,
  };

  const result = context.__filter(
    [openDoor, unlockedDoor],
    [openDoor],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].deviceId, "door");
  assert.equal(result[0].reason, openDoor.reason);
});

test("mọi notification Alarm được đối chiếu incident mới nhất trước khi gửi", () => {
  const source = extractFunctionSource("sendAlarmStageSummary");

  assert.match(
    source,
    /stage === "alarm" && incidentId/,
  );
  assert.match(
    source,
    /validateAndResolveSecurityIncident/,
  );
  assert.match(
    source,
    /filterCurrentSecurityAlarmDeliveryItems/,
  );
  assert.match(
    source,
    /ALARM NOTIFICATION SKIPPED, CONDITION CLEARED/,
  );
});
