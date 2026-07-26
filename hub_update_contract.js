"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HUB_UPDATE_SCHEMA_VERSION = 1;
const DEFAULT_UPDATE_PUBLIC_KEY_PATH =
  process.env.MAIYEN_UPDATE_PUBLIC_KEY_PATH ||
  "/etc/maiyen-updater/release-public-key.pem";

const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "releaseId",
  "backendVersion",
  "hubFirmwareVersion",
  "protocolVersion",
  "minBackendVersion",
  "packageUrl",
  "packageSha256",
  "publishedAt",
  "critical",
  "notes",
]);

const SEMANTIC_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UPDATE_PAYLOAD_ROOTS = Object.freeze([
  "maiyen_hub_backend",
]);
const FORBIDDEN_RUNTIME_DIRECTORIES = Object.freeze([
  ".maiyen_runtime",
]);

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function sortObjectDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectDeep);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObjectDeep(value[key]);
      return result;
    }, {});
}

function normalizeReleaseNotes(rawNotes) {
  const notes = normalizeObject(rawNotes);
  const normalized = {};

  for (const [languageCode, text] of Object.entries(notes)) {
    const key = String(languageCode || "").trim().toLowerCase();
    const value = String(text || "").trim();

    if (!/^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/.test(key) || !value) {
      continue;
    }

    normalized[key] = value.slice(0, 2000);
  }

  return sortObjectDeep(normalized);
}

function normalizeSemanticVersion(rawValue, fieldName) {
  const value = String(rawValue || "").trim();

  if (!SEMANTIC_VERSION_PATTERN.test(value)) {
    throw new Error(`invalid_${fieldName}`);
  }

  return value;
}

function normalizeReleaseManifest(rawManifest) {
  const manifest = normalizeObject(rawManifest);
  const schemaVersion = Number(manifest.schemaVersion);
  const releaseId = String(manifest.releaseId || "").trim();
  const packageUrl = String(manifest.packageUrl || "").trim();
  const packageSha256 = String(manifest.packageSha256 || "")
    .trim()
    .toLowerCase();
  const publishedAt = Number(manifest.publishedAt);

  if (schemaVersion !== HUB_UPDATE_SCHEMA_VERSION) {
    throw new Error("unsupported_update_schema");
  }

  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error("invalid_release_id");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(packageUrl);
  } catch (_) {
    throw new Error("invalid_package_url");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("package_url_must_use_https");
  }

  if (!SHA256_PATTERN.test(packageSha256)) {
    throw new Error("invalid_package_sha256");
  }

  if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) {
    throw new Error("invalid_published_at");
  }

  return {
    schemaVersion,
    releaseId,
    backendVersion: normalizeSemanticVersion(
      manifest.backendVersion,
      "backend_version",
    ),
    hubFirmwareVersion: normalizeSemanticVersion(
      manifest.hubFirmwareVersion,
      "hub_firmware_version",
    ),
    protocolVersion: normalizeSemanticVersion(
      manifest.protocolVersion,
      "protocol_version",
    ),
    minBackendVersion: normalizeSemanticVersion(
      manifest.minBackendVersion,
      "minimum_backend_version",
    ),
    packageUrl: parsedUrl.toString(),
    packageSha256,
    publishedAt,
    critical: manifest.critical === true,
    notes: normalizeReleaseNotes(manifest.notes),
  };
}

function canonicalizeReleaseManifest(rawManifest) {
  const normalized = normalizeReleaseManifest(rawManifest);
  const ordered = {};

  for (const key of MANIFEST_KEYS) {
    ordered[key] = normalized[key];
  }

  return JSON.stringify(ordered);
}

function readUpdatePublicKey(
  publicKeyPath = DEFAULT_UPDATE_PUBLIC_KEY_PATH,
) {
  const resolvedPath = path.resolve(String(publicKeyPath || ""));
  const pem = fs.readFileSync(resolvedPath, "utf8");

  return crypto.createPublicKey(pem);
}

function verifyReleaseManifestSignature({
  manifest,
  signature,
  publicKey,
  publicKeyPath = DEFAULT_UPDATE_PUBLIC_KEY_PATH,
}) {
  const normalizedSignature = String(signature || "").trim();

  if (!normalizedSignature) {
    throw new Error("missing_release_signature");
  }

  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(normalizedSignature, "base64");
  } catch (_) {
    throw new Error("invalid_release_signature_encoding");
  }

  if (signatureBuffer.length < 32) {
    throw new Error("invalid_release_signature_encoding");
  }

  const key = publicKey || readUpdatePublicKey(publicKeyPath);
  const canonical = canonicalizeReleaseManifest(manifest);
  const valid = crypto.verify(
    null,
    Buffer.from(canonical, "utf8"),
    key,
    signatureBuffer,
  );

  if (!valid) {
    throw new Error("invalid_release_signature");
  }

  return normalizeReleaseManifest(manifest);
}

