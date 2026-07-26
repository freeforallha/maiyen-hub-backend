"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const updaterModulePath = fs.existsSync(
  path.join(__dirname, "../scripts/apply_hub_update.next.js"),
)
  ? "../scripts/apply_hub_update.next.js"
  : "../scripts/apply_hub_update.js";
const {
  DEFAULT_ALLOWED_DOWNLOAD_HOSTS,
  ensureDirectoryMode,
  getNormalizedUpdateMode,
  stableDependencySnapshot,
  validateDownloadUrl,
  validateEnvelope,
  validateZipEntries,
} = require(updaterModulePath);
const { signReleaseManifest } = require("../hub_update_contract");

function manifest() {
  return {
    schemaVersion: 1,
    releaseId: "maiyen-hub-1.2.1",
    backendVersion: "1.2.1",
    hubFirmwareVersion: "1.1.1",
    protocolVersion: "1.0.0",
    minBackendVersion: "1.2.0",
    packageUrl: "https://storage.googleapis.com/example/update.zip",
    packageSha256: "c".repeat(64),
    publishedAt: 1784900000000,
    critical: false,
    notes: {},
  };
}

test("root updater accepts only configured HTTPS download hosts", () => {
  assert.equal(
    validateDownloadUrl(
      "https://storage.googleapis.com/example/update.zip",
      new Set(["storage.googleapis.com"]),
    ).hostname,
    "storage.googleapis.com",
  );
  assert.equal(
    validateDownloadUrl(
      "https://github.com/freeforallha/maiyen-hub-releases/releases/download/v1.2.1/update.zip",
      new Set(["github.com"]),
    ).hostname,
    "github.com",
  );
  assert.equal(
    validateDownloadUrl(
      "https://release-assets.githubusercontent.com/github-production-release-asset/example",
      new Set(["release-assets.githubusercontent.com"]),
    ).hostname,
    "release-assets.githubusercontent.com",
  );
  assert.throws(
    () => validateDownloadUrl(
      "https://evil.example/update.zip",
      new Set(["storage.googleapis.com"]),
    ),
    /package_host_not_allowed/,
  );
  assert.throws(
    () => validateDownloadUrl(
      "http://storage.googleapis.com/update.zip",
      new Set(["storage.googleapis.com"]),
    ),
    /package_url_must_use_https/,
  );
});

test("root updater default whitelist supports GitHub Releases and redirects", () => {
  const allowed = new Set(DEFAULT_ALLOWED_DOWNLOAD_HOSTS);
  assert.equal(allowed.has("github.com"), true);
  assert.equal(allowed.has("release-assets.githubusercontent.com"), true);
  assert.equal(allowed.has("objects.githubusercontent.com"), true);
});

test("root updater accepts only the canonical MaiYen payload root", () => {
  assert.equal(
    validateZipEntries([
      "maiyen_hub_backend/",
      "maiyen_hub_backend/index.js",
      "maiyen_hub_backend/package.json",
    ]),
    2,
  );
  assert.throws(
    () => validateZipEntries(["legacy_backend/index.js"]),
    /unsafe_package_entry/,
  );
  assert.throws(
    () => validateZipEntries(["maiyen_hub_backend/../../etc/passwd"]),
    /unsafe_package_entry/,
  );
  assert.throws(
    () => validateZipEntries(["maiyen_hub_backend/serviceAccount.json"]),
    /unsafe_package_entry/,
  );
});

test("dependency changes are compared independent of JSON key order", () => {
  const left = stableDependencySnapshot({
    dependencies: { mqtt: "1", dotenv: "2" },
  });
  const right = stableDependencySnapshot({
    dependencies: { dotenv: "2", mqtt: "1" },
  });
  assert.equal(left, right);
  assert.notEqual(
    left,
    stableDependencySnapshot({ dependencies: { mqtt: "9" } }),
  );
});

test("root updater envelope requires a valid signature and owner approval", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const releaseManifest = manifest();
  const signature = signReleaseManifest({
    manifest: releaseManifest,
    privateKey,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-key-"));
  const publicKeyPath = path.join(tempDir, "public.pem");
  fs.writeFileSync(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
  );

  const envelope = validateEnvelope(
    {
      hubId: "dev_123",
      ownerUid: "owner",
      homeId: "home",
      requestedBy: "owner",
      manifest: releaseManifest,
      signature,
    },
    publicKeyPath,
  );

  assert.equal(envelope.ownerUid, "owner");
  assert.equal(envelope.manifest.releaseId, releaseManifest.releaseId);

  assert.throws(
    () => validateEnvelope(
      {
        hubId: "dev_123",
        ownerUid: "owner",
        homeId: "home",
        requestedBy: "another-user",
        manifest: releaseManifest,
        signature,
      },
      publicKeyPath,
    ),
    /owner_confirmation_required/,
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});


test("root updater normalizes restrictive ZIP modes before tests", () => {
  const regularFile = {
    isDirectory: () => false,
    isFile: () => true,
    mode: 0o100600,
  };
  const executableFile = {
    isDirectory: () => false,
    isFile: () => true,
    mode: 0o100700,
  };
  const directory = {
    isDirectory: () => true,
    isFile: () => false,
    mode: 0o40700,
  };

  assert.equal(getNormalizedUpdateMode(regularFile), 0o644);
  assert.equal(getNormalizedUpdateMode(executableFile), 0o755);
  assert.equal(getNormalizedUpdateMode(directory), 0o755);

  const updaterSource = fs.readFileSync(
    path.join(__dirname, updaterModulePath),
    "utf8",
  );
  const normalizePayloadAt = updaterSource.indexOf(
    "normalizeUpdateTreeForRunUser(payloadDir, options.runUser)",
  );
  const stagedTestsAt = updaterSource.indexOf(
    "runTestsAsUser(stagedSourceDir, options.runUser)",
  );
  assert.ok(normalizePayloadAt >= 0);
  assert.ok(stagedTestsAt > normalizePayloadAt);
  assert.match(
    updaterSource,
    /overlayPayload\(payloadDir, stagedSourceDir, options\.runUser\)/,
  );
  assert.match(
    updaterSource,
    /overlayPayload\(payloadDir, options\.sourceDir, options\.runUser\)/,
  );
});


test("root updater overrides restrictive service umask on work directories", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-work-mode-"));
  const previousUmask = process.umask(0o007);

  try {
    const extractionDir = path.join(tempRoot, "extracted");
    ensureDirectoryMode(extractionDir, 0o755);
    assert.equal(fs.statSync(extractionDir).mode & 0o777, 0o755);

    const updaterSource = fs.readFileSync(
      path.join(__dirname, updaterModulePath),
      "utf8",
    );
    assert.match(
      updaterSource,
      /ensureDirectoryMode\(destination, 0o755\);[\s\S]*unzip/,
    );
    assert.match(
      updaterSource,
      /ensureDirectoryMode\(options\.workRoot, 0o711\);/,
    );
    assert.match(
      updaterSource,
      /ensureDirectoryMode\(workDir, 0o755\);/,
    );
  } finally {
    process.umask(previousUmask);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
