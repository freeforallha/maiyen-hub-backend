"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPLY_CONFIRMATION,
  CLASSIFICATION,
  parseArguments,
  validateExecutionOptions,
  inspectHomeForSafeDelete,
  buildUnusedHomeAlarmCleanupPlan,
  executeCleanup,
} = require("../scripts/cleanup_unused_home_alarm_legacy");

function safeHome(overrides = {}) {
  return {
    alarm: {
      enabled: false,
      start: "23:00",
      end: "06:00",
    },
    devices: {},
    ...overrides,
  };
}

test("home/alarm không có thiết bị an ninh được SAFE_DELETE", () => {
  const inspection = inspectHomeForSafeDelete(safeHome());
  assert.equal(inspection.safe, true);
});

test("thiết bị an ninh khiến home/alarm được KEEP", () => {
  const inspection = inspectHomeForSafeDelete(safeHome({
    devices: {
      door1: { type: "door" },
    },
  }));
  assert.equal(inspection.safe, false);
  assert.equal(inspection.reason, "security_devices_exist");
});

test("alarmSchedules hoặc alarmPolicy khiến home/alarm được KEEP", () => {
  const withSchedules = inspectHomeForSafeDelete(safeHome({
    devices: {
      unknown1: {
        type: "unknown",
        alarmSchedules: { night: { enabled: true } },
      },
    },
  }));
  const withPolicy = inspectHomeForSafeDelete(safeHome({
    devices: {
      unknown1: {
        type: "unknown",
        alarmPolicy: { notificationEnabled: true },
      },
    },
  }));

  assert.equal(withSchedules.safe, false);
  assert.equal(withPolicy.safe, false);
  assert.equal(
    withSchedules.reason,
    "alarm_schedule_or_policy_exists",
  );
});

test("home/alarm sai kiểu được KEEP", () => {
  const inspection = inspectHomeForSafeDelete({
    alarm: true,
    devices: {},
  });
  assert.equal(inspection.safe, false);
  assert.equal(inspection.reason, "alarm_not_plain_object");
});

test("siren không bị coi là thiết bị an ninh", () => {
  const plan = buildUnusedHomeAlarmCleanupPlan({
    owner: {
      homes: {
        home1: safeHome({
          devices: {
            siren1: { type: "siren", alarm: false },
          },
        }),
      },
    },
  });

  assert.equal(plan.summary.safeDeletes, 1);
  assert.deepEqual(plan.updates, {
    "accounts/owner/homes/home1/alarm": null,
  });
});

test("chỉ xử lý homes/{homeId}/alarm", () => {
  const plan = buildUnusedHomeAlarmCleanupPlan({
    owner: {
      homes: {
        home1: safeHome(),
      },
      customRules: {
        home1: {
          alarm: { enabled: false },
        },
      },
    },
  });

  assert.equal(plan.items.length, 1);
  assert.equal(
    plan.items[0].legacyPath,
    "accounts/owner/homes/home1/alarm",
  );
});

test("DRY RUN không gọi update", async () => {
  let updateCalls = 0;
  const result = await executeCleanup({
    accounts: {
      owner: { homes: { home1: safeHome() } },
    },
    options: {
      apply: false,
      confirm: "",
      output: "",
      uid: "",
    },
    rootRef: {
      async update() {
        updateCalls += 1;
      },
    },
  });

  assert.equal(updateCalls, 0);
  assert.equal(result.applied, false);
});

test("APPLY thiếu confirmation bị từ chối", () => {
  assert.throws(() => validateExecutionOptions({
    apply: true,
    confirm: "WRONG",
    output: "backup.json",
  }));
});

test("APPLY ghi backup trước một multi-location update", async () => {
  const events = [];
  let capturedUpdates = null;

  const result = await executeCleanup({
    accounts: {
      owner: { homes: { home1: safeHome() } },
    },
    options: {
      apply: true,
      confirm: APPLY_CONFIRMATION,
      output: "backup.json",
      uid: "",
    },
    writeReport: async () => {
      events.push("backup");
      return "/tmp/backup.json";
    },
    rootRef: {
      async update(updates) {
        events.push("update");
        capturedUpdates = updates;
      },
    },
  });

  assert.deepEqual(events, ["backup", "update"]);
  assert.deepEqual(capturedUpdates, {
    "accounts/owner/homes/home1/alarm": null,
  });
  assert.equal(result.applied, true);
});

test("không ghi được backup thì không update", async () => {
  let updateCalls = 0;

  await assert.rejects(() => executeCleanup({
    accounts: {
      owner: { homes: { home1: safeHome() } },
    },
    options: {
      apply: true,
      confirm: APPLY_CONFIRMATION,
      output: "backup.json",
      uid: "",
    },
    writeReport: async () => {
      throw new Error("disk full");
    },
    rootRef: {
      async update() {
        updateCalls += 1;
      },
    },
  }));

  assert.equal(updateCalls, 0);
});

test("chạy lại sau khi node đã mất không tạo thay đổi", () => {
  const plan = buildUnusedHomeAlarmCleanupPlan({
    owner: {
      homes: {
        home1: {
          devices: {},
        },
      },
    },
  });

  assert.equal(plan.summary.totalLegacyNodes, 0);
  assert.deepEqual(plan.updates, {});
});

test("parseArguments nhận đúng tham số APPLY an toàn", () => {
  const options = parseArguments([
    "--service-account",
    "/secure/serviceAccount.json",
    "--output",
    "reports/backup.json",
    "--uid",
    "owner",
    "--apply",
    "--confirm",
    APPLY_CONFIRMATION,
  ]);

  assert.equal(options.apply, true);
  assert.equal(options.uid, "owner");
  assert.equal(options.confirm, APPLY_CONFIRMATION);
  assert.equal(CLASSIFICATION.SAFE_DELETE, "SAFE_DELETE");
});
