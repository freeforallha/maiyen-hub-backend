"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  APPLY_CONFIRMATION,
  CLASSIFICATION,
  buildPersonalAlarmMigrationPlan,
  executeMigration,
  parseArguments,
} = require("../scripts/migrate_personal_alarm_legacy");

function makeLegacy(overrides = {}) {
  return {
    enabled: true,
    start: "22:00",
    end: "06:00",
    repeatMinutes: 15,
    days: [1, 2, 3, 4, 5, 6, 7],
    ...overrides,
  };
}

function makeAccounts(device, extraAccount = {}) {
  return {
    userA: {
      ...extraAccount,
      customRules: {
        homeA: {
          devices: {
            deviceA: device,
          },
        },
      },
    },
  };
}

function makeOptions(overrides = {}) {
  return {
    serviceAccount: "unused-in-tests.json",
    databaseUrl: "https://unused.invalid",
    output: "",
    uid: "",
    apply: false,
    confirm: "",
    ...overrides,
  };
}

function applyUpdateMap(target, updates) {
  for (const [updatePath, value] of Object.entries(updates)) {
    const parts = updatePath.split("/");
    let parent = target;

    for (const part of parts.slice(0, -1)) {
      parent[part] ||= {};
      parent = parent[part];
    }

    const key = parts.at(-1);
    if (value === null) {
      delete parent[key];
    } else {
      parent[key] = structuredClone(value);
    }
  }
}

test("DRY RUN là mặc định và không gọi update()", async () => {
  const parsed = parseArguments([]);
  let updateCalls = 0;

  assert.equal(parsed.apply, false);

  const result = await executeMigration({
    accounts: makeAccounts({ alarm: makeLegacy() }),
    options: makeOptions(),
    rootRef: {
      async update() {
        updateCalls += 1;
      },
    },
  });

  assert.equal(result.applied, false);
  assert.equal(updateCalls, 0);
});

test("--apply bị từ chối nếu thiếu confirmation chính xác", async () => {
  let updateCalls = 0;

  await assert.rejects(
    executeMigration({
      accounts: makeAccounts({ alarm: makeLegacy() }),
      options: makeOptions({
        apply: true,
        output: "backup.json",
      }),
      rootRef: {
        async update() {
          updateCalls += 1;
        },
      },
      async writeReport() {
        throw new Error("Không được ghi backup khi confirm sai");
      },
    }),
    /--confirm MIGRATE_PERSONAL_ALARM_LEGACY/,
  );

  assert.equal(updateCalls, 0);
});

test("không bao giờ xử lý homes devices alarm", () => {
  const accounts = {
    userA: {
      homes: {
        homeA: {
          devices: {
            sirenA: { alarm: true },
            doorA: { alarm: makeLegacy() },
          },
        },
      },
    },
  };
  const plan = buildPersonalAlarmMigrationPlan(accounts);

  assert.equal(plan.items.length, 0);
  assert.deepEqual(plan.updates, {});
});

test("current schedule hợp lệ tương đương được xóa duplicate", () => {
  const legacy = makeLegacy({ days: { 0: 1, 1: 2, 2: 3 } });
  const plan = buildPersonalAlarmMigrationPlan(
    makeAccounts({
      alarm: legacy,
      alarmSchedules: {
        existing: makeLegacy({ days: [1, 2, 3] }),
      },
    }),
  );
  const item = plan.items[0];

  assert.equal(
    item.classification,
    CLASSIFICATION.SAFE_DELETE_DUPLICATE,
  );
  assert.deepEqual(plan.updates, {
    "accounts/userA/customRules/homeA/devices/deviceA/alarm": null,
  });
});

test("current repeatMinutes chuỗi không được coi là duplicate", () => {
  const plan = buildPersonalAlarmMigrationPlan(
    makeAccounts({
      alarm: makeLegacy(),
      alarmSchedules: {
        existing: makeLegacy({ repeatMinutes: "15" }),
      },
    }),
  );
  const item = plan.items[0];
  const invalidCurrentPath =
    "accounts/userA/customRules/homeA/devices/deviceA/" +
    "alarmSchedules/existing";

  assert.equal(
    item.classification,
    CLASSIFICATION.SAFE_MIGRATE_THEN_DELETE,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      plan.updates,
      invalidCurrentPath,
    ),
    false,
  );
  assert.equal(plan.updates[item.legacyPath], null);
  assert.deepEqual(plan.updates[item.targetPath], item.proposedValue);
});

