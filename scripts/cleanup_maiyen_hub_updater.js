#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE_ROOT =
  process.env.MAIYEN_UPDATER_STATE_ROOT || "/var/lib/maiyen-updater";
const DEFAULT_BACKUP_ROOT =
  process.env.MAIYEN_UPDATE_BACKUP_ROOT || "/var/backups/maiyen-hub";
const DEFAULT_OTA_BACKUP_KEEP_COUNT = 3;
const DEFAULT_MANUAL_BACKUP_KEEP_COUNT = 3;
const DEFAULT_ARCHIVE_KEEP_COUNT = 30;
const DEFAULT_ARCHIVE_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_WORK_MAX_AGE_MS = DAY_MS;
const DEFAULT_REQUEST_MAX_AGE_MS = DAY_MS;
const DEFAULT_RESULT_MAX_AGE_MS = 7 * DAY_MS;
const DEFAULT_TEMP_MAX_AGE_MS = DAY_MS;

const OTA_BACKUP_NAME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-.+$/;
const MANUAL_BACKUP_NAME_PATTERN = /^\d{8}_\d{6}$/;

function positiveInteger(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArguments(argv) {
  const stateRoot =
    process.env.MAIYEN_UPDATER_STATE_ROOT || DEFAULT_STATE_ROOT;
  const backupRoot =
    process.env.MAIYEN_UPDATE_BACKUP_ROOT || DEFAULT_BACKUP_ROOT;

  const options = {
    stateRoot,
    backupRoot,
    workRoot: path.join(stateRoot, "work"),
    archiveRoot: path.join(stateRoot, "archive"),
    requestFile: path.join(stateRoot, "inbox", "update-request.json"),
    resultFile: path.join(stateRoot, "outbox", "update-result.json"),
    otaBackupKeepCount: positiveInteger(
      process.env.MAIYEN_OTA_BACKUP_KEEP_COUNT,
      DEFAULT_OTA_BACKUP_KEEP_COUNT,
    ),
    manualBackupKeepCount: positiveInteger(
      process.env.MAIYEN_MANUAL_BACKUP_KEEP_COUNT,
      DEFAULT_MANUAL_BACKUP_KEEP_COUNT,
    ),
    archiveKeepCount: positiveInteger(
      process.env.MAIYEN_UPDATE_ARCHIVE_KEEP_COUNT,
      DEFAULT_ARCHIVE_KEEP_COUNT,
    ),
    archiveMaxAgeMs:
      positiveNumber(
        process.env.MAIYEN_UPDATE_ARCHIVE_MAX_AGE_DAYS,
        DEFAULT_ARCHIVE_MAX_AGE_MS / DAY_MS,
      ) * DAY_MS,
    workMaxAgeMs:
      positiveNumber(
        process.env.MAIYEN_UPDATE_WORK_MAX_AGE_HOURS,
        DEFAULT_WORK_MAX_AGE_MS / (60 * 60 * 1000),
      ) *
      60 *
      60 *
      1000,
    requestMaxAgeMs:
      positiveNumber(
        process.env.MAIYEN_UPDATE_REQUEST_MAX_AGE_HOURS,
        DEFAULT_REQUEST_MAX_AGE_MS / (60 * 60 * 1000),
      ) *
      60 *
      60 *
      1000,
    resultMaxAgeMs:
      positiveNumber(
        process.env.MAIYEN_UPDATE_RESULT_MAX_AGE_DAYS,
        DEFAULT_RESULT_MAX_AGE_MS / DAY_MS,
      ) * DAY_MS,
    tempMaxAgeMs:
      positiveNumber(
        process.env.MAIYEN_UPDATE_TEMP_MAX_AGE_HOURS,
        DEFAULT_TEMP_MAX_AGE_MS / (60 * 60 * 1000),
      ) *
      60 *
      60 *
      1000,
    nowMs: Date.now(),
    dryRun: false,
  };

  const explicitPaths = new Set();
  const valueOptions = {
    "--state-root": "stateRoot",
    "--backup-root": "backupRoot",
    "--work-root": "workRoot",
    "--archive-root": "archiveRoot",
    "--request": "requestFile",
    "--result": "resultFile",
    "--ota-backups": "otaBackupKeepCount",
    "--manual-backups": "manualBackupKeepCount",
    "--archive-count": "archiveKeepCount",
    "--archive-days": "archiveMaxAgeDays",
    "--work-hours": "workMaxAgeHours",
    "--request-hours": "requestMaxAgeHours",
    "--result-days": "resultMaxAgeDays",
    "--temp-hours": "tempMaxAgeHours",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const rawArgument = argv[index];
    if (rawArgument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const key = valueOptions[rawArgument];
    if (!key) continue;
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`missing_value_for_${rawArgument}`);
    }
    index += 1;

    if (key === "stateRoot" || key === "backupRoot") {
      options[key] = value;
      explicitPaths.add(key);
      continue;
    }
    if (
      key === "workRoot" ||
      key === "archiveRoot" ||
      key === "requestFile" ||
      key === "resultFile"
    ) {
      options[key] = value;
      explicitPaths.add(key);
      continue;
    }
    if (key.endsWith("Count")) {
      options[key] = positiveInteger(value, options[key]);
      continue;
    }
    if (key === "archiveMaxAgeDays") {
      options.archiveMaxAgeMs = positiveNumber(value, 30) * DAY_MS;
      continue;
    }
    if (key === "workMaxAgeHours") {
      options.workMaxAgeMs = positiveNumber(value, 24) * 60 * 60 * 1000;
      continue;
    }
    if (key === "requestMaxAgeHours") {
      options.requestMaxAgeMs = positiveNumber(value, 24) * 60 * 60 * 1000;
      continue;
    }
    if (key === "resultMaxAgeDays") {
      options.resultMaxAgeMs = positiveNumber(value, 7) * DAY_MS;
      continue;
    }
    if (key === "tempMaxAgeHours") {
      options.tempMaxAgeMs = positiveNumber(value, 24) * 60 * 60 * 1000;
    }
  }

  if (explicitPaths.has("stateRoot")) {
    if (!explicitPaths.has("workRoot")) {
      options.workRoot = path.join(options.stateRoot, "work");
    }
    if (!explicitPaths.has("archiveRoot")) {
      options.archiveRoot = path.join(options.stateRoot, "archive");
    }
    if (!explicitPaths.has("requestFile")) {
      options.requestFile = path.join(
        options.stateRoot,
        "inbox",
        "update-request.json",
      );
    }
    if (!explicitPaths.has("resultFile")) {
      options.resultFile = path.join(
        options.stateRoot,
        "outbox",
        "update-result.json",
      );
    }
  }

  return options;
}

