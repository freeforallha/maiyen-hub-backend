#!/usr/bin/env node
"use strict";

const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  DEFAULT_UPDATE_PUBLIC_KEY_PATH,
  UPDATE_PAYLOAD_ROOTS,
  isReleaseNewerThanCurrent,
  isSafeRelativePayloadPath,
  normalizeReleaseManifest,
  validateReleaseCompatibility,
  verifyReleaseManifestSignature,
} = require("../hub_update_contract");

const DEFAULT_REQUEST_FILE =
  "/var/lib/maiyen-updater/inbox/update-request.json";
const DEFAULT_RESULT_FILE =
  "/var/lib/maiyen-updater/outbox/update-result.json";
const DEFAULT_WORK_ROOT = "/var/lib/maiyen-updater/work";
const DEFAULT_ARCHIVE_ROOT = "/var/lib/maiyen-updater/archive";
const DEFAULT_SOURCE_DIR =
  process.env.MAIYEN_SOURCE_DIR ||
  "/home/pi/maiyen_hub_backend";
const DEFAULT_RUNTIME_DIR =
  process.env.MAIYEN_RUNTIME_DIR ||
  "/opt/maiyen-hub-backend";
const DEFAULT_BACKUP_ROOT =
  process.env.MAIYEN_UPDATE_BACKUP_ROOT ||
  "/var/backups/maiyen-hub";
const DEFAULT_BACKEND_SERVICE =
  process.env.MAIYEN_BACKEND_SERVICE ||
  "maiyen-hub-backend.service";
const DEFAULT_SERVICE_GROUP =
  process.env.MAIYEN_UPDATE_SERVICE_GROUP ||
  "maiyen";
const DEFAULT_INSTALLED_UPDATER_ROOT =
  "/usr/local/lib/maiyen-updater";
const RUNTIME_DIRECTORY_NAMES = Object.freeze([
  ".maiyen_runtime",
]);

const DEFAULT_FIRMWARE_VERSION_FILE =
  "/etc/maiyen-updater/firmware-version";