test("current days chứa chuỗi không được coi là duplicate", () => {
  const plan = buildPersonalAlarmMigrationPlan(
    makeAccounts({
      alarm: makeLegacy({ days: [1, 2] }),
      alarmSchedules: {
        existing: makeLegacy({ days: ["1", 2] }),
      },
    }),
  );
  const item = plan.items[0];
  const invalidCurrentPath =
    "accounts/userA/customRules/homeA/devices/deviceA/" +
    "alarmSchedules/existing";

  assert.equal(
    item.classification,
    CLASSIFICATION.SAFE_MIGRATE_THEN_DELETE,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      plan.updates,
      invalidCurrentPath,
    ),
    false,
  );
  assert.equal(plan.updates[item.legacyPath], null);
  assert.deepEqual(plan.updates[item.targetPath], item.proposedValue);
});

test("legacy_migrated sai kiểu gây CONFLICT và không cập nhật", () => {
  const plan = buildPersonalAlarmMigrationPlan(
    makeAccounts({
      alarm: makeLegacy(),
      alarmSchedules: {
        legacy_migrated: "invalid-schedule",
      },
    }),
  );

  assert.equal(
    plan.items[0].classification,
    CLASSIFICATION.CONFLICT,
  );
  assert.deepEqual(plan.updates, {});
});

test("lịch mới dùng legacy_migrated rồi xóa legacy", () => {
  const legacy = makeLegacy({ days: [7, 1, 1] });
  const plan = buildPersonalAlarmMigrationPlan(
    makeAccounts({ alarm: legacy }),
  );
  const item = plan.items[0];

  assert.equal(
    item.classification,
    CLASSIFICATION.SAFE_MIGRATE_THEN_DELETE,
  );
  assert.equal(
    item.targetPath,
    "accounts/userA/customRules/homeA/devices/deviceA/" +
      "alarmSchedules/legacy_migrated",
  );
  assert.deepEqual(item.proposedValue.days, [1, 7]);
  assert.equal(plan.updates[item.legacyPath], null);
  assert.deepEqual(plan.updates[item.targetPath], item.proposedValue);
});

for (const { label, days } of [
  { label: "[]", days: [] },
  { label: "{}", days: {} },
  { label: "[0, 8]", days: [0, 8] },
  { label: '["1x", 2]', days: ["1x", 2] },
  { label: '["1", 2]', days: ["1", 2] },
]) {
  test(`days ${label} không hợp lệ được KEEP_INVALID`, () => {
    const plan = buildPersonalAlarmMigrationPlan(
      makeAccounts({ alarm: makeLegacy({ days }) }),
    );

    assert.equal(
      plan.items[0].classification,
      CLASSIFICATION.KEEP_INVALID,
    );
    assert.deepEqual(plan.updates, {});
  });
}

for (const repeatMinutes of ["15abc", "15", 15.5]) {
  test(`repeatMinutes ${JSON.stringify(repeatMinutes)} không hợp lệ được KEEP_INVALID`, () => {
    const plan = buildPersonalAlarmMigrationPlan(
      makeAccounts({ alarm: makeLegacy({ repeatMinutes }) }),
    );

    assert.equal(
      plan.items[0].classification,
      CLASSIFICATION.KEEP_INVALID,
    );
    assert.deepEqual(plan.updates, {});
  });
}

for (const { label, alarmSchedules } of [
  { label: "array", alarmSchedules: [] },
  { label: "string", alarmSchedules: "existing" },
]) {
  test(`alarmSchedules là ${label} được CONFLICT và không cập nhật`, () => {
    const plan = buildPersonalAlarmMigrationPlan(
      makeAccounts({ alarm: makeLegacy(), alarmSchedules }),
    );

    assert.equal(
      plan.items[0].classification,
      CLASSIFICATION.CONFLICT,
    );
    assert.deepEqual(plan.updates, {});
  });
}