function assertRoot() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("hub_cleanup_requires_root");
  }
}

function isDirectChild(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return path.dirname(child) === parent;
}

function safeRemove(parentPath, targetPath, dryRun) {
  if (!isDirectChild(parentPath, targetPath)) {
    throw new Error(`refusing_to_remove_unmanaged_path:${targetPath}`);
  }
  if (!dryRun) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function entryMetadata(rootPath, entry) {
  const fullPath = path.join(rootPath, entry.name);
  const stat = fs.lstatSync(fullPath);
  return {
    name: entry.name,
    fullPath,
    mtimeMs: stat.mtimeMs,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymbolicLink: entry.isSymbolicLink(),
  };
}

function listEntries(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  return fs
    .readdirSync(rootPath, { withFileTypes: true })
    .map((entry) => entryMetadata(rootPath, entry));
}

function sortNewestFirst(entries) {
  return [...entries].sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
  );
}

function pruneByCount({
  rootPath,
  entries,
  keepCount,
  dryRun,
  removedPaths,
}) {
  const ordered = sortNewestFirst(entries);
  for (const item of ordered.slice(Math.max(0, keepCount))) {
    safeRemove(rootPath, item.fullPath, dryRun);
    removedPaths.push(item.fullPath);
  }
}

function pruneOtaBackups(backupRoot, keepCount, dryRun, removedPaths) {
  const entries = listEntries(backupRoot).filter(
    (item) =>
      item.isDirectory &&
      !item.isSymbolicLink &&
      OTA_BACKUP_NAME_PATTERN.test(item.name) &&
      fs.existsSync(path.join(item.fullPath, "source.tar.gz")),
  );
  pruneByCount({
    rootPath: backupRoot,
    entries,
    keepCount,
    dryRun,
    removedPaths,
  });
}

