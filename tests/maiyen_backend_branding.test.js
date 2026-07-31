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
  const localRuntimeSource = read("domains/runtime/local_runtime.js");
  const hubIdentitySource = read("domains/hub/hub_identity.js");
  const versionSource = read("system_version.js");
  const contractSource = read("hub_update_contract.js");
  const bridgeSource = read("hub_update_bridge.js");
  const diagnosticSource = read("general_id.js");

  assert.match(
    localRuntimeSource,
    /MAIYEN_RUNTIME_DIR[\s\S]*SAFEHOME_RUNTIME_DIR/,
  );
  assert.match(
    hubIdentitySource,
    /MAIYEN_HUB_NAME[\s\S]*SAFEHOME_HUB_NAME/,
  );
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
  const lifecycleSource = read(
    "domains/alarm/alarm_incident_lifecycle.js",
  );
  const persistenceSource = read(
    "domains/alarm/alarm_incident_persistence.js",
  );
  const fcmDeliverySource = read(
    "domains/notifications/fcm_delivery.js",
  );
  const reminderSource = read(
    "domains/notifications/scheduled_reminder.js",
  );
  const homeActivitySource = read(
    "domains/notifications/home_activity.js",
  );
  const homeStatusSource = read(
    "domains/home/home_status_aggregation.js",
  );
  const homeMembershipSource = read(
    "domains/home/home_membership.js",
  );
  const homeActionRequestsSource = read(
    "domains/home/home_action_requests.js",
  );
  const presenceSessionSource = read(
    "domains/presence/presence_session.js",
  );
  const mqttIngestionSource = read(
    "domains/devices/mqtt_device_ingestion.js",
  );
  const deviceManagementSource = read(
    "domains/devices/device_management.js",
  );
  const securityModeSource = read(
    "domains/security/security_mode_orchestration.js",
  );
  const firebaseCoordinatorSource = read(
    "domains/runtime/firebase_request_coordinator.js",
  );
  const backendLifecycleSource = read(
    "domains/runtime/backend_lifecycle.js",
  );

  assert.match(lifecycleSource, /function getMaiYenAndroidAlarmCollapseKey/);
  assert.match(lifecycleSource, /function getMaiYenAlarmDeliveryId/);
  assert.match(lifecycleSource, /function getMaiYenIosAlarmCategory/);
  assert.match(lifecycleSource, /function buildMaiYenAlarmApnsConfig/);
  assert.match(source, /MAIYEN BACKEND READY/);
  assert.doesNotMatch(source, /function getSafeHome/);
  assert.doesNotMatch(source, /function buildSafeHome/);
  assert.doesNotMatch(lifecycleSource, /function getSafeHome/);
  assert.doesNotMatch(lifecycleSource, /function buildSafeHome/);
  assert.doesNotMatch(persistenceSource, /function getSafeHome/);
  assert.doesNotMatch(persistenceSource, /function buildSafeHome/);
  assert.doesNotMatch(fcmDeliverySource, /function getSafeHome/);
  assert.doesNotMatch(fcmDeliverySource, /function buildSafeHome/);
  assert.doesNotMatch(reminderSource, /function getSafeHome/);
  assert.doesNotMatch(reminderSource, /function buildSafeHome/);
  assert.doesNotMatch(homeActivitySource, /function getSafeHome/);
  assert.doesNotMatch(homeActivitySource, /function buildSafeHome/);
  assert.doesNotMatch(homeStatusSource, /function getSafeHome/);
  assert.doesNotMatch(homeStatusSource, /function buildSafeHome/);
  assert.match(homeStatusSource, /createHomeStatusAggregation/);
  assert.match(homeMembershipSource, /createHomeMembershipDomain/);
  assert.doesNotMatch(
    homeMembershipSource,
    /SAFEHOME|SafeHome|safehome/,
  );
  assert.match(
    homeActionRequestsSource,
    /createHomeActionRequestDomain/,
  );
  assert.doesNotMatch(
    homeActionRequestsSource,
    /SAFEHOME|SafeHome|safehome/,
  );
  assert.doesNotMatch(presenceSessionSource, /function getSafeHome/);
  assert.doesNotMatch(presenceSessionSource, /function buildSafeHome/);
  assert.doesNotMatch(mqttIngestionSource, /function getSafeHome/);
  assert.doesNotMatch(mqttIngestionSource, /function buildSafeHome/);
  assert.doesNotMatch(deviceManagementSource, /function getSafeHome/);
  assert.doesNotMatch(deviceManagementSource, /function buildSafeHome/);
  assert.doesNotMatch(securityModeSource, /function getSafeHome/);
  assert.doesNotMatch(securityModeSource, /function buildSafeHome/);
  assert.match(
    securityModeSource,
    /createSecurityModeOrchestrationDomain/,
  );
  assert.match(
    firebaseCoordinatorSource,
    /createFirebaseRequestCoordinator/,
  );
  assert.match(
    backendLifecycleSource,
    /createBackendLifecycleCoordinator/,
  );
  assert.match(
    backendLifecycleSource,
    /BACKEND LIFECYCLE STARTED/,
  );
  assert.doesNotMatch(
    firebaseCoordinatorSource,
    /SAFEHOME|SafeHome|safehome/,
  );
  assert.match(
    presenceSessionSource,
    /createPresenceRecoveryCoordinator/,
  );
  assert.doesNotMatch(source, /SAFEHOME BACKEND READY/);
  assert.match(read("general_id.js"), /MAIYEN HUB DIAGNOSTIC REPORT/);
});

test("legacy external app identifiers remain isolated from Linux identity", () => {
  const source = read("index.js");
  const contractSource = read("hub_update_contract.js");

  const reminderSource = read(
    "domains/notifications/scheduled_reminder.js",
  );

  assert.match(reminderSource, /SAFEHOME_REMINDER/);
  assert.match(source, /safehome_sensor_notification_v1/);
  assert.match(source, /safehome_backend/);
  assert.match(contractSource, /maiyen_hub_backend/);
  assert.match(contractSource, /\.maiyen_runtime/);
  assert.doesNotMatch(contractSource, /safehome_nodejs|\.safehome_runtime/);
});