test("legacy_migrated xung đột thì không ghi hoặc xóa", async () => {
  const plan = buildPersonalAlarmMigrationPlan(
    makeAccounts({
      alarm: makeLegacy(),
      alarmSchedules: {
        legacy_migrated: makeLegacy({ start: "21:00" }),
      },
    }),
  );
  let updateCalls = 0;

  assert.equal(plan.items[0].classification, CLASSIFICATION.CONFLICT);
  assert.deepEqual(plan.updates, {});

  await executeMigration({
    accounts: makeAccounts({
      alarm: makeLegacy(),
      alarmSchedules: {
        legacy_migrated: makeLegacy({ start: "21:00" }),
      },
    }),
    options: makeOptions({
      apply: true,
      confirm: APPLY_CONFIRMATION,
      output: "backup.json",
    }),
    rootRef: {
      async update() {
        updateCalls += 1;
      },
    },
    async writeReport() {
      return "backup.json";
    },
  });

  assert.equal(updateCalls, 0);
});

test("alarm không phải plain object được giữ nguyên", () => {
  for (const alarm of [true, "22:00", [makeLegacy()]]) {
    const plan = buildPersonalAlarmMigrationPlan(
      makeAccounts({ alarm }),
    );

    assert.equal(
      plan.items[0].classification,
      CLASSIFICATION.KEEP_INVALID,
    );
    assert.deepEqual(plan.updates, {});
  }
});

test("APPLY backup trước rồi gửi một multi-location update nguyên tử", async () => {
  const legacy = makeLegacy();
  const events = [];
  let capturedUpdates = null;
  let capturedReport = null;

  const result = await executeMigration({
    accounts: makeAccounts({ alarm: legacy }),
    options: makeOptions({
      apply: true,
      confirm: APPLY_CONFIRMATION,
      output: "backup.json",
    }),
    async writeReport(outputPath, report) {
      events.push("backup");
      assert.equal(outputPath, "backup.json");
      capturedReport = report;
      return outputPath;
    },
    rootRef: {
      async update(updates) {
        events.push("update");
        capturedUpdates = updates;
      },
    },
    now: () => "2026-07-21T00:00:00.000Z",
  });

  const legacyPath =
    "accounts/userA/customRules/homeA/devices/deviceA/alarm";
  const migratedPath =
    "accounts/userA/customRules/homeA/devices/deviceA/" +
    "alarmSchedules/legacy_migrated";

  assert.equal(result.applied, true);
  assert.deepEqual(events, ["backup", "update"]);
  assert.deepEqual(capturedReport.backup.items, [
    {
      path: legacyPath,
      legacyValue: legacy,
    },
  ]);
  assert.deepEqual(capturedUpdates[migratedPath], makeLegacy());
  assert.equal(capturedUpdates[legacyPath], null);
  assert.equal(Object.keys(capturedUpdates).length, 2);
});

test("chạy lại sau migration không tạo lịch trùng", () => {
  const accountsRoot = {
    accounts: makeAccounts({ alarm: makeLegacy() }),
  };
  const firstPlan = buildPersonalAlarmMigrationPlan(
    accountsRoot.accounts,
  );

  applyUpdateMap(accountsRoot, firstPlan.updates);

  const secondPlan = buildPersonalAlarmMigrationPlan(
    accountsRoot.accounts,
  );
  const migratedSchedules =
    accountsRoot.accounts.userA.customRules.homeA.devices.deviceA
      .alarmSchedules;

  assert.equal(secondPlan.items.length, 0);
  assert.deepEqual(secondPlan.updates, {});
  assert.deepEqual(Object.keys(migratedSchedules), ["legacy_migrated"]);
});

test("không ghi Firebase nếu không ghi được backup", async () => {
  let updateCalls = 0;

  await assert.rejects(
    executeMigration({
      accounts: makeAccounts({ alarm: makeLegacy() }),
      options: makeOptions({
        apply: true,
        confirm: APPLY_CONFIRMATION,
        output: "backup.json",
      }),
      async writeReport() {
        throw new Error("disk_full");
      },
      rootRef: {
        async update() {
          updateCalls += 1;
        },
      },
    }),
    /disk_full/,
  );

  assert.equal(updateCalls, 0);
});