function pruneManualBackups(backupRoot, keepCount, dryRun, removedPaths) {
  const manualRoot = path.join(backupRoot, "manual-deploy");
  const entries = listEntries(manualRoot).filter(
    (item) =>
      item.isDirectory &&
      !item.isSymbolicLink &&
      MANUAL_BACKUP_NAME_PATTERN.test(item.name),
  );
  pruneByCount({
    rootPath: manualRoot,
    entries,
    keepCount,
    dryRun,
    removedPaths,
  });
}

function pruneArchive({
  archiveRoot,
  keepCount,
  maxAgeMs,
  nowMs,
  dryRun,
  removedPaths,
}) {
  const candidates = listEntries(archiveRoot).filter(
    (item) => item.isFile && !item.isSymbolicLink && item.name.endsWith(".json"),
  );
  const alreadyRemoved = new Set();

  for (const item of candidates) {
    if (nowMs - item.mtimeMs <= maxAgeMs) continue;
    safeRemove(archiveRoot, item.fullPath, dryRun);
    removedPaths.push(item.fullPath);
    alreadyRemoved.add(item.fullPath);
  }

  const remaining = candidates.filter(
    (item) => !alreadyRemoved.has(item.fullPath),
  );
  pruneByCount({
    rootPath: archiveRoot,
    entries: remaining,
    keepCount,
    dryRun,
    removedPaths,
  });
}

function removeStaleWork({
  workRoot,
  maxAgeMs,
  nowMs,
  dryRun,
  removedPaths,
}) {
  for (const item of listEntries(workRoot)) {
    if (item.isSymbolicLink || nowMs - item.mtimeMs <= maxAgeMs) continue;
    safeRemove(workRoot, item.fullPath, dryRun);
    removedPaths.push(item.fullPath);
  }
}

function removeStaleTemporaryFiles({
  directory,
  maxAgeMs,
  nowMs,
  dryRun,
  removedPaths,
}) {
  for (const item of listEntries(directory)) {
    if (
      !item.isFile ||
      item.isSymbolicLink ||
      !item.name.includes(".tmp-") ||
      nowMs - item.mtimeMs <= maxAgeMs
    ) {
      continue;
    }
    safeRemove(directory, item.fullPath, dryRun);
    removedPaths.push(item.fullPath);
  }
}

function atomicWriteJson(filePath, value) {
  const targetPath = path.resolve(filePath);
  const directory = path.dirname(targetPath);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", mode: 0o660 },
  );
  fs.renameSync(temporaryPath, targetPath);
}

function readJsonObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch (_) {
    return null;
  }
}

function readReleaseId(filePath) {
  try {
    const value = readJsonObject(filePath);
    const releaseId = String(
      value?.manifest?.releaseId || value?.releaseId || "unknown",
    )
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
    return releaseId || "unknown";
  } catch (_) {
    return "unknown";
  }
}

