#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";
const APPLY_CONFIRMATION = "DELETE_UNUSED_HOME_ALARM_LEGACY";
const SECURITY_DEVICE_TYPES = new Set([
  "door",
  "window",
  "gate",
  "lock",
  "door_lock",
  "motion",
  "presence",
  "vibration",
  "glass_break",
]);

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

function normalizeDeviceType(value) {
  return String(value || "").trim().toLowerCase();
}

function inspectHomeForSafeDelete(rawHome) {
  if (!isPlainObject(rawHome)) {
    return {
      safe: false,
      reason: "home_not_plain_object",
      securityDeviceIds: [],
      scheduleDeviceIds: [],
    };
  }

  if (!Object.prototype.hasOwnProperty.call(rawHome, "alarm")) {
    return {
      safe: false,
      reason: "alarm_missing",
      securityDeviceIds: [],
      scheduleDeviceIds: [],
    };
  }

  if (!isPlainObject(rawHome.alarm)) {
    return {
      safe: false,
      reason: "alarm_not_plain_object",
      securityDeviceIds: [],
      scheduleDeviceIds: [],
    };
  }

  if (
    rawHome.devices !== undefined &&
    rawHome.devices !== null &&
    !isPlainObject(rawHome.devices)
  ) {
    return {
      safe: false,
      reason: "devices_not_plain_object",
      securityDeviceIds: [],
      scheduleDeviceIds: [],
    };
  }

  const devices = isPlainObject(rawHome.devices)
    ? rawHome.devices
    : {};
  const securityDeviceIds = [];
  const scheduleDeviceIds = [];

  for (const [deviceId, rawDevice] of Object.entries(devices)) {
    if (!isPlainObject(rawDevice)) {
      return {
        safe: false,
        reason: `device_not_plain_object_${deviceId}`,
        securityDeviceIds,
        scheduleDeviceIds,
      };
    }

    if (SECURITY_DEVICE_TYPES.has(normalizeDeviceType(rawDevice.type))) {
      securityDeviceIds.push(deviceId);
    }

    if (
      rawDevice.alarmSchedules !== undefined ||
      rawDevice.alarmPolicy !== undefined
    ) {
      scheduleDeviceIds.push(deviceId);
    }
  }

  if (securityDeviceIds.length > 0) {
    return {
      safe: false,
      reason: "security_devices_exist",
      securityDeviceIds,
      scheduleDeviceIds,
    };
  }

  if (scheduleDeviceIds.length > 0) {
    return {
      safe: false,
      reason: "alarm_schedule_or_policy_exists",
      securityDeviceIds,
      scheduleDeviceIds,
    };
  }

  return {
    safe: true,
    reason: "unused_home_alarm_without_security_devices",
    securityDeviceIds,
    scheduleDeviceIds,
  };
}

function classifyUnusedHomeAlarm({ uid, homeId, home }) {
  const legacyPath = `accounts/${uid}/homes/${homeId}/alarm`;
  const inspection = inspectHomeForSafeDelete(home);

  return {
    legacyPath,
    classification: inspection.safe
      ? CLASSIFICATION.SAFE_DELETE
      : CLASSIFICATION.KEEP,
    reason: inspection.reason,
    legacyValue: isPlainObject(home) ? home.alarm : null,
    securityDeviceIds: inspection.securityDeviceIds,
    scheduleDeviceIds: inspection.scheduleDeviceIds,
  };
}

function buildUnusedHomeAlarmCleanupPlan(
  accounts,
  { uidFilter = "" } = {},
) {
  const items = [];
  const updates = {};
  const safeAccounts = isPlainObject(accounts) ? accounts : {};

  for (const [uid, rawAccount] of Object.entries(safeAccounts)) {
    if (uidFilter && uid !== uidFilter) continue;

    const homes = isPlainObject(rawAccount?.homes)
      ? rawAccount.homes
      : {};

    for (const [homeId, rawHome] of Object.entries(homes)) {
      if (
        !isPlainObject(rawHome) ||
        !Object.prototype.hasOwnProperty.call(rawHome, "alarm") ||
        rawHome.alarm === undefined ||
        rawHome.alarm === null
      ) {
        continue;
      }

      const item = classifyUnusedHomeAlarm({
        uid,
        homeId,
        home: rawHome,
      });
      items.push(item);

      if (item.classification === CLASSIFICATION.SAFE_DELETE) {
        updates[item.legacyPath] = null;
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
    scope: "accounts/{uid}/homes/{homeId}/alarm",
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

  const plan = buildUnusedHomeAlarmCleanupPlan(accounts, {
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
MAIYEN UNUSED HOME ALARM LEGACY CLEANUP

Mặc định: DRY RUN, không ghi Firebase.

Chỉ xóa home/alarm khi:
- home/alarm là object;
- nhà không có thiết bị an ninh;
- không thiết bị nào còn alarmSchedules hoặc alarmPolicy.

Usage:
  node scripts/cleanup_unused_home_alarm_legacy.js \\
    --service-account <path> \\
    [--database-url <url>] \\
    [--output <path>] \\
    [--uid <uid>]

APPLY yêu cầu đồng thời:
  --apply --confirm ${APPLY_CONFIRMATION} --output <backup-path>
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
  }, `unused-home-alarm-cleanup-${Date.now()}`);

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
  SECURITY_DEVICE_TYPES,
  parseArguments,
  validateExecutionOptions,
  inspectHomeForSafeDelete,
  classifyUnusedHomeAlarm,
  buildUnusedHomeAlarmCleanupPlan,
  createCleanupReport,
  executeCleanup,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "UNUSED HOME ALARM LEGACY CLEANUP ERROR:",
      error.message,
    );
    process.exitCode = 1;
  });
}
