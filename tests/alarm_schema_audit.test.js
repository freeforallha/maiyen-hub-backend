"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scanAccountsForAlarmSchema,
  parseArguments,
} = require("../scripts/audit_alarm_schema_legacy");

test("audit phân loại đúng schema Alarm cũ và mới", () => {
  const report = scanAccountsForAlarmSchema({
    ownerA: {
      homes: {
        home1: {
          alarm: { enabled: true },
          schedules: {
            alarms: [{ start: "22:00", end: "06:00" }],
          },
          devices: {
            door1: {
              type: "door",
              alarm: { enabled: true },
              alarmSchedules: {
                current1: {
                  enabled: true,
                  start: "22:00",
                  end: "06:00",
                },
              },
            },
            siren1: {
              type: "siren",
              alarm: false,
            },
          },
        },
      },
      customRules: {
        home1: {
          mode: "custom",
          alarmMode: "home",
          devices: {
            door1: {
              alarm: { enabled: true },
              alarmSchedules: {
                personal1: {
                  enabled: true,
                  start: "08:00",
                  end: "09:00",
                },
              },
            },
          },
        },
      },
    },
  });

  assert.equal(report.summary.legacyNodeCount, 6);
  assert.equal(report.summary.currentNodeCount, 3);
  assert.equal(report.categories.homeAlarm.count, 1);
  assert.equal(report.categories.homeScheduleAlarms.count, 1);
  assert.equal(report.categories.deviceAlarm.count, 1);
  assert.equal(report.categories.sirenAlarmState.count, 1);
  assert.equal(report.categories.customMode.count, 1);
  assert.equal(report.categories.customAlarmMode.count, 1);
  assert.equal(report.categories.customDeviceAlarm.count, 1);
  assert.equal(report.categories.deviceAlarmSchedules.count, 1);
  assert.equal(report.categories.customDeviceAlarmSchedules.count, 1);
  assert.equal(report.readOnly, true);
});

test("trạng thái alarm của siren không bị tính là schema legacy", () => {
  const report = scanAccountsForAlarmSchema({
    ownerA: {
      homes: {
        home1: {
          devices: {
            siren1: {
              type: "siren",
              alarm: true,
            },
          },
        },
      },
    },
  });

  assert.equal(report.summary.legacyNodeCount, 0);
  assert.equal(report.categories.deviceAlarm.count, 0);
  assert.equal(report.categories.sirenAlarmState.count, 1);
});

test("audit bỏ qua field null vì node đó đã được xóa trên Firebase", () => {
  const report = scanAccountsForAlarmSchema({
    ownerA: {
      homes: {
        home1: {
          alarm: null,
          schedules: { alarms: null },
          devices: {
            door1: {
              alarm: null,
              alarmSchedules: null,
            },
          },
        },
      },
      customRules: {
        home1: {
          mode: null,
          alarmMode: null,
          devices: {
            door1: {
              alarm: null,
              alarmSchedules: null,
            },
          },
        },
      },
    },
  });

  assert.equal(report.summary.legacyNodeCount, 0);
  assert.equal(report.summary.currentNodeCount, 0);
});

test("--uid chỉ audit đúng tài khoản được chọn", () => {
  const report = scanAccountsForAlarmSchema(
    {
      ownerA: {
        homes: {
          home1: { alarm: { enabled: true } },
        },
      },
      ownerB: {
        homes: {
          home2: { alarm: { enabled: true } },
        },
      },
    },
    { onlyUid: "ownerB" },
  );

  assert.equal(report.totals.accounts, 1);
  assert.equal(report.categories.homeAlarm.count, 1);
  assert.match(report.categories.homeAlarm.samples[0], /ownerB/);
});

test("parseArguments đọc đúng tùy chọn an toàn", () => {
  const options = parseArguments([
    "--uid",
    "ownerA",
    "--sample-limit",
    "5",
    "--output",
    "reports/alarm.json",
    "--service-account",
    "/opt/maiyen-hub-backend/serviceAccount.json",
  ]);

  assert.deepEqual(options, {
    onlyUid: "ownerA",
    sampleLimit: 5,
    outputPath: "reports/alarm.json",
    serviceAccountPath: "/opt/maiyen-hub-backend/serviceAccount.json",
  });
});
