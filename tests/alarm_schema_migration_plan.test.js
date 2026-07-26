"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeLegacySchedule,
  classifyDeviceLegacyAlarm,
  buildMigrationPlan,
  parseArguments,
} = require("../scripts/plan_alarm_schema_migration");

test("lịch legacy trùng schema mới được phân loại xóa duplicate", () => {
  const legacy = {
    enabled: true,
    start: "22:00",
    end: "06:00",
    repeatMinutes: 15,
    days: [1, 2, 3, 4, 5, 6, 7],
  };

  const item = classifyDeviceLegacyAlarm({
    legacyPath: "legacy/path",
    legacyType: "home_device_alarm",
    legacyValue: legacy,
    currentPath: "current/path",
    currentSchedules: {
      schedule_a: { ...legacy },
    },
  });

  assert.equal(item.classification, "SAFE_DELETE_DUPLICATE");
  assert.equal(item.recommendedAction, "DELETE_LEGACY_ONLY");
});

test("lịch legacy hợp lệ chưa có schema mới được phân loại migrate", () => {
  const item = classifyDeviceLegacyAlarm({
    legacyPath: "legacy/path",
    legacyType: "personal_device_alarm",
    legacyValue: {
      enabled: true,
      start: "23:00",
      end: "05:30",
      repeatMinutes: 30,
      days: { 0: 1, 1: 2 },
    },
    currentPath: "current/path",
    currentSchedules: {},
  });

  assert.equal(item.classification, "SAFE_MIGRATE_THEN_DELETE");
  assert.deepEqual(item.proposedValue.days, [1, 2]);
});

test("home/alarm luôn được giữ để review vì không có ánh xạ 1-1", () => {
  const plan = buildMigrationPlan({
    owner: {
      homes: {
        home1: {
          alarm: {
            enabled: true,
            start: "22:00",
            end: "06:00",
            repeatMinutes: 15,
          },
          devices: {
            door1: { type: "door" },
            motion1: { type: "motion" },
          },
        },
      },
    },
  });

  assert.equal(plan.items.length, 1);
  assert.equal(
    plan.items[0].classification,
    "MANUAL_REVIEW_NO_1_TO_1_MAPPING",
  );
});

test("home/alarm của nhà không có thiết bị an ninh được đề xuất xóa", () => {
  const plan = buildMigrationPlan({
    owner: {
      homes: {
        home1: {
          alarm: { enabled: false },
          devices: {
            temperature1: { type: "temperature" },
          },
        },
      },
    },
  });

  assert.equal(plan.items.length, 1);
  assert.equal(
    plan.items[0].classification,
    "SAFE_DELETE_UNUSED_HOME_ALARM",
  );
  assert.equal(plan.summary.safeAutomaticCandidates, 1);
});

test("device.alarm của siren là trạng thái hiện tại, không phải legacy", () => {
  const plan = buildMigrationPlan({
    owner: {
      homes: {
        home1: {
          devices: {
            siren1: {
              type: "siren",
              alarm: false,
            },
          },
        },
      },
    },
  });

  assert.equal(plan.items.length, 0);
  assert.equal(plan.summary.totalLegacyNodes, 0);
  assert.equal(plan.summary.currentSirenAlarmStateCount, 1);
  assert.deepEqual(plan.currentSirenAlarmStatePaths, [
    "accounts/owner/homes/home1/devices/siren1/alarm",
  ]);
});

test("mode được đề xuất copy sang reminderMode rồi xóa legacy", () => {
  const plan = buildMigrationPlan({
    user1: {
      customRules: {
        home1: {
          mode: "custom",
          devices: {},
        },
      },
    },
  });

  assert.equal(plan.items.length, 1);
  assert.equal(
    plan.items[0].classification,
    "SAFE_MIGRATE_REMINDER_MODE_THEN_DELETE",
  );
  assert.equal(
    plan.items[0].recommendedAction,
    "COPY_TO_REMINDER_MODE_THEN_DELETE",
  );
  assert.equal(plan.items[0].proposedValue, "custom");
});

test("reminderMode hiện tại được giữ và mode chỉ bị xóa", () => {
  const plan = buildMigrationPlan({
    user1: {
      customRules: {
        home1: {
          mode: "home",
          reminderMode: "custom",
        },
      },
    },
  });

  assert.equal(
    plan.items[0].classification,
    "SAFE_DELETE_LEGACY_MODE",
  );
  assert.equal(plan.items[0].currentValue, "custom");
});

test("alarmMode được đề xuất xóa vì backend không còn consumer", () => {
  const plan = buildMigrationPlan({
    user1: {
      customRules: {
        home1: {
          alarmMode: "home",
          devices: {
            door1: {
              alarmPreferences: {
                followHomeSchedule: true,
                scheduleModelVersion: 2,
              },
            },
          },
        },
      },
    },
  });

  assert.equal(plan.items.length, 1);
  assert.equal(
    plan.items[0].classification,
    "SAFE_DELETE_LEGACY_ALARM_MODE",
  );
  assert.equal(plan.summary.safeAutomaticCandidates, 1);
});

test("parseArguments chỉ nhận các tham số an toàn", () => {
  const result = parseArguments([
    "--service-account",
    "/secure/serviceAccount.json",
    "--output",
    "reports/plan.json",
    "--uid",
    "abc",
  ]);

  assert.equal(
    result.serviceAccount,
    "/secure/serviceAccount.json",
  );
  assert.equal(result.output, "reports/plan.json");
  assert.equal(result.uid, "abc");

  assert.throws(() => parseArguments(["--apply"]));
});

test("lịch sai cấu trúc không được migrate", () => {
  const normalized = normalizeLegacySchedule({
    enabled: true,
    start: "99:00",
    end: "06:00",
    repeatMinutes: 15,
  });

  assert.equal(normalized.valid, false);
});