const DEFAULT_RUN_USER = "pi";
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const DEFAULT_ALLOWED_DOWNLOAD_HOSTS = Object.freeze([
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

function parseArguments(argv) {
  const options = {
    requestFile: DEFAULT_REQUEST_FILE,
    resultFile: DEFAULT_RESULT_FILE,
    publicKeyPath: DEFAULT_UPDATE_PUBLIC_KEY_PATH,
    workRoot: DEFAULT_WORK_ROOT,
    archiveRoot: DEFAULT_ARCHIVE_ROOT,
    sourceDir: DEFAULT_SOURCE_DIR,
    runtimeDir: DEFAULT_RUNTIME_DIR,
    backupRoot: DEFAULT_BACKUP_ROOT,
    firmwareVersionFile: DEFAULT_FIRMWARE_VERSION_FILE,
    backendService: DEFAULT_BACKEND_SERVICE,
    serviceGroup: DEFAULT_SERVICE_GROUP,
    runUser: process.env.SUDO_USER || DEFAULT_RUN_USER,
  };

  const mapping = {
    "--request": "requestFile",
    "--result": "resultFile",
    "--public-key": "publicKeyPath",
    "--work-root": "workRoot",
    "--archive-root": "archiveRoot",
    "--source-dir": "sourceDir",
    "--runtime-dir": "runtimeDir",
    "--backup-root": "backupRoot",
    "--firmware-version-file": "firmwareVersionFile",
    "--backend-service": "backendService",
    "--service-group": "serviceGroup",
    "--run-user": "runUser",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const key = mapping[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    if (!value) throw new Error(`missing_value_for_${argv[index]}`);
    options[key] = value;
    index += 1;
  }

  return options;
}

function safeIdentifier(rawValue, fallback = "update") {
  const normalized = String(rawValue || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture === true ? "pipe" : "inherit",
    env: options.env || process.env,
    cwd: options.cwd,
    timeout: options.timeout,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const error = new Error(
      stderr || `${path.basename(command)}_exit_${result.status}`,
    );
    error.exitCode = result.status;
    throw error;
  }

  return String(result.stdout || "");
}

function atomicWriteJson(filePath, value) {
  const targetPath = path.resolve(filePath);
  const directory = path.dirname(targetPath);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    tempPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", mode: 0o660 },
  );
  fs.renameSync(tempPath, targetPath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getAllowedDownloadHosts() {
  const configured = String(
    process.env.MAIYEN_UPDATE_ALLOWED_HOSTS || "",
  )
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return configured.length > 0
    ? new Set(configured)
    : new Set(DEFAULT_ALLOWED_DOWNLOAD_HOSTS);
}

function validateDownloadUrl(rawUrl, allowedHosts = getAllowedDownloadHosts()) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch (_) {
    throw new Error("invalid_package_url");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("package_url_must_use_https");
  }

  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new Error(`package_host_not_allowed:${host}`);
  }

  return parsed;
}

function downloadHttpsToFile(url, destination, redirectsLeft = MAX_REDIRECTS) {
  const allowedHosts = getAllowedDownloadHosts();
  const parsed = validateDownloadUrl(url, allowedHosts);

  return new Promise((resolve, reject) => {
    const request = https.get(
      parsed,
      {
        headers: {
          "User-Agent": "MaiYen-Hub-Updater/1.0",
          Accept: "application/zip,application/octet-stream",
        },
        timeout: 30 * 1000,
      },
      (response) => {
        const statusCode = Number(response.statusCode || 0);

        if (
          [301, 302, 303, 307, 308].includes(statusCode) &&
          response.headers.location
        ) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("too_many_package_redirects"));
            return;
          }

          let redirectUrl;
          try {
            redirectUrl = new URL(response.headers.location, parsed).toString();
            validateDownloadUrl(redirectUrl, allowedHosts);
          } catch (error) {
            reject(error);
            return;
          }

          downloadHttpsToFile(
            redirectUrl,
            destination,
            redirectsLeft - 1,
          ).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`package_download_http_${statusCode}`));
          return;
        }

        const contentLength = Number(response.headers["content-length"] || 0);
        if (contentLength > MAX_PACKAGE_BYTES) {
          response.resume();
          reject(new Error("package_too_large"));
          return;
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const output = fs.createWriteStream(destination, {
          flags: "wx",
          mode: 0o600,
        });
        let receivedBytes = 0;
        let settled = false;

        function fail(error) {
          if (settled) return;
          settled = true;
          output.destroy();
          try {
            fs.unlinkSync(destination);
          } catch (_) {}
          reject(error);
        }

        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_PACKAGE_BYTES) {
            response.destroy(new Error("package_too_large"));
          }
        });
        response.on("error", fail);
        output.on("error", fail);
        output.on("finish", () => {
          output.close(() => {
            if (settled) return;
            settled = true;
            resolve(receivedBytes);
          });
        });
        response.pipe(output);
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("package_download_timeout"));
    });
    request.on("error", reject);
  });
}

function sha256File(filePath) {
  const stdout = runCommand(
    "/usr/bin/sha256sum",
    [filePath],
    { capture: true },
  ).trim();
  const hash = stdout.split(/\s+/, 1)[0];

  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("unable_to_compute_package_sha256");
  }

  return hash;
}

