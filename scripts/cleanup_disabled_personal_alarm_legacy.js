#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";
const APPLY_CONFIRMATION = "DELETE_DISABLED_PERSONAL_ALARM_LEGACY";
const ALLOWED_REPEAT_MINUTES = new Set([0, 15, 30, 60]);
const REQUIRED_FIELDS = [
  "enabled",
  "start",
  "end",
  "repeatMinutes",
];
const ALLOWED_FIELDS = new Set(REQUIRED_FIELDS);

const CLASSIFICATION = Object.freeze({
  SAFE_DELETE: "SAFE_DELETE",
  KEEP: "KEEP",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidHHMM(value) {
  return typeof value === "string" &&
    /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function validateSafeDisabledLegacyAlarm(legacyValue) {
  if (!isPlainObject(legacyValue)) {
    return {
      safe: false,
      reason: "not_plain_object",
    };
  }

  if (Object.prototype.hasOwnProperty.call(legacyValue, "days")) {
    return {
      safe: false,
      reason: "days_exists",
    };
  }

  const unexpectedField = Reflect.ownKeys(legacyValue).find(
    (field) =>
      typeof field !== "string" || !ALLOWED_FIELDS.has(field),
  );

  if (unexpectedField !== undefined) {
    return {
      safe: false,
      reason: `unexpected_field_${String(unexpectedField)}`,
    };
  }

  const missingField = REQUIRED_FIELDS.find(
    (field) => !Object.prototype.hasOwnProperty.call(
      legacyValue,
      field,
    ),
  );

  if (missingField) {
    return {
      safe: false,
      reason: `missing_${missingField}`,
    };
  }

  if (legacyValue.enabled !== false) {
    return {
      safe: false,
      reason: "enabled_not_false",
    };
  }

  if (
    !isValidHHMM(legacyValue.start) ||
    !isValidHHMM(legacyValue.end)
  ) {
    return {
      safe: false,
      reason: "invalid_time",
    };
  }

  if (
    !Number.isInteger(legacyValue.repeatMinutes) ||
    !ALLOWED_REPEAT_MINUTES.has(legacyValue.repeatMinutes)
  ) {
    return {
      safe: false,
      reason: "invalid_repeatMinutes",
    };
  }

  return {
    safe: true,
    reason: "disabled_legacy_without_days",
  };
}

function makePlanItem({
  legacyPath,
  classification,
  reason,
  legacyValue,
}) {
  return {
    legacyPath,
    classification,
    reason,
    legacyValue,
  };
}

function classifyDisabledPersonalLegacyAlarm({
  uid,
  homeId,
  deviceId,
  legacyValue,
}) {
  const legacyPath =
    `accounts/${uid}/customRules/${homeId}/devices/${deviceId}/alarm`;
  const validation = validateSafeDisabledLegacyAlarm(legacyValue);

  return makePlanItem({
    legacyPath,
    classification: validation.safe
      ? CLASSIFICATION.SAFE_DELETE
      : CLASSIFICATION.KEEP,
    reason: validation.reason,
    legacyValue,
  });
}

function buildDisabledPersonalAlarmCleanupPlan(
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

        if (
          !Object.prototype.hasOwnProperty.call(device, "alarm") ||
          device.alarm === undefined ||
          device.alarm === null
        ) {
          continue;
        }

        const item = classifyDisabledPersonalLegacyAlarm({
          uid,
          homeId,
          deviceId,
          legacyValue: device.alarm,
        });

        items.push(item);

        if (item.classification === CLASSIFICATION.SAFE_DELETE) {
          updates[item.legacyPath] = null;
        }
      }
    }
  }

  return {
    items,
    updates,
    summary: {
      totalLegacyNodes: items.length,
      safeDeletes: items.filter(
        (item) => item.classification === CLASSIFICATION.SAFE_DELETE,
      ).length,
      kept: items.filter(
        (item) => item.classification === CLASSIFICATION.KEEP,
      ).length,
    },
  };
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
      "--apply yêu cầu --output để ghi backup trước khi xóa.",
    );
  }
}

function createCleanupReport(plan, options, generatedAt) {
  const safeItems = plan.items.filter(
    (item) => item.classification === CLASSIFICATION.SAFE_DELETE,
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
      items: safeItems.map((item) => ({
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

async function executeCleanup({
  accounts,
  options,
  rootRef = null,
  writeReport = writeJsonFile,
  now = () => new Date().toISOString(),
}) {
  validateExecutionOptions(options);

  const plan = buildDisabledPersonalAlarmCleanupPlan(accounts, {
    uidFilter: options.uid || "",
  });
  const report = createCleanupReport(plan, options, now());
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
MAIYEN DISABLED PERSONAL ALARM LEGACY CLEANUP

Mặc định: DRY RUN, không ghi Firebase.

Usage:
  node scripts/cleanup_disabled_personal_alarm_legacy.js \\
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
  console.log(`Safe deletes: ${plan.summary.safeDeletes}`);
  console.log(`Kept: ${plan.summary.kept}`);

  for (const item of plan.items) {
    console.log(`[${item.classification}] ${item.legacyPath}`);
    console.log(`  ${item.reason}`);
  }

  if (reportPath) {
    console.log(`Local report/backup written: ${reportPath}`);
  }

  console.log(
    applied
      ? "Atomic Firebase cleanup update completed."
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
  }, `disabled-personal-alarm-cleanup-${Date.now()}`);

  try {
    const database = app.database();
    const accountsSnapshot = await database
      .ref("accounts")
      .once("value");
    const result = await executeCleanup({
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
  parseArguments,
  validateExecutionOptions,
  validateSafeDisabledLegacyAlarm,
  classifyDisabledPersonalLegacyAlarm,
  buildDisabledPersonalAlarmCleanupPlan,
  createCleanupReport,
  executeCleanup,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "DISABLED PERSONAL ALARM LEGACY CLEANUP ERROR:",
      error.message,
    );
    process.exitCode = 1;
  });
}