function archiveStaleRequest({
  requestFile,
  resultFile,
  archiveRoot,
  maxAgeMs,
  nowMs,
  dryRun,
  archivedPaths,
  recoveryResults,
}) {
  if (!fs.existsSync(requestFile)) return;
  const stat = fs.lstatSync(requestFile);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  if (nowMs - stat.mtimeMs <= maxAgeMs) return;

  const request = readJsonObject(requestFile);
  const releaseId = readReleaseId(requestFile);
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  let destination = path.join(
    archiveRoot,
    `${stamp}-${releaseId}-stale.json`,
  );
  let suffix = 0;
  while (fs.existsSync(destination)) {
    suffix += 1;
    destination = path.join(
      archiveRoot,
      `${stamp}-${releaseId}-stale-${suffix}.json`,
    );
  }

  const ownerUid = String(request?.ownerUid || "").trim();
  const homeId = String(request?.homeId || "").trim();
  const requestedBy = String(request?.requestedBy || "").trim();
  const canCreateRecoveryResult =
    ownerUid &&
    homeId &&
    releaseId !== "unknown" &&
    !fs.existsSync(resultFile);

  if (!dryRun) {
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o770 });
    fs.renameSync(requestFile, destination);
    fs.chmodSync(destination, 0o660);

    if (canCreateRecoveryResult) {
      atomicWriteJson(resultFile, {
        resultSchemaVersion: 1,
        releaseId,
        ownerUid,
        homeId,
        requestedBy,
        startedAt:
          Number(request?.queuedAt || request?.requestedAt) || stat.mtimeMs,
        status: "failed",
        finishedAt: nowMs,
        errorCode: "stale_update_request",
        errorMessage:
          "Update request expired before the updater could process it.",
        backupDirectory: "",
      });
    }
  }
  archivedPaths.push(destination);
  if (canCreateRecoveryResult) {
    recoveryResults.push(resultFile);
  }
}

function removeStaleResult({
  resultFile,
  maxAgeMs,
  nowMs,
  dryRun,
  removedPaths,
}) {
  if (!fs.existsSync(resultFile)) return;
  const stat = fs.lstatSync(resultFile);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  if (nowMs - stat.mtimeMs <= maxAgeMs) return;

  const parent = path.dirname(resultFile);
  safeRemove(parent, resultFile, dryRun);
  removedPaths.push(resultFile);
}

