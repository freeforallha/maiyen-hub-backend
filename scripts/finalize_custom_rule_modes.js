#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";
const APPLY_CONFIRMATION = "FINALIZE_CUSTOM_RULE_MODES";
const VALID_MODES = new Set(["home", "custom"]);

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : null;
}

function parseArguments(argv) {
  const options = {
    serviceAccount: "",
    databaseUrl: DEFAULT_DATABASE_URL,
    output: "",
    uid: "",
    apply: false,
    confirm: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--service-account" && next) {
      options.serviceAccount = next;
      index += 1;
    } else if (arg === "--database-url" && next) {
      options.databaseUrl = next;
      index += 1;
    } else if (arg === "--output" && next) {
      options.output = next;
      index += 1;
    } else if (arg === "--uid" && next) {
      options.uid = next;
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--confirm" && next) {
      options.confirm = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Tham số không hợp lệ: ${arg}`);
    }
  }

  if (
    options.apply &&
    options.confirm !== APPLY_CONFIRMATION
  ) {
    throw new Error(
      `APPLY yêu cầu --confirm ${APPLY_CONFIRMATION}`,
    );
  }

  return options;
}

function classifyCustomRuleHome({ uid, homeId, rawCustomHome }) {
  const customHome = isPlainObject(rawCustomHome)
    ? rawCustomHome
    : {};
  const basePath = `accounts/${uid}/customRules/${homeId}`;
  const hasMode = hasOwn(customHome, "mode") && customHome.mode !== null;
  const hasAlarmMode =
    hasOwn(customHome, "alarmMode") &&
    customHome.alarmMode !== null;
  const hasReminderMode =
    hasOwn(customHome, "reminderMode") &&
    customHome.reminderMode !== null;

  if (!hasMode && !hasAlarmMode) {
    return null;
  }

  const mode = hasMode ? normalizeMode(customHome.mode) : null;
  const alarmMode = hasAlarmMode
    ? normalizeMode(customHome.alarmMode)
    : null;
  const reminderMode = hasReminderMode
    ? normalizeMode(customHome.reminderMode)
    : null;

  const invalidFields = [];
  if (hasMode && !mode) invalidFields.push("mode");
  if (hasAlarmMode && !alarmMode) invalidFields.push("alarmMode");
  if (hasReminderMode && !reminderMode) {
    invalidFields.push("reminderMode");
  }

  if (invalidFields.length > 0) {
    return {
      uid,
      homeId,
      basePath,
      classification: "CONFLICT_INVALID_MODE",
      reason: `invalid_${invalidFields.join("_")}`,
      currentValue: {
        mode: hasMode ? customHome.mode : null,
        alarmMode: hasAlarmMode ? customHome.alarmMode : null,
        reminderMode: hasReminderMode
          ? customHome.reminderMode
          : null,
      },
      updates: {},
    };
  }

  const updates = {};
  let effectiveReminderMode = reminderMode;

  if (hasMode) {
    if (!hasReminderMode) {
      effectiveReminderMode = mode;
      updates[`${basePath}/reminderMode`] = mode;
    }
    updates[`${basePath}/mode`] = null;
  }

  if (hasAlarmMode) {
    updates[`${basePath}/alarmMode`] = null;
  }

  return {
    uid,
    homeId,
    basePath,
    classification: "SAFE_FINALIZE",
    reason: hasMode && !hasReminderMode
      ? "copy_mode_to_reminderMode_then_delete_legacy_modes"
      : "delete_legacy_modes_keep_current_reminderMode",
    currentValue: {
      mode: hasMode ? mode : null,
      alarmMode: hasAlarmMode ? alarmMode : null,
      reminderMode: hasReminderMode ? reminderMode : null,
    },
    effectiveReminderMode,
    updates,
  };
}

function buildFinalizationPlan(rawAccounts, { uidFilter = "" } = {}) {
  const accounts = isPlainObject(rawAccounts) ? rawAccounts : {};
  const items = [];
  const updates = {};

  for (const [uid, rawAccount] of Object.entries(accounts)) {
    if (uidFilter && uid !== uidFilter) continue;
    const account = isPlainObject(rawAccount) ? rawAccount : {};
    const customRules = isPlainObject(account.customRules)
      ? account.customRules
      : {};

    for (const [homeId, rawCustomHome] of Object.entries(customRules)) {
      const item = classifyCustomRuleHome({
        uid,
        homeId,
        rawCustomHome,
      });
      if (!item) continue;
      items.push(item);

      if (item.classification === "SAFE_FINALIZE") {
        Object.assign(updates, item.updates);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    items,
    updates,
    summary: {
      homesAnalyzed: items.length,
      safeHomes: items.filter(
        (item) => item.classification === "SAFE_FINALIZE",
      ).length,
      conflicts: items.filter(
        (item) => item.classification !== "SAFE_FINALIZE",
      ).length,
      updatePaths: Object.keys(updates).length,
    },
  };
}

function buildBackup(plan) {
  return {
    generatedAt: new Date().toISOString(),
    operation: "finalize_custom_rule_modes",
    items: plan.items
      .filter((item) => item.classification === "SAFE_FINALIZE")
      .map((item) => ({
        basePath: item.basePath,
        currentValue: item.currentValue,
        effectiveReminderMode: item.effectiveReminderMode,
        updatePaths: Object.keys(item.updates),
      })),
  };
}

function writeJsonFile(outputPath, value) {
  const resolvedPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), {
    recursive: true,
  });
  fs.writeFileSync(
    resolvedPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return resolvedPath;
}

async function executePlan({
  plan,
  apply,
  output,
  rootRef,
  writeReport = writeJsonFile,
}) {
  let reportPath = "";

  if (output) {
    reportPath = writeReport(output, {
      ...plan,
      mode: apply ? "APPLY" : "DRY_RUN",
      backup: buildBackup(plan),
    });
  } else if (apply && Object.keys(plan.updates).length > 0) {
    throw new Error("APPLY yêu cầu --output để ghi backup cục bộ.");
  }

  if (!apply || Object.keys(plan.updates).length === 0) {
    return {
      applied: false,
      reportPath,
      updateCount: 0,
    };
  }

  if (!rootRef || typeof rootRef.update !== "function") {
    throw new Error("Firebase rootRef không hợp lệ.");
  }

  await rootRef.update(plan.updates);

  return {
    applied: true,
    reportPath,
    updateCount: Object.keys(plan.updates).length,
  };
}

function printHelp() {
  console.log(`
MAIYEN CUSTOM RULE MODE FINALIZATION

Mặc định DRY RUN. APPLY chỉ được bật bằng:
  --apply --confirm ${APPLY_CONFIRMATION}

Usage:
  node scripts/finalize_custom_rule_modes.js \\
    --service-account /opt/maiyen-hub-backend/serviceAccount.json \\
    --output reports/custom_rule_modes.json
`);
}

function printPlan(plan, apply) {
  console.log(`\nMode: ${apply ? "APPLY" : "DRY_RUN"}`);
  console.log(`Custom homes analyzed: ${plan.summary.homesAnalyzed}`);
  console.log(`Safe homes: ${plan.summary.safeHomes}`);
  console.log(`Conflicts: ${plan.summary.conflicts}`);
  console.log(`Update paths: ${plan.summary.updatePaths}`);

  for (const item of plan.items) {
    console.log(
      `[${item.classification}] ${item.basePath}`,
    );
    console.log(`  ${item.reason}`);
    if (item.effectiveReminderMode) {
      console.log(
        `  reminderMode=${item.effectiveReminderMode}`,
      );
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.serviceAccount) {
    throw new Error("Thiếu --service-account.");
  }

  const serviceAccountPath = path.resolve(
    options.serviceAccount,
  );
  fs.accessSync(serviceAccountPath, fs.constants.R_OK);

  const admin = require("firebase-admin");
  const serviceAccount = JSON.parse(
    fs.readFileSync(serviceAccountPath, "utf8"),
  );
  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: options.databaseUrl,
  }, `custom-rule-mode-finalize-${Date.now()}`);

  try {
    const rootRef = app.database().ref();
    const snapshot = await rootRef.child("accounts").once("value");
    const plan = buildFinalizationPlan(snapshot.val() || {}, {
      uidFilter: options.uid,
    });
    printPlan(plan, options.apply);

    const result = await executePlan({
      plan,
      apply: options.apply,
      output: options.output,
      rootRef,
    });

    if (result.reportPath) {
      console.log(
        `Local report/backup written: ${result.reportPath}`,
      );
    }
    console.log(
      result.applied
        ? "Atomic Firebase mode finalization completed."
        : "No Firebase data was modified.",
    );
  } finally {
    await app.delete();
  }
}

module.exports = {
  APPLY_CONFIRMATION,
  parseArguments,
  normalizeMode,
  classifyCustomRuleHome,
  buildFinalizationPlan,
  buildBackup,
  executePlan,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "CUSTOM RULE MODE FINALIZATION ERROR:",
      error.message,
    );
    process.exitCode = 1;
  });
}
