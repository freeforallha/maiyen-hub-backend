"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("backend package uses the MaiYen technical name", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));

  assert.equal(packageJson.name, "maiyen-hub-backend");
  assert.equal(packageLock.name, "maiyen-hub-backend");
  assert.equal(packageLock.packages[""].name, "maiyen-hub-backend");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
});

test("runtime prefers MAIYEN environment variables with legacy fallback", () => {
  const indexSource = read("index.js");
  const versionSource = read("system_version.js");
  const contractSource = read("hub_update_contract.js");
  const bridgeSource = read("hub_update_bridge.js");
  const diagnosticSource = read("general_id.js");

  assert.match(indexSource, /MAIYEN_RUNTIME_DIR[\s\S]*SAFEHOME_RUNTIME_DIR/);
  assert.match(indexSource, /MAIYEN_HUB_NAME[\s\S]*SAFEHOME_HUB_NAME/);
  assert.match(versionSource, /MAIYEN_PROTOCOL_VERSION[\s\S]*SAFEHOME_PROTOCOL_VERSION/);
  assert.match(contractSource, /MAIYEN_UPDATE_PUBLIC_KEY_PATH/);
  assert.doesNotMatch(contractSource, /SAFEHOME_UPDATE_PUBLIC_KEY_PATH/);
  assert.match(bridgeSource, /MAIYEN_UPDATE_INBOX_FILE[\s\S]*SAFEHOME_UPDATE_INBOX_FILE/);
  assert.match(bridgeSource, /MAIYEN_UPDATE_RESULT_FILE[\s\S]*SAFEHOME_UPDATE_RESULT_FILE/);
  assert.match(diagnosticSource, /MAIYEN_SOURCE_DIR/);
  assert.doesNotMatch(diagnosticSource, /SAFEHOME_SOURCE_DIR|safehome-node|safehome_nodejs/);
});

test("alarm helper symbols and ready log use MaiYen names", () => {
  const source = read("index.js");

  assert.match(source, /function getMaiYenAndroidAlarmCollapseKey/);
  assert.match(source, /function getMaiYenAlarmDeliveryId/);
  assert.match(source, /function getMaiYenIosAlarmCategory/);
  assert.match(source, /function buildMaiYenAlarmApnsConfig/);
  assert.match(source, /MAIYEN BACKEND READY/);
  assert.doesNotMatch(source, /function getSafeHome/);
  assert.doesNotMatch(source, /function buildSafeHome/);
  assert.doesNotMatch(source, /SAFEHOME BACKEND READY/);
  assert.match(read("general_id.js"), /MAIYEN HUB DIAGNOSTIC REPORT/);
});

test("legacy external app identifiers remain isolated from Linux identity", () => {
  const source = read("index.js");
  const contractSource = read("hub_update_contract.js");

  assert.match(source, /SAFEHOME_REMINDER/);
  assert.match(source, /safehome_sensor_notification_v1/);
  assert.match(source, /safehome_backend/);
  assert.match(contractSource, /maiyen_hub_backend/);
  assert.match(contractSource, /\.maiyen_runtime/);
  assert.doesNotMatch(contractSource, /safehome_nodejs|\.safehome_runtime/);
});
