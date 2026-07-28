"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { execFileSync } = require("child_process");

const {
  compareSemanticVersions,
  prepareRelease,
  rotateReleaseOutputs,
  shouldExclude,
} = require("../scripts/prepare_maiyen_hub_release");
const {
  rotateManifestBackups,
  writeManifestBackup,
} = require("../scripts/publish_hub_release_to_firebase");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode });
}

test("semantic version comparison is strict and deterministic", () => {
  assert.equal(compareSemanticVersions("1.2.7", "1.2.6"), 1);
  assert.equal(compareSemanticVersions("1.2.7", "1.2.7"), 0);
  assert.equal(compareSemanticVersions("1.2.6", "1.2.7"), -1);
  assert.throws(() => compareSemanticVersions("1.2", "1.2.7"));
});

test("release exclusions remove secrets, runtime data, reports, and backups", () => {
  const dir = (name) => ({ name, isDirectory: () => true });
  const file = (name) => ({ name, isDirectory: () => false });

  assert.equal(shouldExclude("node_modules", dir("node_modules")), true);
  assert.equal(shouldExclude("reports", dir("reports")), true);
  assert.equal(shouldExclude("serviceAccount.json", file("serviceAccount.json")), true);
  assert.equal(shouldExclude("secret.pem", file("secret.pem")), true);
  assert.equal(shouldExclude("index.js.backup-old", file("index.js.backup-old")), true);
  assert.equal(shouldExclude("index.js", file("index.js")), false);
});

test("release preparation creates a clean canonical ZIP and SHA file", () => {
  const root = temporaryDirectory("maiyen-release-test-");
  const sourceDir = path.join(root, "source");
  const runtimeDir = path.join(root, "runtime");
  const outputRoot = path.join(root, "out");

  writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ name: "maiyen-hub-backend", version: "1.2.7" }),
  );
  writeFile(
    path.join(sourceDir, "system_version.js"),
    'module.exports.SYSTEM_VERSION={backendVersion:"1.2.7",hubFirmwareVersion:"1.1.0",protocolVersion:"1.0.0"};\n',
  );
  writeFile(path.join(sourceDir, "index.js"), 'console.log("ok");\n');
  writeFile(path.join(sourceDir, "reports", "audit.json"), "{}\n");
  writeFile(path.join(sourceDir, "serviceAccount.json"), "{}\n");
  writeFile(path.join(sourceDir, "old.zip"), "not-a-zip\n");
  writeFile(
    path.join(runtimeDir, "package.json"),
    JSON.stringify({ name: "maiyen-hub-backend", version: "1.2.6" }),
  );

  const result = prepareRelease({
    version: "1.2.7",
    sourceDir,
    runtimeDir,
    outputRoot,
    githubRepo: "freeforallha/maiyen-hub-releases",
    keepReleases: 3,
    skipTests: true,
  });

  assert.equal(fs.existsSync(result.zipPath), true);
  assert.equal(fs.existsSync(result.shaPath), true);
  assert.match(fs.readFileSync(result.shaPath, "utf8"), /^[a-f0-9]{64}  /);

  const entries = execFileSync("/usr/bin/unzip", ["-Z1", result.zipPath], {
    encoding: "utf8",
  });
  assert.match(entries, /^maiyen_hub_backend\//m);
  assert.doesNotMatch(entries, /reports/);
  assert.doesNotMatch(entries, /serviceAccount\.json/);
  assert.doesNotMatch(entries, /old\.zip/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("release output rotation only removes old canonical release directories", () => {
  const root = temporaryDirectory("maiyen-release-rotate-");
  for (const name of ["v1.2.4", "v1.2.5", "v1.2.6", "v1.2.7"]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const patch = Number(name.split(".")[2]);
    const date = new Date(2026, 0, patch);
    fs.utimesSync(dir, date, date);
  }
  fs.mkdirSync(path.join(root, "manual-notes"));

  const removed = rotateReleaseOutputs(root, 3);
  assert.equal(removed.length, 1);
  assert.equal(fs.existsSync(path.join(root, "v1.2.4")), false);
  assert.equal(fs.existsSync(path.join(root, "manual-notes")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("manifest backup rotation preserves newest files only", () => {
  const root = temporaryDirectory("maiyen-manifest-rotate-");
  for (let index = 1; index <= 4; index += 1) {
    const filePath = path.join(root, `backup-${index}.json`);
    writeFile(filePath, JSON.stringify({ index }));
    const date = new Date(2026, 0, index);
    fs.utimesSync(filePath, date, date);
  }
  writeFile(path.join(root, "keep.txt"), "keep\n");

  const removed = rotateManifestBackups(root, 2);
  assert.equal(removed.length, 2);
  assert.equal(fs.existsSync(path.join(root, "backup-1.json")), false);
  assert.equal(fs.existsSync(path.join(root, "backup-4.json")), true);
  assert.equal(fs.existsSync(path.join(root, "keep.txt")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("manifest backup is written with restrictive permissions", () => {
  const root = temporaryDirectory("maiyen-manifest-backup-");
  const backupPath = writeManifestBackup(root, { releaseId: "v1.2.6" });
  assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")), {
    releaseId: "v1.2.6",
  });
  fs.rmSync(root, { recursive: true, force: true });
});
