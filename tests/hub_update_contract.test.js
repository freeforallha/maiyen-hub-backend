"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  HUB_UPDATE_SCHEMA_VERSION,
  canonicalizeReleaseManifest,
  compareSemanticVersions,
  isReleaseNewerThanCurrent,
  isSafeRelativePayloadPath,
  normalizeReleaseManifest,
  signReleaseManifest,
  validateReleaseCompatibility,
  verifyReleaseManifestSignature,
} = require("../hub_update_contract");

function createManifest(overrides = {}) {
  return {
    schemaVersion: HUB_UPDATE_SCHEMA_VERSION,
    releaseId: "maiyen-hub-1.2.1",
    backendVersion: "1.2.1",
    hubFirmwareVersion: "1.1.1",
    protocolVersion: "1.0.0",
    minBackendVersion: "1.2.0",
    packageUrl:
      "https://firebasestorage.googleapis.com/v0/b/example/o/update.zip?alt=media",
    packageSha256: "a".repeat(64),
    publishedAt: 1784900000000,
    critical: false,
    notes: {
      vi: "Bản cập nhật thử nghiệm",
      en: "Test update",
    },
    ...overrides,
  };
}

test("release manifest canonical form is deterministic", () => {
  const first = createManifest({ notes: { vi: "VN", en: "EN" } });
  const second = createManifest({ notes: { en: "EN", vi: "VN" } });
  assert.equal(
    canonicalizeReleaseManifest(first),
    canonicalizeReleaseManifest(second),
  );
});

test("Ed25519 release signatures are verified before update", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = createManifest();
  const signature = signReleaseManifest({ manifest, privateKey });

  assert.deepEqual(
    verifyReleaseManifestSignature({ manifest, signature, publicKey }),
    normalizeReleaseManifest(manifest),
  );

  assert.throws(
    () => verifyReleaseManifestSignature({
      manifest: { ...manifest, backendVersion: "9.9.9" },
      signature,
      publicKey,
    }),
    /invalid_release_signature/,
  );
});

test("only HTTPS package URLs and valid SHA-256 are accepted", () => {
  assert.throws(
    () => normalizeReleaseManifest(createManifest({
      packageUrl: "http://example.com/update.zip",
    })),
    /package_url_must_use_https/,
  );
  assert.throws(
    () => normalizeReleaseManifest(createManifest({ packageSha256: "abc" })),
    /invalid_package_sha256/,
  );
});

test("semantic version compatibility and update availability are stable", () => {
  const manifest = createManifest();
  assert.equal(compareSemanticVersions("1.2.1", "1.2.0"), 1);
  assert.equal(compareSemanticVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareSemanticVersions("1.1.9", "1.2.0"), -1);
  assert.equal(
    isReleaseNewerThanCurrent(manifest, {
      backendVersion: "1.2.0",
      hubFirmwareVersion: "1.1.0",
    }),
    true,
  );
  assert.doesNotThrow(() => validateReleaseCompatibility(manifest, {
    backendVersion: "1.2.0",
    protocolVersion: "1.0.9",
  }));
  assert.throws(
    () => validateReleaseCompatibility(manifest, {
      backendVersion: "1.1.9",
      protocolVersion: "1.0.0",
    }),
    /backend_too_old_for_release/,
  );
  assert.throws(
    () => validateReleaseCompatibility(manifest, {
      backendVersion: "1.2.0",
      protocolVersion: "2.0.0",
    }),
    /protocol_major_incompatible/,
  );
});

test("update ZIP entries accept only the MaiYen payload root", () => {
  assert.equal(isSafeRelativePayloadPath("maiyen_hub_backend/"), true);
  assert.equal(isSafeRelativePayloadPath("maiyen_hub_backend/index.js"), true);
  assert.equal(
    isSafeRelativePayloadPath("maiyen_hub_backend/scripts/deploy_backend_production.sh"),
    true,
  );
  assert.equal(isSafeRelativePayloadPath("legacy_backend/index.js"), false);
  assert.equal(isSafeRelativePayloadPath("../etc/passwd"), false);
  assert.equal(
    isSafeRelativePayloadPath("maiyen_hub_backend/serviceAccount.json"),
    false,
  );
  assert.equal(
    isSafeRelativePayloadPath("maiyen_hub_backend/node_modules/x.js"),
    false,
  );
  assert.equal(
    isSafeRelativePayloadPath("maiyen_hub_backend/private.pem"),
    false,
  );
  assert.equal(
    isSafeRelativePayloadPath("maiyen_hub_backend/.maiyen_runtime/cache.json"),
    false,
  );
  assert.equal(
    isSafeRelativePayloadPath("maiyen_hub_backend/.legacy_runtime/cache.json"),
    false,
  );
});
