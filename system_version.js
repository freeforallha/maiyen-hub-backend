"use strict";

const fs = require("fs");
const packageJson = require("./package.json");

const VERSION_SCHEMA_VERSION = 1;
const DEFAULT_HUB_FIRMWARE_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "1.0.0";
const DEFAULT_FIRMWARE_VERSION_FILE =
  process.env.MAIYEN_HUB_FIRMWARE_VERSION_FILE ||
  process.env.SAFEHOME_HUB_FIRMWARE_VERSION_FILE ||
  "/etc/maiyen-updater/firmware-version";

function normalizeSemanticVersion(rawValue, fallbackValue) {
  const value = String(rawValue || "").trim();
  const fallback = String(fallbackValue || "").trim();
  const semanticVersionPattern =
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

  if (semanticVersionPattern.test(value)) {
    return value;
  }

  if (semanticVersionPattern.test(fallback)) {
    return fallback;
  }

  throw new Error(`Invalid semantic version fallback: ${fallback}`);
}

function versionMajor(rawVersion) {
  const value = String(rawVersion || "").trim();
  const match = /^(?:v)?(\d+)(?:\.|$)/i.exec(value);

  return match ? Number.parseInt(match[1], 10) : null;
}

function readFirmwareVersionFile(filePath = DEFAULT_FIRMWARE_VERSION_FILE) {
  try {
    return String(fs.readFileSync(filePath, "utf8") || "").trim();
  } catch (_) {
    return "";
  }
}

const SYSTEM_VERSION = Object.freeze({
  backendVersion: normalizeSemanticVersion(
    packageJson.version,
    "1.2.4",
  ),
  hubFirmwareVersion: normalizeSemanticVersion(
    process.env.MAIYEN_HUB_FIRMWARE_VERSION ||
      process.env.SAFEHOME_HUB_FIRMWARE_VERSION ||
      readFirmwareVersionFile(),
    DEFAULT_HUB_FIRMWARE_VERSION,
  ),
  protocolVersion: normalizeSemanticVersion(
    process.env.MAIYEN_PROTOCOL_VERSION ||
      process.env.SAFEHOME_PROTOCOL_VERSION,
    DEFAULT_PROTOCOL_VERSION,
  ),
  versionSchemaVersion: VERSION_SCHEMA_VERSION,
});

function getSystemVersionHeartbeatFields() {
  return {
    backendVersion: SYSTEM_VERSION.backendVersion,
    hubFirmwareVersion: SYSTEM_VERSION.hubFirmwareVersion,
    protocolVersion: SYSTEM_VERSION.protocolVersion,
    versionSchemaVersion: SYSTEM_VERSION.versionSchemaVersion,
  };
}

module.exports = {
  DEFAULT_FIRMWARE_VERSION_FILE,
  DEFAULT_HUB_FIRMWARE_VERSION,
  DEFAULT_PROTOCOL_VERSION,
  SYSTEM_VERSION,
  VERSION_SCHEMA_VERSION,
  getSystemVersionHeartbeatFields,
  normalizeSemanticVersion,
  readFirmwareVersionFile,
  versionMajor,
};
