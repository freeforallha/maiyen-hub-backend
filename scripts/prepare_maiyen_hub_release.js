#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_SOURCE_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_ROOT = "/home/pi/maiyen_release_out";
const DEFAULT_RUNTIME_DIR = "/opt/maiyen-hub-backend";
const DEFAULT_GITHUB_REPO = "freeforallha/maiyen-hub-releases";
const PAYLOAD_ROOT = "maiyen_hub_backend";
const DEFAULT_KEEP_RELEASES = 3;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  "coverage",
  "logs",
  "node_modules",
  "reports",
  "runtime",
  ".maiyen_runtime",
]);

const FORBIDDEN_BASENAMES = new Set([
  "serviceAccount.json",
  ".env",
]);

const FORBIDDEN_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
]);

const PRIVATE_KEY_MARKERS = [
  ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
  ["-----BEGIN", "ENCRYPTED", "PRIVATE", "KEY-----"].join(" "),
  ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" "),
  ["-----BEGIN", "EC", "PRIVATE", "KEY-----"].join(" "),
  ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" "),
];

function parseArguments(argv) {
  const options = {
    sourceDir: DEFAULT_SOURCE_DIR,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    runtimeDir: DEFAULT_RUNTIME_DIR,
    githubRepo: DEFAULT_GITHUB_REPO,
    keepReleases: DEFAULT_KEEP_RELEASES,
    skipTests: false,
  };

  const valueOptions = new Map([
    ["--version", "version"],
    ["--source-dir", "sourceDir"],
    ["--output-root", "outputRoot"],
    ["--runtime-dir", "runtimeDir"],
    ["--github-repo", "githubRepo"],
    ["--keep-releases", "keepReleases"],
  ]);

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--skip-tests") {
      options.skipTests = true;
      continue;
    }

    const key = valueOptions.get(token);
    if (!key) {
      throw new Error(`unknown_argument:${token}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing_value:${token}`);
    }
    options[key] = value;
    index += 1;
  }

  options.sourceDir = path.resolve(String(options.sourceDir));
  options.outputRoot = path.resolve(String(options.outputRoot));
  options.runtimeDir = path.resolve(String(options.runtimeDir));
  options.keepReleases = Number(options.keepReleases);

  if (!isSemanticVersion(options.version)) {
    throw new Error("invalid_release_version");
  }
  if (!Number.isSafeInteger(options.keepReleases) || options.keepReleases < 1) {
    throw new Error("invalid_keep_releases");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.githubRepo)) {
    throw new Error("invalid_github_repo");
  }

  return options;
}

function isSemanticVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value || "").trim());
}

function compareSemanticVersions(left, right) {
  if (!isSemanticVersion(left) || !isSemanticVersion(right)) {
    throw new Error("invalid_semantic_version");
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout || 30 * 60 * 1000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `command_failed:${command}:${result.status}${detail ? `:${detail}` : ""}`,
    );
  }
  return String(result.stdout || "");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readVersionContract(sourceDir) {
  const packageJson = readJson(path.join(sourceDir, "package.json"));
  const versionModulePath = path.join(sourceDir, "system_version.js");
  delete require.cache[require.resolve(versionModulePath)];
  const systemVersionModule = require(versionModulePath);
  const systemVersion = systemVersionModule.SYSTEM_VERSION || {};

  return {
    packageVersion: String(packageJson.version || ""),
    backendVersion: String(systemVersion.backendVersion || ""),
    hubFirmwareVersion: String(systemVersion.hubFirmwareVersion || "1.0.0"),
    protocolVersion: String(systemVersion.protocolVersion || "1.0.0"),
  };
}

function readInstalledBackendVersion(runtimeDir) {
  const packagePath = path.join(runtimeDir, "package.json");
  if (!fs.existsSync(packagePath)) return "0.0.0";
  const packageJson = readJson(packagePath);
  const version = String(packageJson.version || "0.0.0");
  if (!isSemanticVersion(version)) {
    throw new Error("invalid_installed_backend_version");
  }
  return version;
}

function shouldExclude(relativePath, entry) {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.basename(normalized);
  const lower = basename.toLowerCase();

  if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(basename)) return true;
  if (FORBIDDEN_BASENAMES.has(basename)) return true;
  if (lower.startsWith(".env.")) return true;
  if (FORBIDDEN_EXTENSIONS.has(path.extname(lower))) return true;
  if (/\.backup(?:-|\.|$)/i.test(lower)) return true;
  if (/\.(bak|log|tmp|zip)$/i.test(lower)) return true;
  if (/^maiyen_release_/i.test(lower)) return true;
  if (/^maiyen_hub_update_/i.test(lower)) return true;
  return false;
}

function copyPayloadTree(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o755 });

  function visit(currentSource, currentDestination, relativeBase) {
    const entries = fs.readdirSync(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeBase
        ? path.join(relativeBase, entry.name)
        : entry.name;
      if (shouldExclude(relativePath, entry)) continue;

      const sourcePath = path.join(currentSource, entry.name);
      const destinationPath = path.join(currentDestination, entry.name);
      const stat = fs.lstatSync(sourcePath);

      if (stat.isSymbolicLink()) {
        throw new Error(`release_symlink_not_allowed:${relativePath}`);
      }
      if (stat.isDirectory()) {
        fs.mkdirSync(destinationPath, {
          recursive: true,
          mode: stat.mode & 0o777,
        });
        visit(sourcePath, destinationPath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;

      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, stat.mode & 0o777);
    }
  }

  visit(sourceDir, destinationDir, "");
}