function signReleaseManifest({ manifest, privateKey }) {
  if (!privateKey) {
    throw new Error("missing_release_private_key");
  }

  const canonical = canonicalizeReleaseManifest(manifest);
  return crypto
    .sign(null, Buffer.from(canonical, "utf8"), privateKey)
    .toString("base64");
}

function parseVersionCore(rawVersion) {
  const normalized = normalizeSemanticVersion(rawVersion, "version");
  const core = normalized.split(/[+-]/, 1)[0];
  return core.split(".").map((part) => Number.parseInt(part, 10));
}

function compareSemanticVersions(leftVersion, rightVersion) {
  const left = parseVersionCore(leftVersion);
  const right = parseVersionCore(rightVersion);

  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }

  return 0;
}

function isReleaseNewerThanCurrent(manifest, currentVersions) {
  const release = normalizeReleaseManifest(manifest);
  const current = normalizeObject(currentVersions);

  return (
    compareSemanticVersions(
      release.backendVersion,
      current.backendVersion || "0.0.0",
    ) > 0 ||
    compareSemanticVersions(
      release.hubFirmwareVersion,
      current.hubFirmwareVersion || "0.0.0",
    ) > 0
  );
}

function validateReleaseCompatibility(manifest, currentVersions) {
  const release = normalizeReleaseManifest(manifest);
  const current = normalizeObject(currentVersions);
  const currentBackendVersion = normalizeSemanticVersion(
    current.backendVersion || "0.0.0",
    "current_backend_version",
  );
  const currentProtocolVersion = normalizeSemanticVersion(
    current.protocolVersion || "0.0.0",
    "current_protocol_version",
  );

  if (
    compareSemanticVersions(
      currentBackendVersion,
      release.minBackendVersion,
    ) < 0
  ) {
    throw new Error("backend_too_old_for_release");
  }

  const currentProtocolMajor = Number.parseInt(
    currentProtocolVersion.split(".")[0],
    10,
  );
  const releaseProtocolMajor = Number.parseInt(
    release.protocolVersion.split(".")[0],
    10,
  );

  if (currentProtocolMajor !== releaseProtocolMajor) {
    throw new Error("protocol_major_incompatible");
  }

  return release;
}

function getUpdatePayloadRoot(rawPath) {
  const value = String(rawPath || "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(value);

  for (const root of UPDATE_PAYLOAD_ROOTS) {
    if (normalized === root || normalized === `${root}/`) {
      return root;
    }
    if (normalized.startsWith(`${root}/`)) {
      return root;
    }
  }

  return "";
}

function isSafeRelativePayloadPath(rawPath) {
  const value = String(rawPath || "").replace(/\\/g, "/");

  if (!value || value.includes("\0") || value.startsWith("/")) {
    return false;
  }

  const normalized = path.posix.normalize(value);

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return false;
  }

  const payloadRoot = getUpdatePayloadRoot(normalized);
  if (!payloadRoot) {
    return false;
  }

  if (normalized === payloadRoot || normalized === `${payloadRoot}/`) {
    return true;
  }

  const relative = normalized.slice(`${payloadRoot}/`.length);
  const forbiddenSegments = new Set([
    ".git",
    ...FORBIDDEN_RUNTIME_DIRECTORIES,
    "node_modules",
    "backups",
  ]);

  const segments = relative.split("/").filter(Boolean);
  if (
    segments.some(
      (segment) =>
        forbiddenSegments.has(segment) ||
        /^\.[a-z0-9_-]+_runtime$/i.test(segment),
    )
  ) {
    return false;
  }

  const baseName = segments.at(-1) || "";
  const forbiddenBaseNames = new Set([
    ".env",
    "serviceAccount.json",
    "key.properties",
    "local.properties",
  ]);

  if (
    forbiddenBaseNames.has(baseName) ||
    /service[-_]?account/i.test(baseName) ||
    /firebase-adminsdk/i.test(baseName) ||
    /\.(?:pem|key|p12|pfx)$/i.test(baseName)
  ) {
    return false;
  }

  return true;
}

module.exports = {
  FORBIDDEN_RUNTIME_DIRECTORIES,
  UPDATE_PAYLOAD_ROOTS,
  getUpdatePayloadRoot,
  DEFAULT_UPDATE_PUBLIC_KEY_PATH,
  HUB_UPDATE_SCHEMA_VERSION,
  canonicalizeReleaseManifest,
  compareSemanticVersions,
  isReleaseNewerThanCurrent,
  isSafeRelativePayloadPath,
  normalizeReleaseManifest,
  readUpdatePublicKey,
  signReleaseManifest,
  validateReleaseCompatibility,
  verifyReleaseManifestSignature,
};