function listZipEntries(zipPath) {
  const stdout = runCommand(
    "/usr/bin/unzip",
    ["-Z1", zipPath],
    { capture: true },
  );
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resolvePayloadDirectory(extractedDir) {
  const matches = UPDATE_PAYLOAD_ROOTS
    .map((rootName) => path.join(extractedDir, rootName))
    .filter((candidate) => fs.existsSync(candidate));

  if (matches.length === 0) {
    throw new Error("update_payload_root_missing");
  }
  if (matches.length > 1) {
    throw new Error("ambiguous_update_payload_roots");
  }

  return matches[0];
}

function validateZipEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("empty_update_package");
  }

  let payloadFileCount = 0;
  const payloadRoots = new Set();

  for (const entry of entries) {
    if (!isSafeRelativePayloadPath(entry)) {
      throw new Error(`unsafe_package_entry:${entry}`);
    }
    const normalized = String(entry).replace(/\\/g, "/");
    const payloadRoot = UPDATE_PAYLOAD_ROOTS.find(
      (rootName) =>
        normalized === rootName ||
        normalized === `${rootName}/` ||
        normalized.startsWith(`${rootName}/`),
    );
    if (payloadRoot) payloadRoots.add(payloadRoot);
    if (!entry.endsWith("/")) payloadFileCount += 1;
  }

  if (payloadRoots.size !== 1) {
    throw new Error("update_package_requires_single_payload_root");
  }

  if (payloadFileCount === 0) {
    throw new Error("update_package_has_no_files");
  }

  if (payloadFileCount > 2000) {
    throw new Error("update_package_has_too_many_files");
  }

  return payloadFileCount;
}

function ensureDirectoryMode(directory, mode) {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
}

function extractZip(zipPath, destination) {
  // systemd runs the updater with UMask=0007. An explicit chmod is required
  // so the unprivileged test user can traverse the extraction parent.
  ensureDirectoryMode(destination, 0o755);
  runCommand("/usr/bin/unzip", ["-q", zipPath, "-d", destination]);

  const symlinkOutput = runCommand(
    "/usr/bin/find",
    [destination, "-type", "l", "-print"],
    { capture: true },
  ).trim();

  if (symlinkOutput) {
    throw new Error("update_package_contains_symlink");
  }
}

function stableDependencySnapshot(packageJson) {
  const source = packageJson && typeof packageJson === "object"
    ? packageJson
    : {};
  const snapshot = {
    dependencies: source.dependencies || {},
    optionalDependencies: source.optionalDependencies || {},
    peerDependencies: source.peerDependencies || {},
  };

  function sortObject(value) {
    return Object.keys(value || {})
      .sort()
      .reduce((result, key) => {
        result[key] = value[key];
        return result;
      }, {});
  }

  return JSON.stringify({
    dependencies: sortObject(snapshot.dependencies),
    optionalDependencies: sortObject(snapshot.optionalDependencies),
    peerDependencies: sortObject(snapshot.peerDependencies),
  });
}

function assertDependenciesUnchanged(currentSourceDir, payloadDir) {
  const payloadPackagePath = path.join(payloadDir, "package.json");
  if (!fs.existsSync(payloadPackagePath)) return;

  const currentPackage = readJson(path.join(currentSourceDir, "package.json"));
  const payloadPackage = readJson(payloadPackagePath);

  if (
    stableDependencySnapshot(currentPackage) !==
    stableDependencySnapshot(payloadPackage)
  ) {
    throw new Error("dependency_change_requires_manual_update");
  }
}

function copyTreeWithoutRuntime(sourceDir, destinationDir) {
  ensureDirectoryMode(destinationDir, 0o755);
  const tarArgs = [
    "-C",
    sourceDir,
    "--exclude=node_modules",
    "--exclude=.git",
    "--exclude=.maiyen_runtime",
    "--exclude=reports",
    "-cf",
    "-",
    ".",
  ];
  const extractArgs = ["-C", destinationDir, "-xf", "-"];
  const shellCommand =
    `${shellQuote("/usr/bin/tar")} ${tarArgs.map(shellQuote).join(" ")} | ` +
    `${shellQuote("/usr/bin/tar")} ${extractArgs.map(shellQuote).join(" ")}`;
  runCommand("/bin/bash", ["-lc", shellCommand]);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveRunUserIdentity(runUser) {
  const username = String(runUser || "").trim();
  if (!username) {
    throw new Error("run_user_required");
  }

  const uid = Number(
    runCommand("/usr/bin/id", ["-u", username], { capture: true }).trim(),
  );
  const gid = Number(
    runCommand("/usr/bin/id", ["-g", username], { capture: true }).trim(),
  );

  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error("invalid_run_user_identity");
  }

  return { uid, gid };
}