function cleanupUpdaterState(rawOptions = {}) {
  const stateRoot = path.resolve(
    rawOptions.stateRoot || DEFAULT_STATE_ROOT,
  );
  const backupRoot = path.resolve(
    rawOptions.backupRoot || DEFAULT_BACKUP_ROOT,
  );
  const options = {
    stateRoot,
    backupRoot,
    workRoot: path.resolve(
      rawOptions.workRoot || path.join(stateRoot, "work"),
    ),
    archiveRoot: path.resolve(
      rawOptions.archiveRoot || path.join(stateRoot, "archive"),
    ),
    requestFile: path.resolve(
      rawOptions.requestFile ||
        path.join(stateRoot, "inbox", "update-request.json"),
    ),
    resultFile: path.resolve(
      rawOptions.resultFile ||
        path.join(stateRoot, "outbox", "update-result.json"),
    ),
    otaBackupKeepCount: positiveInteger(
      rawOptions.otaBackupKeepCount,
      DEFAULT_OTA_BACKUP_KEEP_COUNT,
    ),
    manualBackupKeepCount: positiveInteger(
      rawOptions.manualBackupKeepCount,
      DEFAULT_MANUAL_BACKUP_KEEP_COUNT,
    ),
    archiveKeepCount: positiveInteger(
      rawOptions.archiveKeepCount,
      DEFAULT_ARCHIVE_KEEP_COUNT,
    ),
    archiveMaxAgeMs: positiveNumber(
      rawOptions.archiveMaxAgeMs,
      DEFAULT_ARCHIVE_MAX_AGE_MS,
    ),
    workMaxAgeMs: positiveNumber(
      rawOptions.workMaxAgeMs,
      DEFAULT_WORK_MAX_AGE_MS,
    ),
    requestMaxAgeMs: positiveNumber(
      rawOptions.requestMaxAgeMs,
      DEFAULT_REQUEST_MAX_AGE_MS,
    ),
    resultMaxAgeMs: positiveNumber(
      rawOptions.resultMaxAgeMs,
      DEFAULT_RESULT_MAX_AGE_MS,
    ),
    tempMaxAgeMs: positiveNumber(
      rawOptions.tempMaxAgeMs,
      DEFAULT_TEMP_MAX_AGE_MS,
    ),
    nowMs: positiveNumber(rawOptions.nowMs, Date.now()),
    dryRun: rawOptions.dryRun === true,
  };

  const removedPaths = [];
  const archivedPaths = [];
  const recoveryResults = [];

  removeStaleResult({
    resultFile: options.resultFile,
    maxAgeMs: options.resultMaxAgeMs,
    nowMs: options.nowMs,
    dryRun: options.dryRun,
    removedPaths,
  });
  archiveStaleRequest({
    requestFile: options.requestFile,
    resultFile: options.resultFile,
    archiveRoot: options.archiveRoot,
    maxAgeMs: options.requestMaxAgeMs,
    nowMs: options.nowMs,
    dryRun: options.dryRun,
    archivedPaths,
    recoveryResults,
  });
  removeStaleTemporaryFiles({
    directory: path.dirname(options.requestFile),
    maxAgeMs: options.tempMaxAgeMs,
    nowMs: options.nowMs,
    dryRun: options.dryRun,
    removedPaths,
  });
  removeStaleTemporaryFiles({
    directory: path.dirname(options.resultFile),
    maxAgeMs: options.tempMaxAgeMs,
    nowMs: options.nowMs,
    dryRun: options.dryRun,
    removedPaths,
  });
  removeStaleWork({
    workRoot: options.workRoot,
    maxAgeMs: options.workMaxAgeMs,
    nowMs: options.nowMs,
    dryRun: options.dryRun,
    removedPaths,
  });
  pruneArchive({
    archiveRoot: options.archiveRoot,
    keepCount: options.archiveKeepCount,
    maxAgeMs: options.archiveMaxAgeMs,
    nowMs: options.nowMs,
    dryRun: options.dryRun,
    removedPaths,
  });
  pruneOtaBackups(
    options.backupRoot,
    options.otaBackupKeepCount,
    options.dryRun,
    removedPaths,
  );
  pruneManualBackups(
    options.backupRoot,
    options.manualBackupKeepCount,
    options.dryRun,
    removedPaths,
  );

  return {
    dryRun: options.dryRun,
    removedCount: removedPaths.length,
    archivedCount: archivedPaths.length,
    recoveryResultCount: recoveryResults.length,
    removedPaths,
    archivedPaths,
    recoveryResults,
  };
}

function main() {
  assertRoot();
  const options = parseArguments(process.argv);
  const result = cleanupUpdaterState(options);
  console.log(
    `MAIYEN HUB CLEANUP: removed=${result.removedCount} ` +
      `archived=${result.archivedCount} ` +
      `recoveryResults=${result.recoveryResultCount} ` +
      `dryRun=${result.dryRun}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      "MAIYEN HUB CLEANUP FAILED:",
      String(error?.message || error || "unknown_error"),
    );
    process.exitCode = 1;
  }
}

module.exports = {
  DAY_MS,
  DEFAULT_ARCHIVE_KEEP_COUNT,
  DEFAULT_ARCHIVE_MAX_AGE_MS,
  DEFAULT_MANUAL_BACKUP_KEEP_COUNT,
  DEFAULT_OTA_BACKUP_KEEP_COUNT,
  DEFAULT_REQUEST_MAX_AGE_MS,
  DEFAULT_RESULT_MAX_AGE_MS,
  DEFAULT_STATE_ROOT,
  DEFAULT_TEMP_MAX_AGE_MS,
  DEFAULT_WORK_MAX_AGE_MS,
  MANUAL_BACKUP_NAME_PATTERN,
  OTA_BACKUP_NAME_PATTERN,
  cleanupUpdaterState,
  parseArguments,
  pruneArchive,
  pruneManualBackups,
  pruneOtaBackups,
};
