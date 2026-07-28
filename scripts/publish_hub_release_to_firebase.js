#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_RECORD_PATH = "";
const DEFAULT_FIREBASE_PATH = "system/hubReleases/latest";
const DEFAULT_SERVICE_ACCOUNT = "/opt/maiyen-hub-backend/serviceAccount.json";
const DEFAULT_PUBLIC_KEY = "/etc/maiyen-updater/release-public-key.pem";
const DEFAULT_BACKUP_ROOT = "/var/backups/maiyen-hub/release-manifests";
const DEFAULT_DATABASE_URL =
  "https://safehome-10cc9-default-rtdb.asia-southeast1.firebasedatabase.app/";

function parseArguments(argv) {
  const options = {
    recordPath: DEFAULT_RECORD_PATH,
    firebasePath: DEFAULT_FIREBASE_PATH,
    serviceAccountPath: DEFAULT_SERVICE_ACCOUNT,
    publicKeyPath: DEFAULT_PUBLIC_KEY,
    backupRoot: DEFAULT_BACKUP_ROOT,
    databaseUrl: process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL,
    keepBackups: 10,
    dryRun: false,
  };

  const valueOptions = new Map([
    ["--record", "recordPath"],
    ["--firebase-path", "firebasePath"],
    ["--service-account", "serviceAccountPath"],
    ["--public-key", "publicKeyPath"],
    ["--backup-root", "backupRoot"],
    ["--database-url", "databaseUrl"],
    ["--keep-backups", "keepBackups"],
    ["--expected-release-id", "expectedReleaseId"],
    ["--expected-sha256", "expectedSha256"],
  ]);

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const key = valueOptions.get(token);
    if (!key) throw new Error(`unknown_argument:${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing_value:${token}`);
    }
    options[key] = value;
    index += 1;
  }

  options.recordPath = path.resolve(String(options.recordPath || ""));
  options.serviceAccountPath = path.resolve(options.serviceAccountPath);
  options.publicKeyPath = path.resolve(options.publicKeyPath);
  options.backupRoot = path.resolve(options.backupRoot);
  options.keepBackups = Number(options.keepBackups);
  options.expectedSha256 = String(options.expectedSha256 || "").toLowerCase();

  if (!options.recordPath || !fs.existsSync(options.recordPath)) {
    throw new Error("release_record_missing");
  }
  if (!Number.isSafeInteger(options.keepBackups) || options.keepBackups < 1) {
    throw new Error("invalid_keep_backups");
  }
  if (!options.firebasePath || options.firebasePath.startsWith("/")) {
    throw new Error("invalid_firebase_path");
  }
  return options;
}

function readReleaseRecord(recordPath) {
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (!record || typeof record !== "object") {
    throw new Error("invalid_release_record");
  }
  if (!record.manifest || !record.signature) {
    throw new Error("release_record_missing_signature");
  }
  return record;
}

function rotateManifestBackups(backupRoot, keepCount = 10) {
  if (!fs.existsSync(backupRoot)) return [];
  const files = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const fullPath = path.join(backupRoot, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const removed = [];
  for (const item of files.slice(keepCount)) {
    fs.rmSync(item.fullPath, { force: true });
    removed.push(item.fullPath);
  }
  return removed;
}

function writeManifestBackup(backupRoot, currentValue) {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupRoot, `${stamp}-latest.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(currentValue, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return backupPath;
}

function verifyRecord(record, options) {
  const { verifyReleaseManifestSignature } = require("../hub_update_contract");
  const manifest = verifyReleaseManifestSignature({
    manifest: record.manifest,
    signature: record.signature,
    publicKeyPath: options.publicKeyPath,
  });

  if (
    options.expectedReleaseId &&
    manifest.releaseId !== options.expectedReleaseId
  ) {
    throw new Error("release_id_mismatch");
  }
  if (
    options.expectedSha256 &&
    String(manifest.packageSha256 || "").toLowerCase() !== options.expectedSha256
  ) {
    throw new Error("package_sha256_mismatch");
  }
  return manifest;
}

async function publishRelease(options) {
  const record = readReleaseRecord(options.recordPath);
  const manifest = verifyRecord(record, options);

  if (options.dryRun) {
    console.log("MAIYEN FIREBASE RELEASE DRY RUN OK");
    console.log(`releaseId: ${manifest.releaseId}`);
    console.log(`backendVersion: ${manifest.backendVersion}`);
    console.log(`packageSha256: ${manifest.packageSha256}`);
    return { manifest, backupPath: "", dryRun: true };
  }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("firebase_release_publish_requires_root");
  }
  if (!fs.existsSync(options.serviceAccountPath)) {
    throw new Error("service_account_missing");
  }

  const admin = require("firebase-admin");
  const serviceAccount = JSON.parse(
    fs.readFileSync(options.serviceAccountPath, "utf8"),
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: options.databaseUrl,
  });

  try {
    const ref = admin.database().ref(options.firebasePath);
    const currentSnapshot = await ref.once("value");
    const backupPath = writeManifestBackup(
      options.backupRoot,
      currentSnapshot.val(),
    );

    let storedManifest;
    try {
      await ref.set(record);
      const storedSnapshot = await ref.once("value");
      const storedRecord = storedSnapshot.val();
      storedManifest = verifyRecord(storedRecord, options);
    } catch (publishError) {
      try {
        const previousValue = currentSnapshot.val();
        if (previousValue === null || previousValue === undefined) {
          await ref.remove();
        } else {
          await ref.set(previousValue);
        }
      } catch (restoreError) {
        console.error(
          `MAIYEN FIREBASE RELEASE RESTORE FAILED: ${restoreError.message}`,
        );
      }
      throw publishError;
    }

    rotateManifestBackups(options.backupRoot, options.keepBackups);

    console.log("=== FIREBASE RELEASE PUBLISHED ===");
    console.log(`path: ${options.firebasePath}`);
    console.log(`releaseId: ${storedManifest.releaseId}`);
    console.log(`backendVersion: ${storedManifest.backendVersion}`);
    console.log(`packageSha256: ${storedManifest.packageSha256}`);
    console.log(`critical: ${Boolean(storedManifest.critical)}`);
    console.log(`backup: ${backupPath}`);

    return { manifest: storedManifest, backupPath, dryRun: false };
  } finally {
    await admin.app().delete();
  }
}

async function main() {
  const options = parseArguments(process.argv);
  await publishRelease(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`MAIYEN FIREBASE RELEASE PUBLISH FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArguments,
  publishRelease,
  readReleaseRecord,
  rotateManifestBackups,
  verifyRecord,
  writeManifestBackup,
};