function getNormalizedUpdateMode(stat) {
  if (stat.isDirectory()) return 0o755;
  if (!stat.isFile()) throw new Error("unsupported_update_tree_entry");
  return (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
}

function normalizeUpdateTreeForRunUser(rootDir, runUser) {
  const targetRoot = path.resolve(rootDir);
  const identity = resolveRunUserIdentity(runUser);

  function visit(targetPath) {
    const stat = fs.lstatSync(targetPath);

    if (stat.isSymbolicLink()) {
      throw new Error("update_tree_symlink_not_allowed");
    }

    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(targetPath)) {
        visit(path.join(targetPath, entry));
      }
    }

    const normalizedMode = getNormalizedUpdateMode(stat);
    fs.chownSync(targetPath, identity.uid, identity.gid);
    fs.chmodSync(targetPath, normalizedMode);
  }

  visit(targetRoot);
  return identity;
}

function overlayPayload(payloadDir, targetDir, runUser = "") {
  const shellCommand =
    `${shellQuote("/usr/bin/tar")} -C ${shellQuote(payloadDir)} -cf - . | ` +
    `${shellQuote("/usr/bin/tar")} -C ${shellQuote(targetDir)} -xf -`;

  if (runUser) {
    runCommand(
      "/usr/sbin/runuser",
      [
        "-u",
        runUser,
        "--",
        "/bin/bash",
        "-lc",
        shellCommand,
      ],
    );
    return;
  }

  runCommand("/bin/bash", ["-lc", shellCommand]);
}

function installFileAtomically(sourcePath, destinationPath, mode) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedDestination = path.resolve(destinationPath);
  const destinationDirectory = path.dirname(resolvedDestination);
  const temporaryPath =
    `${resolvedDestination}.tmp-${process.pid}-${Date.now()}`;

  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
  fs.copyFileSync(resolvedSource, temporaryPath);
  fs.chownSync(temporaryPath, 0, 0);
  fs.chmodSync(temporaryPath, mode);
  fs.renameSync(temporaryPath, resolvedDestination);
}

function installPrivilegedUpdaterFromSource(
  sourceDir,
  installedRoot = DEFAULT_INSTALLED_UPDATER_ROOT,
) {
  const resolvedSourceDir = path.resolve(sourceDir);
  const resolvedInstalledRoot = path.resolve(installedRoot);
  const sourceContract = path.join(
    resolvedSourceDir,
    "hub_update_contract.js",
  );
  const sourceUpdater = path.join(
    resolvedSourceDir,
    "scripts",
    "apply_hub_update.js",
  );
  const installedContract = path.join(
    resolvedInstalledRoot,
    "hub_update_contract.js",
  );
  const installedUpdater = path.join(
    resolvedInstalledRoot,
    "scripts",
    "apply_hub_update.js",
  );

  if (!fs.existsSync(sourceContract)) {
    throw new Error("updater_contract_source_missing");
  }
  if (!fs.existsSync(sourceUpdater)) {
    throw new Error("updater_script_source_missing");
  }

  runCommand("/usr/bin/node", ["--check", sourceContract]);
  runCommand("/usr/bin/node", ["--check", sourceUpdater]);

  // The contract keeps backward-compatible exports, so installing it first
  // remains safe even if the updater script replacement is interrupted.
  installFileAtomically(sourceContract, installedContract, 0o644);
  installFileAtomically(sourceUpdater, installedUpdater, 0o755);

  return {
    installedContract,
    installedUpdater,
  };
}

function linkNodeModules(sourceDir, stagedSourceDir) {
  const currentNodeModules = path.join(sourceDir, "node_modules");
  const stagedNodeModules = path.join(stagedSourceDir, "node_modules");

  if (!fs.existsSync(currentNodeModules)) {
    throw new Error("source_node_modules_missing");
  }

  fs.symlinkSync(currentNodeModules, stagedNodeModules, "dir");
}

function runTestsAsUser(stagedSourceDir, runUser) {
  runCommand(
    "/usr/sbin/runuser",
    [
      "-u",
      runUser,
      "--",
      "/bin/bash",
      "-lc",
      `cd ${shellQuote(stagedSourceDir)} && npm test`,
    ],
    { timeout: 20 * 60 * 1000 },
  );
}