function scanPayloadForSensitiveContent(payloadDir) {
  const findings = [];

  function visit(currentDir, relativeBase) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const relativePath = relativeBase
        ? path.join(relativeBase, entry.name)
        : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const lower = entry.name.toLowerCase();
      if (
        FORBIDDEN_BASENAMES.has(entry.name) ||
        lower.startsWith(".env.") ||
        FORBIDDEN_EXTENSIONS.has(path.extname(lower))
      ) {
        findings.push(relativePath);
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.size > 2 * 1024 * 1024) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      if (PRIVATE_KEY_MARKERS.some((marker) => content.includes(marker))) {
        findings.push(`${relativePath}:private_key_content`);
      }
    }
  }

  visit(payloadDir, "");
  if (findings.length > 0) {
    throw new Error(`sensitive_release_content:${findings.join(",")}`);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = fs.readFileSync(filePath);
  hash.update(file);
  return hash.digest("hex");
}

function validateZipRoot(zipPath) {
  const output = runCommand("/usr/bin/unzip", ["-Z1", zipPath], {
    capture: true,
  });
  const entries = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("release_zip_empty");

  for (const entry of entries) {
    if (entry !== PAYLOAD_ROOT && !entry.startsWith(`${PAYLOAD_ROOT}/`)) {
      throw new Error(`release_zip_invalid_root:${entry}`);
    }
  }
  return entries.length;
}

function rotateReleaseOutputs(outputRoot, keepCount) {
  if (!fs.existsSync(outputRoot)) return [];
  const candidates = fs
    .readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(outputRoot, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const removed = [];
  for (const item of candidates.slice(keepCount)) {
    fs.rmSync(item.fullPath, { recursive: true, force: true });
    removed.push(item.fullPath);
  }
  return removed;
}

function prepareRelease(options) {
  const releaseId = `v${options.version}`;
  const sourceDir = options.sourceDir;
  const outputDir = path.join(options.outputRoot, releaseId);
  const buildDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `maiyen-release-${options.version}-`),
  );
  const payloadDir = path.join(buildDir, PAYLOAD_ROOT);
  const zipName = `maiyen_hub_update_${options.version}.zip`;
  const zipPath = path.join(outputDir, zipName);
  const shaPath = `${zipPath}.sha256`;
  const metadataPath = path.join(
    outputDir,
    `maiyen_release_build_${options.version}.json`,
  );

  try {
    if (!fs.existsSync(sourceDir)) throw new Error("source_directory_missing");
    const versions = readVersionContract(sourceDir);
    if (versions.packageVersion !== options.version) {
      throw new Error("package_version_mismatch");
    }
    if (versions.backendVersion !== options.version) {
      throw new Error("system_version_mismatch");
    }
    if (!isSemanticVersion(versions.hubFirmwareVersion)) {
      throw new Error("invalid_hub_firmware_version");
    }
    if (!isSemanticVersion(versions.protocolVersion)) {
      throw new Error("invalid_protocol_version");
    }

    const installedBackendVersion = readInstalledBackendVersion(options.runtimeDir);
    if (compareSemanticVersions(options.version, installedBackendVersion) <= 0) {
      throw new Error("release_not_newer_than_production");
    }

    if (!options.skipTests) {
      console.log("=== 1/6 TEST SOURCE ===");
      runCommand("/usr/bin/npm", ["test"], { cwd: sourceDir });
    }

    console.log("=== 2/6 BUILD CLEAN PAYLOAD ===");
    copyPayloadTree(sourceDir, payloadDir);
    scanPayloadForSensitiveContent(payloadDir);

    const payloadVersions = readVersionContract(payloadDir);
    if (
      payloadVersions.packageVersion !== options.version ||
      payloadVersions.backendVersion !== options.version
    ) {
      throw new Error("payload_version_mismatch");
    }

    console.log("=== 3/6 CREATE ZIP ===");
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
    runCommand("/usr/bin/zip", ["-qr", zipPath, PAYLOAD_ROOT], {
      cwd: buildDir,
    });

    console.log("=== 4/6 VERIFY ZIP ===");
    const entryCount = validateZipRoot(zipPath);
    const packageSha256 = sha256File(zipPath);
    fs.writeFileSync(shaPath, `${packageSha256}  ${zipName}\n`, "utf8");

    const packageUrl =
      `https://github.com/${options.githubRepo}/releases/download/` +
      `${releaseId}/${zipName}`;
    const metadata = {
      schemaVersion: 1,
      releaseId,
      backendVersion: options.version,
      hubFirmwareVersion: versions.hubFirmwareVersion,
      protocolVersion: versions.protocolVersion,
      minBackendVersion: installedBackendVersion,
      packageFile: zipName,
      sha256File: `${zipName}.sha256`,
      packageSha256,
      packageUrl,
      githubRepo: options.githubRepo,
      payloadRoot: PAYLOAD_ROOT,
      entryCount,
      createdAt: Date.now(),
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });

    console.log("=== 5/6 ROTATE OLD BUILD OUTPUTS ===");
    const removedOutputs = rotateReleaseOutputs(
      options.outputRoot,
      options.keepReleases,
    );

    console.log("=== 6/6 RELEASE PREPARED ===");
    console.log(`releaseId: ${releaseId}`);
    console.log(`zip: ${zipPath}`);
    console.log(`sha256: ${packageSha256}`);
    console.log(`metadata: ${metadataPath}`);
    console.log(`entryCount: ${entryCount}`);
    console.log(`oldOutputsRemoved: ${removedOutputs.length}`);

    return { ...metadata, zipPath, shaPath, metadataPath, removedOutputs };
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv);
  prepareRelease(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`MAIYEN RELEASE PREPARE FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  PAYLOAD_ROOT,
  compareSemanticVersions,
  isSemanticVersion,
  parseArguments,
  prepareRelease,
  rotateReleaseOutputs,
  scanPayloadForSensitiveContent,
  shouldExclude,
};
