#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";

const ALLOWED_REPEAT_MINUTES = new Set([0, 15, 30, 60]);

function parseArguments(argv) {
  const options = {
    serviceAccount: "",
    databaseUrl: DEFAULT_DATABASE_URL,
    output: "",
    uid: "",
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
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Tham số không hợp lệ: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
MAIYEN ALARM SCHEMA MIGRATION PLAN (READ ONLY)

Usage:
  node scripts/plan_alarm_schema_migration.js \\
    --service-account /opt/maiyen-hub-backend/serviceAccount.json \\
    --output reports/alarm_schema_migration_plan.json

Options:
  --service-account <path>  Đường dẫn Firebase Admin service account.
  --database-url <url>      Realtime Database URL.
  --output <path>           File JSON báo cáo cục bộ.
  --uid <uid>               Chỉ kiểm tra một tài khoản.
  --help                    Hiện trợ giúp.

Script này KHÔNG gọi set(), update(), remove() hoặc transaction().
`);
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value),
  );
}

function normalizeDays(value) {
  const raw = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.keys(value)
          .sort((a, b) => Number(a) - Number(b))
          .map((key) => value[key])
      : [];

  const result = [...new Set(
    raw
      .map((item) => Number.parseInt(item, 10))
      .filter((day) => day >= 1 && day <= 7),
  )].sort((a, b) => a - b);

  return result.length > 0 ? result : [1, 2, 3, 4, 5, 6, 7];
}

function isValidHHMM(value) {
  return typeof value === "string" &&
    /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function normalizeRepeatMinutes(value) {
  const parsed = Number.parseInt(value ?? 0, 10);
  return ALLOWED_REPEAT_MINUTES.has(parsed) ? parsed : null;
}

function normalizeLegacySchedule(value) {
  if (!isPlainObject(value)) {
    return {
      valid: false,
      reason: "not_object",
      schedule: null,
    };
  }

  const repeatMinutes = normalizeRepeatMinutes(value.repeatMinutes);

  if (
    typeof value.enabled !== "boolean" ||
    !isValidHHMM(value.start) ||
    !isValidHHMM(value.end) ||
    repeatMinutes === null
  ) {
    return {
      valid: false,
      reason: "invalid_required_fields",
      schedule: null,
    };
  }

  return {
    valid: true,
    reason: "",
    schedule: {
      enabled: value.enabled,
      start: value.start,
      end: value.end,
      repeatMinutes,
      days: normalizeDays(value.days),
    },
  };
}

function scheduleFingerprint(value) {
  const normalized = normalizeLegacySchedule(value);
  if (!normalized.valid) return "";

  const schedule = normalized.schedule;
  return [
    schedule.enabled ? "1" : "0",
    schedule.start,
    schedule.end,
    String(schedule.repeatMinutes),
    schedule.days.join(","),
  ].join("|");
}

function findEquivalentSchedule(rawSchedules, legacySchedule) {
  if (!isPlainObject(rawSchedules)) return null;

  const target = scheduleFingerprint(legacySchedule);
  if (!target) return null;

  for (const [scheduleId, schedule] of Object.entries(rawSchedules)) {
    if (scheduleFingerprint(schedule) === target) {
      return {
        scheduleId,
        schedule,
      };
    }
  }

  return null;
}

function makeItem({
  path: itemPath,
  legacyType,
  classification,
  recommendedAction,
  reason,
  legacyValue,
  currentPath = "",
  currentValue = null,
  proposedValue = null,
}) {
  return {
    path: itemPath,
    legacyType,
    classification,
    recommendedAction,
    reason,
    legacyValue,
    currentPath,
    currentValue,
    proposedValue,
  };
}

function classifyDeviceLegacyAlarm({
  legacyPath,
  legacyType,
  legacyValue,
  currentPath,
  currentSchedules,
}) {
  const normalized = normalizeLegacySchedule(legacyValue);

  if (!normalized.valid) {
    return makeItem({
      path: legacyPath,
      legacyType,
      classification: "MANUAL_REVIEW_INVALID",
      recommendedAction: "KEEP",
      reason:
        `Dữ liệu lịch không hợp lệ (${normalized.reason}); không tự chuyển hoặc xóa.`,
      legacyValue,
      currentPath,
      currentValue: currentSchedules || null,
    });
  }

  const equivalent = findEquivalentSchedule(
    currentSchedules,
    legacyValue,
  );

  if (equivalent) {
    return makeItem({
      path: legacyPath,
      legacyType,
      classification: "SAFE_DELETE_DUPLICATE",
      recommendedAction: "DELETE_LEGACY_ONLY",
      reason:
        `Schema mới đã có lịch tương đương tại ${currentPath}/${equivalent.scheduleId}.`,
      legacyValue,
      currentPath: `${currentPath}/${equivalent.scheduleId}`,
      currentValue: equivalent.schedule,
    });
  }

  const proposedId = "legacy_migrated";
  const occupied = isPlainObject(currentSchedules) &&
    Object.prototype.hasOwnProperty.call(
      currentSchedules,
      proposedId,
    );

  if (occupied) {
    return makeItem({
      path: legacyPath,
      legacyType,
      classification: "MANUAL_REVIEW_ID_CONFLICT",
      recommendedAction: "KEEP",
      reason:
        `${currentPath}/${proposedId} đã tồn tại nhưng không tương đương.`,
      legacyValue,
      currentPath: `${currentPath}/${proposedId}`,
      currentValue: currentSchedules[proposedId],
      proposedValue: normalized.schedule,
    });
  }

  return makeItem({
    path: legacyPath,
    legacyType,
    classification: "SAFE_MIGRATE_THEN_DELETE",
    recommendedAction: "CREATE_CURRENT_THEN_DELETE_LEGACY",
    reason:
      "Lịch legacy hợp lệ và chưa có lịch tương đương trong alarmSchedules.",
    legacyValue,
    currentPath: `${currentPath}/${proposedId}`,
    currentValue: null,
    proposedValue: normalized.schedule,
  });
}

function classifyHomeAlarm({
  uid,
  homeId,
  value,
  home,
}) {
  const itemPath = `accounts/${uid}/homes/${homeId}/alarm`;
  const devices = isPlainObject(home?.devices) ? home.devices : {};
  const securityDevices = Object.entries(devices)
    .filter(([, device]) => {
      const type = String(device?.type || "").toLowerCase();
      return [
        "door",
        "window",
        "gate",
        "door_lock",
        "lock",
        "motion",
        "presence",
        "vibration",
        "glass_break",
      ].includes(type);
    })
    .map(([deviceId]) => deviceId);

  const hasSecurityDevices = securityDevices.length > 0;

  return makeItem({
    path: itemPath,
    legacyType: "home_alarm",
    classification: hasSecurityDevices
      ? "MANUAL_REVIEW_NO_1_TO_1_MAPPING"
      : "SAFE_DELETE_UNUSED_HOME_ALARM",
    recommendedAction: hasSecurityDevices
      ? "KEEP"
      : "DELETE_LEGACY_ONLY",
    reason: hasSecurityDevices
      ? (
        "home/alarm là cấu hình cấp nhà cũ; mô hình mới là policy/lịch theo từng thiết bị. " +
        `Nhà có ${securityDevices.length} thiết bị an ninh nên không tự nhân cấu hình này sang tất cả thiết bị.`
      )
      : (
        "Backend không còn đọc home/alarm và nhà không có thiết bị an ninh; " +
        "node này có thể xóa bằng script cleanup chuyên dụng sau khi tạo backup."
      ),
    legacyValue: value,
    currentPath: `accounts/${uid}/homes/${homeId}/devices/*/alarmPolicy|alarmSchedules`,
    currentValue: {
      securityDeviceIds: securityDevices,
    },
  });
}

function classifyModeNodes({
  uid,
  homeId,
  customHome,
}) {
  const items = [];
  const mode = customHome?.mode;
  const alarmMode = customHome?.alarmMode;
  const reminderMode = customHome?.reminderMode;
  const isValidMode = (value) => {
    return typeof value === "string" &&
      ["home", "custom"].includes(value.trim().toLowerCase());
  };

  if (mode !== undefined && mode !== null) {
    const modeValid = isValidMode(mode);
    const reminderMissing =
      reminderMode === undefined || reminderMode === null;
    const reminderValid =
      reminderMissing || isValidMode(reminderMode);

    items.push(makeItem({
      path: `accounts/${uid}/customRules/${homeId}/mode`,
      legacyType: "custom_mode",
      classification:
        modeValid && reminderValid
          ? reminderMissing
            ? "SAFE_MIGRATE_REMINDER_MODE_THEN_DELETE"
            : "SAFE_DELETE_LEGACY_MODE"
          : "MANUAL_REVIEW_INVALID_MODE",
      recommendedAction:
        modeValid && reminderValid
          ? reminderMissing
            ? "COPY_TO_REMINDER_MODE_THEN_DELETE"
            : "DELETE_LEGACY_ONLY"
          : "KEEP",
      reason:
        modeValid && reminderValid
          ? reminderMissing
            ? "Backend chỉ dùng reminderMode; copy mode hiện tại sang reminderMode rồi xóa mode."
            : "reminderMode đã hợp lệ; mode không còn consumer trong backend."
          : "mode hoặc reminderMode không hợp lệ; không tự sửa hoặc xóa.",
      legacyValue: mode,
      currentPath:
        `accounts/${uid}/customRules/${homeId}/reminderMode`,
      currentValue: reminderMode ?? null,
      proposedValue:
        modeValid && reminderMissing
          ? String(mode).trim().toLowerCase()
          : null,
    }));
  }

  if (alarmMode !== undefined && alarmMode !== null) {
    const alarmModeValid = isValidMode(alarmMode);

    items.push(makeItem({
      path: `accounts/${uid}/customRules/${homeId}/alarmMode`,
      legacyType: "custom_alarm_mode",
      classification: alarmModeValid
        ? "SAFE_DELETE_LEGACY_ALARM_MODE"
        : "MANUAL_REVIEW_INVALID_ALARM_MODE",
      recommendedAction: alarmModeValid
        ? "DELETE_LEGACY_ONLY"
        : "KEEP",
      reason: alarmModeValid
        ? "Backend Alarm chỉ dùng alarmPreferences và alarmSchedules; alarmMode không còn consumer."
        : "alarmMode không hợp lệ; không tự xóa.",
      legacyValue: alarmMode,
      currentPath:
        `accounts/${uid}/customRules/${homeId}/devices/*/alarmPreferences`,
      currentValue: null,
    }));
  }

  return items;
}

function buildMigrationPlan(accounts, { uidFilter = "" } = {}) {
  const items = [];
  const currentSirenAlarmStatePaths = [];
  const selectedAccounts = isPlainObject(accounts) ? accounts : {};

  for (const [uid, account] of Object.entries(selectedAccounts)) {
    if (uidFilter && uid !== uidFilter) continue;

    const homes = isPlainObject(account?.homes)
      ? account.homes
      : {};

    for (const [homeId, home] of Object.entries(homes)) {
      if (home?.alarm !== undefined && home?.alarm !== null) {
        items.push(classifyHomeAlarm({
          uid,
          homeId,
          value: home.alarm,
          home,
        }));
      }

      for (const [deviceId, device] of Object.entries(
        isPlainObject(home?.devices) ? home.devices : {},
      )) {
        if (device?.alarm === undefined || device?.alarm === null) {
          continue;
        }

        const deviceType = String(device?.type || "")
          .trim()
          .toLowerCase();
        const alarmPath =
          `accounts/${uid}/homes/${homeId}/devices/${deviceId}/alarm`;

        if (deviceType === "siren") {
          currentSirenAlarmStatePaths.push(alarmPath);
          continue;
        }

        items.push(classifyDeviceLegacyAlarm({
          legacyPath: alarmPath,
          legacyType: "home_device_alarm",
          legacyValue: device.alarm,
          currentPath:
            `accounts/${uid}/homes/${homeId}/devices/${deviceId}/alarmSchedules`,
          currentSchedules: device.alarmSchedules,
        }));
      }
    }

    const customRules = isPlainObject(account?.customRules)
      ? account.customRules
      : {};

    for (const [homeId, customHome] of Object.entries(customRules)) {
      items.push(...classifyModeNodes({
        uid,
        homeId,
        customHome,
      }));

      for (const [deviceId, device] of Object.entries(
        isPlainObject(customHome?.devices)
          ? customHome.devices
          : {},
      )) {
        if (device?.alarm === undefined || device?.alarm === null) {
          continue;
        }

        items.push(classifyDeviceLegacyAlarm({
          legacyPath:
            `accounts/${uid}/customRules/${homeId}/devices/${deviceId}/alarm`,
          legacyType: "personal_device_alarm",
          legacyValue: device.alarm,
          currentPath:
            `accounts/${uid}/customRules/${homeId}/devices/${deviceId}/alarmSchedules`,
          currentSchedules: device.alarmSchedules,
        }));
      }
    }
  }

  const counts = {};
  for (const item of items) {
    counts[item.classification] =
      (counts[item.classification] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: {
      totalLegacyNodes: items.length,
      classifications: counts,
      safeAutomaticCandidates: items.filter((item) =>
        item.classification.startsWith("SAFE_")
      ).length,
      manualReviewRequired: items.filter((item) =>
        item.classification.startsWith("MANUAL_REVIEW") ||
        item.classification.startsWith("CONFLICT")
      ).length,
      currentSirenAlarmStateCount:
        currentSirenAlarmStatePaths.length,
    },
    currentSirenAlarmStatePaths,
    items,
  };
}

function printPlan(plan) {
  console.log("\n=== MAIYEN ALARM SCHEMA MIGRATION PLAN (READ ONLY) ===");
  console.log(`Generated: ${plan.generatedAt}`);
  console.log(`Legacy nodes analyzed: ${plan.summary.totalLegacyNodes}`);
  console.log(
    `Safe automatic candidates: ${plan.summary.safeAutomaticCandidates}`,
  );
  console.log(
    `Manual review required: ${plan.summary.manualReviewRequired}`,
  );
  console.log(
    `Current siren alarm-state nodes: ${plan.summary.currentSirenAlarmStateCount}`,
  );

  console.log("\nClassifications:");
  for (const [name, count] of Object.entries(
    plan.summary.classifications,
  ).sort()) {
    console.log(`  ${name}: ${count}`);
  }

  console.log("\nDetails:");
  for (const item of plan.items) {
    console.log(`[${item.classification}] ${item.path}`);
    console.log(`  action: ${item.recommendedAction}`);
    console.log(`  reason: ${item.reason}`);
    if (item.currentPath) {
      console.log(`  current: ${item.currentPath}`);
    }
  }

  if (plan.currentSirenAlarmStatePaths.length > 0) {
    console.log("\nCurrent siren actuator states (not legacy schedules):");
    for (const itemPath of plan.currentSirenAlarmStatePaths) {
      console.log(`  - ${itemPath}`);
    }
  }

  console.log("\nNo Firebase data was modified.");
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
  }, `alarm-schema-plan-${Date.now()}`);

  try {
    const snapshot = await app.database()
      .ref("accounts")
      .once("value");
    const accounts = snapshot.val() || {};
    const plan = buildMigrationPlan(accounts, {
      uidFilter: options.uid,
    });

    printPlan(plan);

    if (options.output) {
      const outputPath = path.resolve(options.output);
      fs.mkdirSync(path.dirname(outputPath), {
        recursive: true,
      });
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify(plan, null, 2)}\n`,
        "utf8",
      );
      console.log(`\nLocal report written: ${outputPath}`);
    }
  } finally {
    await app.delete();
  }
}

module.exports = {
  parseArguments,
  normalizeDays,
  normalizeLegacySchedule,
  scheduleFingerprint,
  findEquivalentSchedule,
  classifyDeviceLegacyAlarm,
  classifyHomeAlarm,
  classifyModeNodes,
  buildMigrationPlan,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(
      "ALARM SCHEMA MIGRATION PLAN ERROR:",
      error.message,
    );
    process.exitCode = 1;
  });
}