function createSourceBackup(sourceDir, backupRoot, releaseId) {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(
    backupRoot,
    `${stamp}-${safeIdentifier(releaseId)}`,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(backupDir, "source.tar.gz");

  runCommand("/usr/bin/tar", [
    "-C",
    sourceDir,
    "--exclude=node_modules",
    "--exclude=.git",
    "--exclude=.maiyen_runtime",
    "--exclude=reports",
    "-czf",
    archivePath,
    ".",
  ]);

  return { backupDir, archivePath };
}

function restoreSourceBackup(sourceDir, archivePath) {
  const nodeModulesPath = path.join(sourceDir, "node_modules");
  const runtimePaths = RUNTIME_DIRECTORY_NAMES.map(
    (name) => path.join(sourceDir, name),
  );
  const preserved = [];

  for (const itemPath of [nodeModulesPath, ...runtimePaths]) {
    if (fs.existsSync(itemPath)) {
      const temporaryPath = `${itemPath}.preserved-${Date.now()}`;
      fs.renameSync(itemPath, temporaryPath);
      preserved.push([temporaryPath, itemPath]);
    }
  }

  for (const entry of fs.readdirSync(sourceDir)) {
    const entryPath = path.join(sourceDir, entry);
    if (preserved.some(([temp]) => temp === entryPath)) continue;
    fs.rmSync(entryPath, { recursive: true, force: true });
  }

  runCommand("/usr/bin/tar", ["-C", sourceDir, "-xzf", archivePath]);

  for (const [temporaryPath, originalPath] of preserved) {
    fs.renameSync(temporaryPath, originalPath);
  }
}

function rotateBackups(backupRoot, keepCount = 5) {
  if (!fs.existsSync(backupRoot)) return;
  const directories = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(backupRoot, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const item of directories.slice(keepCount)) {
    fs.rmSync(item.fullPath, { recursive: true, force: true });
  }
}

function archiveRequest(requestFile, archiveRoot, releaseId, status) {
  if (!fs.existsSync(requestFile)) return;
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o770 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(
    archiveRoot,
    `${stamp}-${safeIdentifier(releaseId)}-${safeIdentifier(status)}.json`,
  );
  fs.renameSync(requestFile, destination);
}

function assertRoot() {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("hub_updater_requires_root");
  }
}

