"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPLY_CONFIRMATION,
  parseArguments,
  normalizeMode,
  classifyCustomRuleHome,
  buildFinalizationPlan,
  executePlan,
} = require("../scripts/finalize_custom_rule_modes");

test("mode hợp lệ được copy sang reminderMode rồi xóa legacy", () => {
  const item = classifyCustomRuleHome({
    uid: "userA",
    homeId: "homeA",
    rawCustomHome: {
      mode: "custom",
    },
  });

  assert.equal(item.classification, "SAFE_FINALIZE");
  assert.equal(item.effectiveReminderMode, "custom");
  assert.deepEqual(item.updates, {
    "accounts/userA/customRules/homeA/reminderMode": "custom",
    "accounts/userA/customRules/homeA/mode": null,
  });
});

test("reminderMode hiện tại được giữ khi khác mode", () => {
  const item = classifyCustomRuleHome({
    uid: "userA",
    homeId: "homeA",
    rawCustomHome: {
      mode: "home",
      reminderMode: "custom",
      alarmMode: "home",
    },
  });

  assert.equal(item.classification, "SAFE_FINALIZE");
  assert.equal(item.effectiveReminderMode, "custom");
  assert.deepEqual(item.updates, {
    "accounts/userA/customRules/homeA/mode": null,
    "accounts/userA/customRules/homeA/alarmMode": null,
  });
});

test("alarmMode riêng lẻ được xóa vì backend Alarm không còn đọc", () => {
  const item = classifyCustomRuleHome({
    uid: "userA",
    homeId: "homeA",
    rawCustomHome: {
      alarmMode: "home",
    },
  });

  assert.equal(item.classification, "SAFE_FINALIZE");
  assert.deepEqual(item.updates, {
    "accounts/userA/customRules/homeA/alarmMode": null,
  });
});

test("mode sai kiểu gây conflict và không ghi", () => {
  const item = classifyCustomRuleHome({
    uid: "userA",
    homeId: "homeA",
    rawCustomHome: {
      mode: true,
      alarmMode: "home",
    },
  });

  assert.equal(item.classification, "CONFLICT_INVALID_MODE");
  assert.deepEqual(item.updates, {});
});

test("reminderMode sai dữ liệu không bị ghi đè bằng mode", () => {
  const item = classifyCustomRuleHome({
    uid: "userA",
    homeId: "homeA",
    rawCustomHome: {
      mode: "custom",
      reminderMode: "invalid",
    },
  });

  assert.equal(item.classification, "CONFLICT_INVALID_MODE");
  assert.deepEqual(item.updates, {});
});

test("planner chỉ quét customRules và hỗ trợ uid filter", () => {
  const accounts = {
    userA: {
      homes: {
        homeA: { mode: "custom" },
      },
      customRules: {
        homeA: { mode: "custom" },
      },
    },
    userB: {
      customRules: {
        homeB: { mode: "home" },
      },
    },
  };

  const plan = buildFinalizationPlan(accounts, {
    uidFilter: "userA",
  });

  assert.equal(plan.summary.homesAnalyzed, 1);
  assert.equal(plan.summary.safeHomes, 1);
  assert.equal(
    plan.updates[
      "accounts/userA/customRules/homeA/reminderMode"
    ],
    "custom",
  );
  assert.equal(
    Object.keys(plan.updates).some((key) => key.includes("homes/")),
    false,
  );
  assert.equal(
    Object.keys(plan.updates).some((key) => key.includes("userB")),
    false,
  );
});

test("DRY RUN không gọi Firebase update", async () => {
  const plan = buildFinalizationPlan({
    userA: {
      customRules: {
        homeA: { mode: "home" },
      },
    },
  });
  let updateCalled = false;

  const result = await executePlan({
    plan,
    apply: false,
    output: "",
    rootRef: {
      async update() {
        updateCalled = true;
      },
    },
  });

  assert.equal(result.applied, false);
  assert.equal(updateCalled, false);
});

test("APPLY bắt buộc confirmation chính xác", () => {
  assert.throws(
    () => parseArguments(["--apply"]),
    /--confirm/,
  );
  const options = parseArguments([
    "--apply",
    "--confirm",
    APPLY_CONFIRMATION,
  ]);
  assert.equal(options.apply, true);
});

test("APPLY bắt buộc ghi backup trước update", async () => {
  const plan = buildFinalizationPlan({
    userA: {
      customRules: {
        homeA: {
          mode: "home",
          alarmMode: "home",
        },
      },
    },
  });
  const calls = [];

  const result = await executePlan({
    plan,
    apply: true,
    output: "/tmp/report.json",
    writeReport(output, value) {
      calls.push(["backup", output, value.backup.items.length]);
      return output;
    },
    rootRef: {
      async update(updates) {
        calls.push(["update", updates]);
      },
    },
  });

  assert.equal(result.applied, true);
  assert.equal(calls[0][0], "backup");
  assert.equal(calls[1][0], "update");
  assert.deepEqual(calls[1][1], plan.updates);
});

test("không ghi được backup thì tuyệt đối không update", async () => {
  const plan = buildFinalizationPlan({
    userA: {
      customRules: {
        homeA: { mode: "home" },
      },
    },
  });
  let updated = false;

  await assert.rejects(
    executePlan({
      plan,
      apply: true,
      output: "/readonly/report.json",
      writeReport() {
        throw new Error("disk_read_only");
      },
      rootRef: {
        async update() {
          updated = true;
        },
      },
    }),
    /disk_read_only/,
  );

  assert.equal(updated, false);
});

test("chạy lại trên dữ liệu đã finalize không tạo update", () => {
  const plan = buildFinalizationPlan({
    userA: {
      customRules: {
        homeA: {
          reminderMode: "custom",
        },
      },
    },
  });

  assert.equal(plan.summary.homesAnalyzed, 0);
  assert.deepEqual(plan.updates, {});
});

test("normalizeMode chỉ nhận home/custom dạng string", () => {
  assert.equal(normalizeMode(" HOME "), "home");
  assert.equal(normalizeMode("custom"), "custom");
  assert.equal(normalizeMode(1), null);
  assert.equal(normalizeMode("other"), null);
});
