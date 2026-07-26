"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const packageJson = require("../package.json");
const {
  DEFAULT_HUB_FIRMWARE_VERSION,
  DEFAULT_PROTOCOL_VERSION,
  SYSTEM_VERSION,
  VERSION_SCHEMA_VERSION,
  getSystemVersionHeartbeatFields,
  normalizeSemanticVersion,
  versionMajor,
} = require("../system_version");

test("backend package and runtime version stay synchronized", () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+/);
  assert.equal(SYSTEM_VERSION.backendVersion, packageJson.version);
  assert.equal(SYSTEM_VERSION.versionSchemaVersion, VERSION_SCHEMA_VERSION);
});

test("Hub firmware and protocol have safe semantic-version defaults", () => {
  assert.equal(DEFAULT_HUB_FIRMWARE_VERSION, "1.0.0");
  assert.equal(DEFAULT_PROTOCOL_VERSION, "1.0.0");
  assert.match(SYSTEM_VERSION.hubFirmwareVersion, /^\d+\.\d+\.\d+/);
  assert.match(SYSTEM_VERSION.protocolVersion, /^\d+\.\d+\.\d+/);
});

test("heartbeat exposes the complete version contract", () => {
  assert.deepEqual(getSystemVersionHeartbeatFields(), {
    backendVersion: SYSTEM_VERSION.backendVersion,
    hubFirmwareVersion: SYSTEM_VERSION.hubFirmwareVersion,
    protocolVersion: SYSTEM_VERSION.protocolVersion,
    versionSchemaVersion: VERSION_SCHEMA_VERSION,
  });
});

test("semantic version helpers reject invalid values safely", () => {
  assert.equal(normalizeSemanticVersion("2.3.4", "1.0.0"), "2.3.4");
  assert.equal(normalizeSemanticVersion("bad", "1.0.0"), "1.0.0");
  assert.equal(versionMajor("v1.9.0"), 1);
  assert.equal(versionMajor("2.0.0"), 2);
  assert.equal(versionMajor("invalid"), null);
});

test("index heartbeat publishes all version fields", () => {
  const fs = require("node:fs");
  const indexSource = fs.readFileSync(
    require.resolve("../index.js"),
    "utf8",
  );

  assert.match(indexSource, /getSystemVersionHeartbeatFields/);
  assert.match(indexSource, /MAIYEN SYSTEM VERSION/);
});
