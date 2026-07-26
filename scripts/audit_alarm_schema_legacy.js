"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";
const DEFAULT_SAMPLE_LIMIT = 20;

const CATEGORY_DEFINITIONS = Object.freeze({
  homeAlarm: {
    label: "homes/{homeId}/alarm",
    legacy: true,
  },
  homeScheduleAlarms: {
    label: "homes/{homeId}/schedules/alarms",
    legacy: true,
  },
  deviceAlarm: {
    label: "homes/{homeId}/devices/{deviceId}/alarm (legacy schedule, non-siren)",
    legacy: true,
  },
  sirenAlarmState: {
    label: "homes/{homeId}/devices/{deviceId}/alarm (siren actuator state)",
    legacy: false,
  },
  customMode: {
    label: "customRules/{homeId}/mode",
    legacy: true,
  },
  customAlarmMode: {
    label: "customRules/{homeId}/alarmMode",
    legacy: true,
  },
  customDeviceAlarm: {
    label: "customRules/{homeId}/devices/{deviceId}/alarm",
    legacy: true,
  },
  deviceAlarmSchedules: {
    label: "homes/{homeId}/devices/{deviceId}/alarmSchedules",
    legacy: false,
  },
  customDeviceAlarmSchedules: {
    label: "customRules/{homeId}/devices/{deviceId}/alarmSchedules",
    legacy: false,
  },
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function createCategoryStats() {
  return Object.fromEntries(
    Object.entries(CATEGORY_DEFINITIONS).map(([key, definition]) => [
      key,
      {
        label: definition.label,
        legacy: definition.legacy,
        count: 0,
        samples: [],
      },
    ]),
  );
}

function recordCategory(categories, categoryKey, firebasePath, sampleLimit) {
  const category = categories[categoryKey];

  if (!category) {
    throw new Error(`Unknown audit category: ${categoryKey}`);
  }

  category.count += 1;

  if (category.samples.length < sampleLimit) {
    category.samples.push(firebasePath);
  }
}

function scanAccountsForAlarmSchema(rawAccounts, options = {}) {
  const accounts = isObject(rawAccounts) ? rawAccounts : {};
  const sampleLimit = Math.max(
    0,
    Number.parseInt(options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT, 10) || 0,
  );
  const onlyUid = String(options.onlyUid || "").trim();
  const categories = createCategoryStats();
  const totals = {
    accounts: 0,
    homes: 0,
    devices: 0,
    customHomes: 0,
    customDevices: 0,
  };

  for (const [uid, rawAccount] of Object.entries(accounts)) {
    if (onlyUid && uid !== onlyUid) {
      continue;
    }

    const account = isObject(rawAccount) ? rawAccount : {};
    totals.accounts += 1;

    const homes = isObject(account.homes) ? account.homes : {};

    for (const [homeId, rawHome] of Object.entries(homes)) {
      const home = isObject(rawHome) ? rawHome : {};
      const homeBasePath = `accounts/${uid}/homes/${homeId}`;
      totals.homes += 1;

      if (hasOwn(home, "alarm") && home.alarm !== null) {
        recordCategory(
          categories,
          "homeAlarm",
          `${homeBasePath}/alarm`,
          sampleLimit,
        );
      }

      const schedules = isObject(home.schedules) ? home.schedules : {};
      if (
        hasOwn(schedules, "alarms") &&
        schedules.alarms !== null
      ) {
        recordCategory(
          categories,
          "homeScheduleAlarms",
          `${homeBasePath}/schedules/alarms`,
          sampleLimit,
        );
      }

      const devices = isObject(home.devices) ? home.devices : {};

      for (const [deviceId, rawDevice] of Object.entries(devices)) {
        const device = isObject(rawDevice) ? rawDevice : {};
        const deviceBasePath = `${homeBasePath}/devices/${deviceId}`;
        totals.devices += 1;

        if (hasOwn(device, "alarm") && device.alarm !== null) {
          const deviceType = String(device.type || "")
            .trim()
            .toLowerCase();
          recordCategory(
            categories,
            deviceType === "siren"
              ? "sirenAlarmState"
              : "deviceAlarm",
            `${deviceBasePath}/alarm`,
            sampleLimit,
          );
        }

        if (
          hasOwn(device, "alarmSchedules") &&
          device.alarmSchedules !== null
        ) {
          recordCategory(
            categories,
            "deviceAlarmSchedules",
            `${deviceBasePath}/alarmSchedules`,
            sampleLimit,
          );
        }
      }
    }

    const customRules = isObject(account.customRules)
      ? account.customRules
      : {};

    for (const [homeId, rawCustomHome] of Object.entries(customRules)) {
      const customHome = isObject(rawCustomHome) ? rawCustomHome : {};
      const customHomeBasePath = `accounts/${uid}/customRules/${homeId}`;
      totals.customHomes += 1;

      if (hasOwn(customHome, "mode") && customHome.mode !== null) {
        recordCategory(
          categories,
          "customMode",
          `${customHomeBasePath}/mode`,
          sampleLimit,
        );
      }

      if (
        hasOwn(customHome, "alarmMode") &&
        customHome.alarmMode !== null
      ) {
        recordCategory(
          categories,
          "customAlarmMode",
          `${customHomeBasePath}/alarmMode`,
          sampleLimit,
        );
      }

      const customDevices = isObject(customHome.devices)
        ? customHome.devices
        : {};

      for (const [deviceId, rawCustomDevice] of Object.entries(customDevices)) {
        const customDevice = isObject(rawCustomDevice)
          ? rawCustomDevice
          : {};
        const customDeviceBasePath =
          `${customHomeBasePath}/devices/${deviceId}`;
        totals.customDevices += 1;

        if (
          hasOwn(customDevice, "alarm") &&
          customDevice.alarm !== null
        ) {
          recordCategory(
            categories,
            "customDeviceAlarm",
            `${customDeviceBasePath}/alarm`,
            sampleLimit,
          );
        }

        if (
          hasOwn(customDevice, "alarmSchedules") &&
          customDevice.alarmSchedules !== null
        ) {
          recordCategory(
            categories,
            "customDeviceAlarmSchedules",
            `${customDeviceBasePath}/alarmSchedules`,
            sampleLimit,
          );
        }
      }
    }
  }

  const legacyNodeCount = Object.values(categories)
    .filter((category) => category.legacy)
    .reduce((sum, category) => sum + category.count, 0);
  const currentNodeCount = Object.values(categories)
    .filter((category) => !category.legacy)
    .reduce((sum, category) => sum + category.count, 0);

  return {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    filter: onlyUid ? { uid: onlyUid } : null,
    totals,
    summary: {
      legacyNodeCount,
      currentNodeCount,
      legacyDataFound: legacyNodeCount > 0,
    },
    categories,
  };
}

function parseArguments(argv) {
  const options = {
    onlyUid: "",
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
    outputPath: "",
    serviceAccountPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--uid") {
      options.onlyUid = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }

    if (argument === "--sample-limit") {
      options.sampleLimit = Math.max(
        0,
        Number.parseInt(argv[index + 1] || "", 10) || 0,
      );
      index += 1;
      continue;
    }

    if (argument === "--output") {
      options.outputPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }

    if (argument === "--service-account") {
      options.serviceAccountPath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function printHelp() {
  console.log(`MaiYen Alarm schema audit (READ ONLY)\n\nUsage:\n  node scripts/audit_alarm_schema_legacy.js [options]\n\nOptions:\n  --uid <uid>                 Chỉ audit một tài khoản\n  --sample-limit <number>     Số đường dẫn mẫu mỗi nhóm, mặc định 20\n  --output <file.json>        Ghi thêm báo cáo JSON ra file cục bộ\n  --service-account <file>    Đường dẫn serviceAccount.json của backend\n  -h, --help                  Hiển thị hướng dẫn\n`);
}

function printHumanReport(report) {
  console.log("\n=== MAIYEN ALARM SCHEMA AUDIT (READ ONLY) ===");
  console.log(`Generated: ${report.generatedAt}`);
  console.log(
    `Accounts=${report.totals.accounts}, Homes=${report.totals.homes}, ` +
    `Devices=${report.totals.devices}, CustomHomes=${report.totals.customHomes}, ` +
    `CustomDevices=${report.totals.customDevices}`,
  );
  console.log(
    `Legacy nodes=${report.summary.legacyNodeCount}, ` +
    `Current schema/state nodes=${report.summary.currentNodeCount}`,
  );

  for (const category of Object.values(report.categories)) {
    const marker = category.legacy ? "LEGACY" : "CURRENT";
    console.log(`\n[${marker}] ${category.label}: ${category.count}`);

    for (const sample of category.samples) {
      console.log(`  - ${sample}`);
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

  // Lazy require để unit test phần scanner không cần khởi tạo Firebase.
  const admin = require("firebase-admin");
  const requestedServiceAccountPath =
    options.serviceAccountPath ||
    process.env.MAIYEN_SERVICE_ACCOUNT_PATH ||
    "";
  const candidatePaths = [
    requestedServiceAccountPath,
    path.resolve(__dirname, "..", "serviceAccount.json"),
    "/opt/maiyen-hub-backend/serviceAccount.json",
  ]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  const serviceAccountPath = candidatePaths.find((candidate) =>
    fs.existsSync(candidate),
  );

  if (!serviceAccountPath) {
    throw new Error(
      `Không tìm thấy serviceAccount.json. Đã kiểm tra: ${candidatePaths.join(", ")}`,
    );
  }

  if (admin.apps.length === 0) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL:
        process.env.MAIYEN_DATABASE_URL ||
        DEFAULT_DATABASE_URL,
    });
  }

  const snapshot = await admin.database().ref("accounts").once("value");
  const report = scanAccountsForAlarmSchema(snapshot.val(), options);
  printHumanReport(report);

  if (options.outputPath) {
    const outputPath = path.resolve(process.cwd(), options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    console.log(`\nLocal report written: ${outputPath}`);
  }

  await admin.app().delete();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("ALARM SCHEMA AUDIT ERROR:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CATEGORY_DEFINITIONS,
  scanAccountsForAlarmSchema,
  parseArguments,
};