function readTextIfExists(filePath) {
  try {
    return String(fs.readFileSync(filePath, "utf8") || "").trim();
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}

function writeFirmwareVersion(
  filePath,
  version,
  serviceGroup = DEFAULT_SERVICE_GROUP,
) {
  const targetPath = path.resolve(filePath);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${String(version).trim()}\n`, {
    encoding: "utf8",
    mode: 0o640,
  });
  fs.renameSync(temporaryPath, targetPath);

  try {
    runCommand("/usr/bin/chgrp", [serviceGroup, targetPath]);
    fs.chmodSync(targetPath, 0o640);
  } catch (_) {
    // File vẫn root-readable; setup script sẽ sửa group khi chạy lại.
  }
}

function validateEnvelope(rawEnvelope, publicKeyPath) {
  if (!rawEnvelope || typeof rawEnvelope !== "object") {
    throw new Error("invalid_update_request_envelope");
  }

  const manifest = verifyReleaseManifestSignature({
    manifest: rawEnvelope.manifest,
    signature: rawEnvelope.signature,
    publicKeyPath,
  });

  const requiredTextFields = ["hubId", "ownerUid", "homeId", "requestedBy"];
  for (const field of requiredTextFields) {
    if (!String(rawEnvelope[field] || "").trim()) {
      throw new Error(`missing_${field}`);
    }
  }

  if (rawEnvelope.requestedBy !== rawEnvelope.ownerUid) {
    throw new Error("owner_confirmation_required");
  }

  return {
    ...rawEnvelope,
    manifest,
    signature: String(rawEnvelope.signature || "").trim(),
  };
}

async function applyHubUpdate(options) {
  assertRoot();
  const startedAt = Date.now();
  const envelope = validateEnvelope(
    readJson(options.requestFile),
    options.publicKeyPath,
  );
  const manifest = normalizeReleaseManifest(envelope.manifest);
  const releaseId = manifest.releaseId;
  const workDir = path.join(
    options.workRoot,
    `${safeIdentifier(releaseId)}-${startedAt}`,
  );
  const packagePath = path.join(workDir, "package.zip");
  const extractedDir = path.join(workDir, "extracted");
  let payloadDir = "";
  const stagedSourceDir = path.join(workDir, "staged-source");
  let sourceBackup = null;
  let previousFirmwareVersion = "";
  let firmwareVersionChanged = false;

  const resultBase = {
    resultSchemaVersion: 1,
    releaseId,
    ownerUid: envelope.ownerUid,
    homeId: envelope.homeId,
    requestedBy: envelope.requestedBy,
    startedAt,
  };

  try {
    if (!fs.existsSync(options.sourceDir)) {
      throw new Error("source_directory_missing");
    }
    if (!fs.existsSync(options.runtimeDir)) {
      throw new Error("runtime_directory_missing");
    }

    // The installed version must be read from the production runtime.
    // The development/source tree may already contain a newer release that
    // has not been deployed yet, so using sourceDir here can incorrectly
    // reject a valid update as already installed.
    const installedPackage = readJson(
      path.join(options.runtimeDir, "package.json"),
    );
    const currentVersions = {
      backendVersion: String(installedPackage.version || "0.0.0"),
      hubFirmwareVersion:
        readTextIfExists(options.firmwareVersionFile) || "1.0.0",
      protocolVersion:
        process.env.MAIYEN_PROTOCOL_VERSION || "1.0.0",
    };

    validateReleaseCompatibility(manifest, currentVersions);
    if (!isReleaseNewerThanCurrent(manifest, currentVersions)) {
      throw new Error("release_not_newer_than_installed");
    }

    ensureDirectoryMode(options.workRoot, 0o711);
    ensureDirectoryMode(workDir, 0o755);

    console.log(`MaiYen updater: downloading ${releaseId}`);
    await downloadHttpsToFile(manifest.packageUrl, packagePath);

    const actualHash = sha256File(packagePath);
    if (actualHash !== manifest.packageSha256) {
      throw new Error("package_sha256_mismatch");
    }

    const entries = listZipEntries(packagePath);
    validateZipEntries(entries);
    extractZip(packagePath, extractedDir);
    payloadDir = resolvePayloadDirectory(extractedDir);

    assertDependenciesUnchanged(options.sourceDir, payloadDir);
    normalizeUpdateTreeForRunUser(payloadDir, options.runUser);
    copyTreeWithoutRuntime(options.sourceDir, stagedSourceDir);
    normalizeUpdateTreeForRunUser(stagedSourceDir, options.runUser);
    overlayPayload(payloadDir, stagedSourceDir, options.runUser);
    linkNodeModules(options.sourceDir, stagedSourceDir);

    const stagedPackage = readJson(path.join(stagedSourceDir, "package.json"));
    if (String(stagedPackage.version || "") !== manifest.backendVersion) {
      throw new Error("payload_backend_version_mismatch");
    }

    console.log("MaiYen updater: running staged tests");
    runTestsAsUser(stagedSourceDir, options.runUser);

    sourceBackup = createSourceBackup(
      options.sourceDir,
      options.backupRoot,
      releaseId,
    );

    console.log("MaiYen updater: activating source payload");
    overlayPayload(payloadDir, options.sourceDir, options.runUser);

    console.log("MaiYen updater: verifying source after activation");
    runTestsAsUser(options.sourceDir, options.runUser);

    console.log("MaiYen updater: installing privileged updater");
    installPrivilegedUpdaterFromSource(options.sourceDir);

    const deployScript = path.join(
      options.sourceDir,
      "scripts/deploy_backend_production.sh",
    );
    if (!fs.existsSync(deployScript)) {
      throw new Error("production_deploy_script_missing");
    }

    previousFirmwareVersion = readTextIfExists(
      options.firmwareVersionFile,
    );
    writeFirmwareVersion(
      options.firmwareVersionFile,
      manifest.hubFirmwareVersion,
      options.serviceGroup,
    );
    firmwareVersionChanged = true;

    console.log("MaiYen updater: deploying production backend");
    runCommand("/bin/bash", [deployScript], {
      cwd: options.sourceDir,
      timeout: 20 * 60 * 1000,
      env: {
        ...process.env,
        SUDO_USER: options.runUser,
        MAIYEN_SOURCE_DIR: options.sourceDir,
        MAIYEN_RUNTIME_DIR: options.runtimeDir,
        MAIYEN_BACKEND_SERVICE: options.backendService,
        MAIYEN_SERVICE_GROUP: options.serviceGroup,
      },
    });

    // Report the version that is actually active in production, not merely
    // the version present in the source tree.
    const deployedPackage = readJson(
      path.join(options.runtimeDir, "package.json"),
    );
    const finishedAt = Date.now();
    const successResult = {
      ...resultBase,
      status: "success",
      finishedAt,
      installedBackendVersion: String(deployedPackage.version || ""),
      installedHubFirmwareVersion: manifest.hubFirmwareVersion,
      installedProtocolVersion: manifest.protocolVersion,
      backupDirectory: sourceBackup.backupDir,
    };

    atomicWriteJson(options.resultFile, successResult);
    archiveRequest(options.requestFile, options.archiveRoot, releaseId, "success");
    rotateBackups(options.backupRoot, 5);
    fs.rmSync(workDir, { recursive: true, force: true });
    return successResult;
  } catch (error) {
    const errorMessage = String(error?.message || error || "unknown_error");
    console.error("MaiYen updater failed:", errorMessage);

    if (sourceBackup?.archivePath && fs.existsSync(sourceBackup.archivePath)) {
      try {
        console.error("MaiYen updater: restoring source backup");
        restoreSourceBackup(options.sourceDir, sourceBackup.archivePath);
      } catch (restoreError) {
        console.error(
          "MaiYen updater source restore failed:",
          restoreError.message,
        );
      }
    }

    if (firmwareVersionChanged) {
      try {
        writeFirmwareVersion(
          options.firmwareVersionFile,
          previousFirmwareVersion || "1.0.0",
          options.serviceGroup,
        );
        runCommand("/bin/systemctl", ["restart", options.backendService]);
      } catch (firmwareRestoreError) {
        console.error(
          "MaiYen updater firmware restore failed:",
          firmwareRestoreError.message,
        );
      }
    }

    const failureResult = {
      ...resultBase,
      status: "failed",
      finishedAt: Date.now(),
      errorCode: safeIdentifier(errorMessage, "update_failed").slice(0, 120),
      errorMessage: errorMessage.slice(0, 500),
      backupDirectory: sourceBackup?.backupDir || "",
    };

    try {
      atomicWriteJson(options.resultFile, failureResult);
    } catch (resultError) {
      console.error("Unable to write update result:", resultError.message);
    }

    try {
      archiveRequest(options.requestFile, options.archiveRoot, releaseId, "failed");
    } catch (archiveError) {
      console.error("Unable to archive update request:", archiveError.message);
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv);
  await applyHubUpdate(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ALLOWED_DOWNLOAD_HOSTS,
  DEFAULT_BACKEND_SERVICE,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_SERVICE_GROUP,
  DEFAULT_SOURCE_DIR,
  MAX_PACKAGE_BYTES,
  applyHubUpdate,
  getAllowedDownloadHosts,
  ensureDirectoryMode,
  getNormalizedUpdateMode,
  listZipEntries,
  normalizeReleaseManifest,
  normalizeUpdateTreeForRunUser,
  parseArguments,
  resolvePayloadDirectory,
  resolveRunUserIdentity,
  safeIdentifier,
  sha256File,
  stableDependencySnapshot,
  installFileAtomically,
  installPrivilegedUpdaterFromSource,
  validateDownloadUrl,
  validateEnvelope,
  validateZipEntries,
};
