#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const {
  normalizeLegacySchedule,
} = require("./plan_alarm_schema_migration");

const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";
const APPLY_CONFIRMATION = "MIGRATE_PERSONAL_ALARM_LEGACY";
const MIGRATED_SCHEDULE_ID = "legacy_migrated";
const ALLOWED_REPEAT_MINUTES = new Set([0, 15, 30, 60]);
const REQUIRED_LEGACY_FIELDS = [
  "enabled",
  "start",
  "end",
  "repeatMinutes",
  "days",
];

const CLASSIFICATION = Object.freeze({
  SAFE_DELETE_DUPLICATE: "SAFE_DELETE_DUPLICATE",
  SAFE_MIGRATE_THEN_DELETE: "SAFE_MIGRATE_THEN_DELETE",
  CONFLICT: "CONFLICT",
  KEEP_INVALID: "KEEP_INVALID",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`Thiếu giá trị cho ${optionName}.`);
  }

  return value;
}

function parseArguments(argv) {
  const options = {
    serviceAccount: "",
    databaseUrl: DEFAULT_DATABASE_URL,
    output: "",
    uid: "",
    apply: false,
    confirm: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--service-account") {
      options.serviceAccount = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--database-url") {
      options.databaseUrl = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      options.output = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--uid") {
      options.uid = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--confirm") {
      options.confirm = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Tham số không hợp lệ: ${arg}`);
    }
  }

  return options;
}

function validateExecutionOptions(options) {
  if (
    options.apply === true &&
    options.confirm !== APPLY_CONFIRMATION
  ) {
    throw new Error(
      `--apply yêu cầu --confirm ${APPLY_CONFIRMATION}.`,
    );
  }

  if (options.apply === true && !options.output) {
    throw new Error(
      "--apply yêu cầu --output để ghi backup trước khi cập nhật Firebase.",
    );
  }
}

function validateLegacyAlarm(legacyValue) {
  if (!isPlainObject(legacyValue)) {
    return {
      valid: false,
      reason: "not_plain_object",
      schedule: null,
    };
  }

  const missingField = REQUIRED_LEGACY_FIELDS.find(
    (field) => !Object.prototype.hasOwnProperty.call(
      legacyValue,
      field,
    ),
  );

  if (missingField) {
    return {
      valid: false,
      reason: `missing_${missingField}`,
      schedule: null,
    };
  }

  if (
    !Array.isArray(legacyValue.days) &&
    !isPlainObject(legacyValue.days)
  ) {
    return {
      valid: false,
      reason: "invalid_days",
      schedule: null,
    };
  }

  const days = Array.isArray(legacyValue.days)
    ? legacyValue.days
    : Object.values(legacyValue.days);

  if (
    days.length === 0 ||
    days.some((day) =>
      !Number.isInteger(day) || day < 1 || day > 7
    )
  ) {
    return {
      valid: false,
      reason: "invalid_days",
      schedule: null,
    };
  }

  if (
    !Number.isInteger(legacyValue.repeatMinutes) ||
    !ALLOWED_REPEAT_MINUTES.has(legacyValue.repeatMinutes)
  ) {
    return {
      valid: false,
      reason: "invalid_repeatMinutes",
      schedule: null,
    };
  }

  return normalizeLegacySchedule(legacyValue);
}

function schedulesAreEquivalent(left, right) {
  return left.enabled === right.enabled &&
    left.start === right.start &&
    left.end === right.end &&
    left.repeatMinutes === right.repeatMinutes &&
    left.days.length === right.days.length &&
    left.days.every((day, index) => day === right.days[index]);
}

function findStrictEquivalentSchedule(
  currentSchedules,
  targetSchedule,
) {
  if (!isPlainObject(currentSchedules)) return null;

  const normalizedTarget = validateLegacyAlarm(targetSchedule);
  if (!normalizedTarget.valid) return null;

  for (const [scheduleId, currentSchedule] of Object.entries(
    currentSchedules,
  )) {
    const normalizedCurrent = validateLegacyAlarm(currentSchedule);

    if (
      normalizedCurrent.valid &&
      schedulesAreEquivalent(
        normalizedCurrent.schedule,
        normalizedTarget.schedule,
      )
    ) {
      return {
        scheduleId,
        schedule: currentSchedule,
      };
    }
  }

  return null;
}

function makePlanItem({
  legacyPath,
  classification,
  reason,
  legacyValue,
  targetPath = "",
  currentValue = null,
  proposedValue = null,
}) {
  return {
    legacyPath,
    classification,
    reason,
    legacyValue,
    targetPath,
    currentValue,
    proposedValue,
  };
}

function classifyPersonalLegacyAlarm({
  uid,
  homeId,
  deviceId,
  legacyValue,
  currentSchedules,
}) {
  const devicePath =
    `accounts/${uid}/customRules/${homeId}/devices/${deviceId}`;
  const legacyPath = `${devicePath}/alarm`;
  const schedulesPath = `${devicePath}/alarmSchedules`;

  if (
    currentSchedules !== undefined &&
    currentSchedules !== null &&
    !isPlainObject(currentSchedules)
  ) {
    return makePlanItem({
      legacyPath,
      classification: CLASSIFICATION.CONFLICT,
      reason:
        `${schedulesPath} tồn tại nhưng không phải plain object; giữ nguyên cả hai schema.`,
      legacyValue,
      targetPath: schedulesPath,
      currentValue: currentSchedules,
    });
  }

  const normalized = validateLegacyAlarm(legacyValue);

  if (!normalized.valid) {
    return makePlanItem({
      legacyPath,
      classification: CLASSIFICATION.KEEP_INVALID,
      reason:
        `Giữ nguyên legacy alarm không hợp lệ (${normalized.reason}).`,
      legacyValue,
      currentValue: currentSchedules || null,
    });
  }

  const migratedPath = `${schedulesPath}/${MIGRATED_SCHEDULE_ID}`;
  const migratedIdExists = isPlainObject(currentSchedules) &&
    Object.prototype.hasOwnProperty.call(
      currentSchedules,
      MIGRATED_SCHEDULE_ID,
    );

  if (migratedIdExists) {
    const normalizedMigrated = validateLegacyAlarm(
      currentSchedules[MIGRATED_SCHEDULE_ID],
    );

    if (
      normalizedMigrated.valid &&
      schedulesAreEquivalent(
        normalizedMigrated.schedule,
        normalized.schedule,
      )
    ) {
      return makePlanItem({
        legacyPath,
        classification: CLASSIFICATION.SAFE_DELETE_DUPLICATE,
        reason:
          `Đã có lịch tương đương tại ${migratedPath}.`,
        legacyValue,
        targetPath: migratedPath,
        currentValue: currentSchedules[MIGRATED_SCHEDULE_ID],
      });
    }

    return makePlanItem({
      legacyPath,
      classification: CLASSIFICATION.CONFLICT,
      reason:
        `${migratedPath} đã tồn tại nhưng không tương đương; giữ nguyên cả hai schema.`,
      legacyValue,
      targetPath: migratedPath,
      currentValue: currentSchedules[MIGRATED_SCHEDULE_ID],
      proposedValue: normalized.schedule,
    });
  }

  const equivalent = findStrictEquivalentSchedule(
    currentSchedules,
    normalized.schedule,
  );

  if (equivalent) {
    return makePlanItem({
      legacyPath,
      classification: CLASSIFICATION.SAFE_DELETE_DUPLICATE,
      reason:
        `Đã có lịch tương đương tại ${schedulesPath}/${equivalent.scheduleId}.`,
      legacyValue,
      targetPath: `${schedulesPath}/${equivalent.scheduleId}`,
      currentValue: equivalent.schedule,
    });
  }

  return makePlanItem({
    legacyPath,
    classification: CLASSIFICATION.SAFE_MIGRATE_THEN_DELETE,
    reason:
      "Tạo lịch legacy_migrated và xóa legacy alarm trong cùng một update nguyên tử.",
    legacyValue,
    targetPath: migratedPath,
    proposedValue: normalized.schedule,
  });
}

function isSafeClassification(classification) {
  return classification === CLASSIFICATION.SAFE_DELETE_DUPLICATE ||
    classification === CLASSIFICATION.SAFE_MIGRATE_THEN_DELETE;
}

function buildPersonalAlarmMigrationPlan(
  accounts,
  { uidFilter = "" } = {},
) {
  const items = [];
  const updates = {};
  const safeAccounts = isPlainObject(accounts) ? accounts : {};

  for (const [uid, rawAccount] of Object.entries(safeAccounts)) {
    if (uidFilter && uid !== uidFilter) continue;

    const customRules = isPlainObject(rawAccount?.customRules)
      ? rawAccount.customRules
      : {};

    for (const [homeId, rawCustomHome] of Object.entries(customRules)) {
      const devices = isPlainObject(rawCustomHome?.devices)
        ? rawCustomHome.devices
        : {};

      for (const [deviceId, rawDevice] of Object.entries(devices)) {
        const device = isPlainObject(rawDevice) ? rawDevice : {};

        if (device.alarm === undefined || device.alarm === null) {
          continue;
        }

        const item = classifyPersonalLegacyAlarm({
          uid,
          homeId,
          deviceId,
          legacyValue: device.alarm,
          currentSchedules: device.alarmSchedules,
        });

        items.push(item);

        if (item.classification === CLASSIFICATION.SAFE_DELETE_DUPLICATE) {
          updates[item.legacyPath] = null;
        } else if (
          item.classification ===
            CLASSIFICATION.SAFE_MIGRATE_THEN_DELETE
        ) {
          updates[item.targetPath] = item.proposedValue;
          updates[item.legacyPath] = null;
        }
      }
    }
  }

  const classifications = {};
  for (const item of items) {
    classifications[item.classification] =
      (classifications[item.classification] || 0) + 1;
  }

  return {
    items,
    updates,
    summary: {
      totalLegacyNodes: items.length,
      safeChanges: items.filter((item) =>
        isSafeClassification(item.classification)
      ).length,
      conflicts: classifications[CLASSIFICATION.CONFLICT] || 0,
      keptInvalid: classifications[CLASSIFICATION.KEEP_INVALID] || 0,
      classifications,
    },
  };
}

function createMigrationReport(plan, options, generatedAt) {
  const changingItems = plan.items.filter((item) =>
    isSafeClassification(item.classification)
  );

  return {
    generatedAt,
    mode: options.apply === true ? "APPLY" : "DRY_RUN",
    scope:
      "accounts/{uid}/customRules/{homeId}/devices/{deviceId}/alarm",
    uidFilter: options.uid || "",
    summary: plan.summary,
    items: plan.items,
    backup: {
      createdBeforeFirebaseUpdate: options.apply === true,
      items: changingItems.map((item) => ({
        path: item.legacyPath,
        legacyValue: item.legacyValue,
      })),
    },
  };
}

function writeJsonFile(outputPath, value) {
  const resolvedPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(
    resolvedPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return resolvedPath;
}

async function executeMigration({
  accounts,
  options,
  rootRef = null,
  writeReport = writeJsonFile,
  now = () => new Date().toISOString(),
}) {
  validateExecutionOptions(options);

  const plan = buildPersonalAlarmMigrationPlan(accounts, {
    uidFilter: options.uid || "",
  });
  const report = createMigrationReport(plan, options, now());
  let reportPath = "";

  if (options.apply === true) {
    reportPath = await writeReport(options.output, report);

    if (Object.keys(plan.updates).length > 0) {
      if (!rootRef || typeof rootRef.update !== "function") {
        throw new Error("Thiếu Firebase root reference để APPLY.");
      }

      await rootRef.update(plan.updates);
    }

    return {
      plan,
      report,
      reportPath,
      applied: Object.keys(plan.updates).length > 0,
    };
  }

  if (options.output) {
    reportPath = await writeReport(options.output, report);
  }

  return {
    plan,
    report,
    reportPath,
    applied: false,
  };
}

function printHelp() {
  console.log(`
MAIYEN PERSONAL ALARM LEGACY MIGRATION

Mặc định: DRY RUN, không ghi Firebase.

Usage:
  node scripts/migrate_personal_alarm_legacy.js \\
    --service-account <path> \\
    [--database-url <url>] \\
    [--output <path>] \\
    [--uid <uid>]

APPLY yêu cầu đồng thời:
  --apply --confirm ${APPLY_CONFIRMATION} --output <backup-path>

Scope duy nhất:
  accounts/{uid}/customRules/{homeId}/devices/{deviceId}/alarm
`);
}

function printResult(result) {
  const { plan, report, reportPath, applied } = result;

  console.log(`\nMode: ${report.mode}`);
  console.log(`Legacy nodes analyzed: ${plan.summary.totalLegacyNodes}`);
  console.log(`Safe changes: ${plan.summary.safeChanges}`);
  console.log(`Conflicts: ${plan.summary.conflicts}`);
  console.log(`Invalid kept: ${plan.summary.keptInvalid}`);

  for (const item of plan.items) {
    console.log(`[${item.classification}] ${item.legacyPath}`);
    console.log(`  ${item.reason}`);
  }

  if (reportPath) {
    console.log(`Local report/backup written: ${reportPath}`);
  }

  console.log(
    applied
      ? "Atomic Firebase update completed."
      : "No Firebase data was modified.",
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  validateExecutionOptions(options);

  if (!options.serviceAccount) {
    throw new Error("Thiếu --service-account.");
  }

  const serviceAccountPath = path.resolve(options.serviceAccount);
  fs.accessSync(serviceAccountPath, fs.constants.R_OK);

  const admin = require("firebase-admin");
  const serviceAccount = JSON.parse(
    fs.readFileSync(serviceAccountPath, "utf8"),
  );
  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: options.databaseUrl,
  }, `personal-alarm-legacy-migration-${Date.now()}`);

  try {
    const database = app.database();
    const accountsSnapshot = await database
      .ref("accounts")
      .once("value");
    const result = await executeMigration({
      accounts: accountsSnapshot.val() || {},
      options,
      rootRef: database.ref(),
    });

    printResult(result);
  } finally {
    await app.delete();
  }
}

module.exports = {
  APPLY_CONFIRMATION,
  CLASSIFICATION,
  MIGRATED_SCHEDULE_ID,
  parseArguments,
  validateExecutionOptions,
  validateLegacyAlarm,
  classifyPersonalLegacyAlarm,
  buildPersonalAlarmMigrationPlan,
  createMigrationReport,
  executeMigration,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "PERSONAL ALARM LEGACY MIGRATION ERROR:",
      error.message,
    );
    process.exitCode = 1;
  });
}
