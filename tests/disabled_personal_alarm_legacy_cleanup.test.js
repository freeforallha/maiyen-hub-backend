"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  APPLY_CONFIRMATION,
  CLASSIFICATION,
  buildDisabledPersonalAlarmCleanupPlan,
  executeCleanup,
  parseArguments,
} = require("../scripts/cleanup_disabled_personal_alarm_legacy");

function makeAlarm(overrides = {}) {
  return {
    enabled: false,
    start: "22:00",
    end: "06:00",
    repeatMinutes: 15,
    ...overrides,
  };
}

function makeAccounts(device) {
  return {
    userA: {
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

function assertKept(alarm) {
  const plan = buildDisabledPersonalAlarmCleanupPlan(
    makeAccounts({ alarm }),
  );

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].classification, CLASSIFICATION.KEEP);
  assert.deepEqual(plan.updates, {});
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

test("disabled alarm hợp lệ và thiếu days được SAFE_DELETE", () => {
  const legacy = makeAlarm();
  const plan = buildDisabledPersonalAlarmCleanupPlan(
    makeAccounts({ alarm: legacy }),
  );
  const legacyPath =
    "accounts/userA/customRules/homeA/devices/deviceA/alarm";

  assert.equal(
    plan.items[0].classification,
    CLASSIFICATION.SAFE_DELETE,
  );
  assert.deepEqual(plan.updates, {
    [legacyPath]: null,
  });
});

test("enabled true được KEEP", () => {
  assertKept(makeAlarm({ enabled: true }));
});

test("days tồn tại được KEEP", () => {
  assertKept(makeAlarm({ days: [1, 2] }));
});

test("days rỗng được KEEP", () => {
  assertKept(makeAlarm({ days: [] }));
});

for (const missingField of ["start", "end", "repeatMinutes"]) {
  test(`thiếu ${missingField} được KEEP`, () => {
    const alarm = makeAlarm();
    delete alarm[missingField];
    assertKept(alarm);
  });
}

for (const repeatMinutes of ["15", 15.5]) {
  test(`repeatMinutes ${JSON.stringify(repeatMinutes)} được KEEP`, () => {
    assertKept(makeAlarm({ repeatMinutes }));
  });
}

for (const alarm of [true, "disabled", []]) {
  test(`alarm không phải plain object (${typeof alarm}) được KEEP`, () => {
    assertKept(alarm);
  });
}

test("field lạ được KEEP", () => {
  assertKept(makeAlarm({ note: "do-not-delete" }));
});

test("homes devices alarm không bao giờ được xét", () => {
  const accounts = {
    userA: {
      homes: {
        homeA: {
          devices: {
            deviceA: {
              alarm: makeAlarm(),
            },
          },
        },
      },
    },
  };
  const plan = buildDisabledPersonalAlarmCleanupPlan(accounts);

  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.updates, {});
});

test("DRY RUN là mặc định và không gọi update", async () => {
  const parsed = parseArguments([]);
  let updateCalls = 0;

  assert.equal(parsed.apply, false);

  const result = await executeCleanup({
    accounts: makeAccounts({ alarm: makeAlarm() }),
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

test("APPLY thiếu confirmation chính xác bị từ chối", async () => {
  let updateCalls = 0;

  await assert.rejects(
    executeCleanup({
      accounts: makeAccounts({ alarm: makeAlarm() }),
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
    /--confirm DELETE_DISABLED_PERSONAL_ALARM_LEGACY/,
  );

  assert.equal(updateCalls, 0);
});

test("không ghi được backup thì không gọi update", async () => {
  let updateCalls = 0;

  await assert.rejects(
    executeCleanup({
      accounts: makeAccounts({ alarm: makeAlarm() }),
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

test("APPLY backup trước và chỉ gửi một legacy path với null", async () => {
  const legacy = makeAlarm();
  const events = [];
  let updateCalls = 0;
  let capturedUpdates = null;
  let capturedReport = null;

  const result = await executeCleanup({
    accounts: makeAccounts({
      alarm: legacy,
      alarmSchedules: {
        existing: {
          enabled: true,
        },
      },
    }),
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
        updateCalls += 1;
        capturedUpdates = updates;
      },
    },
    now: () => "2026-07-21T00:00:00.000Z",
  });

  const legacyPath =
    "accounts/userA/customRules/homeA/devices/deviceA/alarm";

  assert.equal(result.applied, true);
  assert.deepEqual(events, ["backup", "update"]);
  assert.equal(updateCalls, 1);
  assert.deepEqual(capturedReport.backup.items, [
    {
      path: legacyPath,
      legacyValue: legacy,
    },
  ]);
  assert.deepEqual(capturedUpdates, {
    [legacyPath]: null,
  });
});

test("chạy lại sau khi node biến mất không tạo thay đổi", () => {
  const accountsRoot = {
    accounts: makeAccounts({ alarm: makeAlarm() }),
  };
  const firstPlan = buildDisabledPersonalAlarmCleanupPlan(
    accountsRoot.accounts,
  );

  applyUpdateMap(accountsRoot, firstPlan.updates);

  const secondPlan = buildDisabledPersonalAlarmCleanupPlan(
    accountsRoot.accounts,
  );

  assert.equal(secondPlan.items.length, 0);
  assert.deepEqual(secondPlan.updates, {});
});
