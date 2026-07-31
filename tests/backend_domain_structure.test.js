"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const { createHubHeartbeat } = require("../domains/hub/hub_heartbeat");
const { createOrderedListCleanup } = require(
  "../domains/shared/ordered_list_cleanup",
);

test("composition root uses extracted Hub, health, Auto Away, runtime, device, notification and Alarm domains", () => {
  const source = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

  assert.match(source, /createHubIdentity/);
  assert.match(source, /createHubHeartbeat/);
  assert.match(source, /createOrderedListCleanup/);
  assert.match(source, /createFcmDeliveryDomain/);
  assert.match(source, /domains\/notifications\/fcm_delivery/);
  assert.match(source, /createScheduledReminderDomain/);
  assert.match(source, /domains\/notifications\/scheduled_reminder/);
  assert.match(source, /createHomeActivityDomain/);
  assert.match(source, /domains\/notifications\/home_activity/);
  assert.match(source, /createSystemHealthDomain/);
  assert.match(source, /createAutoAwayDomain/);
  assert.match(source, /createLocalRuntimeDomain/);
  assert.match(source, /domains\/devices\/device_profile/);
  assert.match(source, /domains\/alarm\/alarm_schedule/);
  assert.match(source, /createAlarmIncidentDomain/);
  assert.match(source, /domains\/alarm\/alarm_incident/);
  assert.match(source, /createAlarmIncidentLifecycle/);
  assert.match(source, /domains\/alarm\/alarm_incident_lifecycle/);
  assert.match(source, /createAlarmIncidentPersistence/);
  assert.match(source, /domains\/alarm\/alarm_incident_persistence/);
  assert.match(source, /createPhysicalSirenDomain/);
  assert.match(source, /domains\/alarm\/physical_siren/);
  assert.match(source, /createSensorAlarmEngine/);
  assert.match(source, /domains\/alarm\/sensor_alarm_engine/);
  assert.doesNotMatch(
    source,
    /const crypto = require\(["']crypto["']\);/,
  );
  assert.doesNotMatch(source, /function readConnectedWifiInfo\(/);
  assert.doesNotMatch(source, /function getUserFcmTargets\(/);
  assert.doesNotMatch(source, /async function sendPushToUser\(/);
  assert.doesNotMatch(source, /function localizePushMessageForUser\(/);
  assert.doesNotMatch(source, /function sendScheduledReminderSummary\(/);
  assert.doesNotMatch(source, /function queueScheduledReminder\(/);
  assert.doesNotMatch(source, /function sendScheduledNotification\(/);
  assert.doesNotMatch(source, /function checkScheduledNotifications\(/);
  assert.doesNotMatch(source, /async function addHomeNotificationFromBackend\(/);
  assert.doesNotMatch(source, /async function addHomeNotificationToHomeRecipients\(/);
  assert.doesNotMatch(source, /const homeNotificationRequestInProgress/);
  assert.doesNotMatch(source, /db\.ref\("home_notification_requests"\)\.on/);
  assert.doesNotMatch(source, /async function getHomesLinkedToThisHub\(/);
  assert.doesNotMatch(source, /async function trimOrderedListByTime\(/);
  assert.doesNotMatch(source, /function evaluateHomeSystemHealth\(/);
  assert.doesNotMatch(source, /async function checkAutoAwayHomes\(/);
  assert.doesNotMatch(
    source,
    /function resolveAutoAwayParticipantSelection\(/,
  );
  assert.doesNotMatch(source, /function ensureLocalRuntimeDirectory\(/);
  assert.doesNotMatch(source, /function enqueueOfflineOperation\(/);
  assert.doesNotMatch(source, /function flushOfflineOperationQueue\(/);
  assert.doesNotMatch(source, /function startFirebaseConnectionMonitor\(/);
  assert.doesNotMatch(source, /function normalizeLockState\(/);
  assert.doesNotMatch(source, /function inferDeviceTypeFromPayload\(/);
  assert.doesNotMatch(source, /function getDeviceTypeFromModel\(/);
  assert.doesNotMatch(source, /function isActiveSignal\(/);
  assert.doesNotMatch(source, /function normalizeAlarmDays\(/);
  assert.doesNotMatch(
    source,
    /function normalizeDeviceAlarmScheduleCollection\(/,
  );
  assert.doesNotMatch(source, /function resolveActiveDeviceSchedule\(/);
  assert.doesNotMatch(source, /function isScheduledAlarmSource\(/);
  assert.doesNotMatch(source, /function normalizeAlarmIncidentItems\(/);
  assert.doesNotMatch(source, /function getAlarmIncidentTargetKey\(/);
  assert.doesNotMatch(source, /function getAlarmIncidentFlowType\(/);
  assert.doesNotMatch(source, /function incidentRequiresPhysicalSiren\(/);
  assert.doesNotMatch(source, /function isEmergencyDeviceType\(/);
  assert.doesNotMatch(source, /function isSecurityDeviceType\(/);
  assert.doesNotMatch(source, /async function setPhysicalSirenForHome\(/);
  assert.doesNotMatch(source, /async function reconcilePhysicalSirenForHome\(/);
  assert.doesNotMatch(source, /function startPhysicalSirenMonitor\(/);
  assert.doesNotMatch(source, /function normalizeDeviceAlarmPolicy\(/);
  assert.doesNotMatch(source, /function getSensorAlarmEventCode\(/);
  assert.doesNotMatch(source, /function buildAlarmTriggerFromSensorEvent\(/);
  assert.doesNotMatch(source, /function resolveAlarmActivationPriority\(/);
  assert.doesNotMatch(source, /function normalizeHomeSecurityMode\(/);
  assert.doesNotMatch(source, /function shouldAcceptSensorAlarmTrigger\(/);
  assert.doesNotMatch(source, /function advanceAlarmIncidentToStage\(/);
  assert.doesNotMatch(source, /function scheduleAlarmIncidentStages\(/);
  assert.doesNotMatch(source, /function withAlarmIncidentStartLock\(/);
  assert.doesNotMatch(source, /function buildMaiYenAlarmApnsConfig\(/);
  assert.doesNotMatch(source, /const groups = new Map\(\);/);
  assert.doesNotMatch(source, /forcedRedeliveryItems/);
  assert.doesNotMatch(source, /OLD ALARM INCIDENT SUPERSEDED/);
  assert.match(
    source,
    /function asObject\(value\) \{[\s\S]*?!Array\.isArray\(value\)[\s\S]*?: \{\};[\s\S]*?\}/,
  );

  const lifecycleSource = fs.readFileSync(
    path.join(
      ROOT,
      "domains",
      "alarm",
      "alarm_incident_lifecycle.js",
    ),
    "utf8",
  );
  assert.match(
    lifecycleSource,
    /const crypto = require\(["']crypto["']\);/,
  );

  const deploySource = fs.readFileSync(
    path.join(ROOT, "scripts", "deploy_backend_production.sh"),
    "utf8",
  );
  assert.match(
    deploySource,
    /domains\/notifications\/fcm_delivery\.js/,
  );
  assert.match(
    deploySource,
    /domains\/notifications\/scheduled_reminder\.js/,
  );
  assert.match(
    deploySource,
    /domains\/notifications\/home_activity\.js/,
  );
  assert.match(
    deploySource,
    /domains\/system_health\/system_health\.js/,
  );
  assert.match(
    deploySource,
    /domains\/auto_away\/auto_away\.js/,
  );
  assert.match(
    deploySource,
    /domains\/runtime\/local_runtime\.js/,
  );
  assert.match(
    deploySource,
    /domains\/devices\/device_profile\.js/,
  );
  assert.match(
    deploySource,
    /domains\/alarm\/alarm_schedule\.js/,
  );
  assert.match(
    deploySource,
    /domains\/alarm\/alarm_incident\.js/,
  );
  assert.match(
    deploySource,
    /domains\/alarm\/alarm_incident_lifecycle\.js/,
  );
  assert.match(
    deploySource,
    /domains\/alarm\/alarm_incident_persistence\.js/,
  );
  assert.match(
    deploySource,
    /domains\/alarm\/physical_siren\.js/,
  );
  assert.match(
    deploySource,
    /domains\/alarm\/sensor_alarm_engine\.js/,
  );
});

test("Hub heartbeat writes only linked homes and keeps one global heartbeat", async () => {
  const writes = [];
  const index = {
    a: { deviceId: "dev_test", uid: "ownerA", homeId: "homeA" },
    b: { deviceId: "dev_other", uid: "ownerB", homeId: "homeB" },
    c: { deviceId: "dev_test", uid: "ownerA", homeId: "homeA" },
  };
  const db = {
    ref(pathValue = "") {
      if (pathValue === "system/devices_by_ieee") {
        return { once: async () => ({ val: () => index }) };
      }
      assert.equal(pathValue, "");
      return { update: async (value) => writes.push(value) };
    },
  };
  const runtime = createHubHeartbeat({
    db,
    deviceId: "dev_test",
    hubName: "MaiYen Hub",
    hubModel: "Pi",
    startedAt: 1,
    intervalMs: 60000,
    readConnectedWifiInfo: () => ({
      connected: true,
      ssid: "Home",
      interfaceName: "wlan0",
    }),
    getMqttConnected: () => true,
    getSystemVersionHeartbeatFields: () => ({ backendVersion: "1.2.11" }),
    getHubUpdateHeartbeatFields: () => ({ updateAvailable: false }),
    processId: 123,
    log: () => {},
  });

  await runtime.writeHubHeartbeat();

  assert.equal(writes.length, 1);
  assert.ok(writes[0]["system/hubs/dev_test"]);
  assert.equal(
    writes[0]["accounts/ownerA/homes/homeA/hubId"],
    "dev_test",
  );
  assert.equal(
    writes[0]["accounts/ownerB/homes/homeB/hubId"],
    undefined,
  );
});

test("ordered timeline cleanup removes only the oldest overflow", async () => {
  const updates = [];
  const children = ["a", "b", "c", "d", "e"];
  const listRef = {
    orderByChild() { return this; },
    limitToFirst() { return this; },
    async once() {
      return {
        forEach(callback) {
          for (const key of children) callback({ key });
        },
      };
    },
    async update(value) {
      updates.push(value);
      children.splice(0, Object.keys(value).length);
    },
  };
  const cleanup = createOrderedListCleanup({ batchSize: 2, maxPasses: 2 });

  await cleanup.trimOrderedListByTime(listRef, 3);

  assert.deepEqual(updates, [{ a: null, b: null }]);
});
