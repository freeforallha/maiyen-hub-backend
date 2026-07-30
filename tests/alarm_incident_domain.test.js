"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAlarmIncidentDomain,
  getAlarmIncidentTargetKey,
  normalizeAlarmIncidentItems,
  normalizePreferredSecurityIncidentItems,
  filterCurrentSecurityAlarmDeliveryItems,
  getAlarmIncidentFlowType,
  getEmergencyIncidentTitle,
  getAlarmIncidentLines,
  haveAlarmIncidentItemsChanged,
  getAlarmIncidentRuntimePreferences,
  isPersistentEmergencyIncidentItem,
  getSecurityIncidentStageRank,
  incidentRequiresPhysicalSiren,
  isSecurityDeviceType,
  isEmergencyDeviceType,
} = require("../domains/alarm/alarm_incident");

function item(overrides = {}) {
  return {
    ownerUid: "owner",
    homeId: "home",
    homeName: "Nhà chính",
    deviceId: "door-1",
    deviceName: "Cửa chính",
    type: "door",
    reason: "Cửa chính: Cửa đang mở",
    alarmSource: "scheduled_alarm",
    repeatMinutes: 15,
    ...overrides,
  };
}

test("incident target key is deterministic and separated by receiver and flow", () => {
  const first = getAlarmIncidentTargetKey(
    "receiver",
    "owner",
    "home",
    "security",
  );
  const same = getAlarmIncidentTargetKey(
    "receiver",
    "owner",
    "home",
    "security",
  );
  const emergency = getAlarmIncidentTargetKey(
    "receiver",
    "owner",
    "home",
    "emergency",
  );

  assert.equal(first, same);
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.notEqual(first, emergency);
});

test("local active incident index supports set, query and removal", () => {
  const runtimeMap = new Map();
  const domain = createAlarmIncidentDomain({
    localActiveAlarmIncidentMap: runtimeMap,
    offlineTransientAlarmTtlMs: 300000,
    alarmIncidentAutoExpireMs: 1800000,
  });

  domain.setLocalActiveAlarmIncident(
    "receiver",
    "incident-1",
    { targetKey: "target", status: "active" },
  );

  assert.equal(
    domain.hasLocalActiveAlarmIncidentForReceiver("receiver"),
    true,
  );
  assert.equal(runtimeMap.size, 1);

  domain.removeLocalActiveAlarmIncident("receiver", "target");

  assert.equal(
    domain.hasLocalActiveAlarmIncidentForReceiver("receiver"),
    false,
  );
  assert.equal(runtimeMap.size, 0);
});

test("incident item normalization rejects invalid entries and preserves distinct sensors", () => {
  const result = normalizeAlarmIncidentItems([
    item(),
    item(),
    item({ deviceId: "door-2" }),
    item({ homeId: "" }),
    item({ reason: "" }),
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].repeatMinutes, 15);
  assert.equal(result[0].notificationEnabled, true);
  assert.equal(result[1].deviceId, "door-2");
});

test("security condition precedence keeps the strongest and newest policy", () => {
  const result = normalizePreferredSecurityIncidentItems([
    item({
      alarmSource: "personal_schedule",
      notificationEnabled: true,
    }),
    item({
      alarmSource: "security_mode",
      notificationEnabled: false,
      fullscreenEnabled: false,
    }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].alarmSource, "security_mode");
  assert.equal(result[0].notificationEnabled, false);
  assert.equal(result[0].fullscreenEnabled, false);
});

test("delivery filtering keeps only conditions that remain active", () => {
  const openDoor = item();
  const unlocked = item({
    deviceId: "lock-1",
    type: "door_lock",
    reason: "Khóa cửa: Khóa đang mở",
  });

  const result = filterCurrentSecurityAlarmDeliveryItems(
    [openDoor],
    [openDoor, unlocked],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].deviceId, "door-1");
});

test("flow, emergency title and summary lines remain stable", () => {
  const smoke = item({
    deviceId: "smoke-1",
    type: "smoke",
    reason: "Phát hiện khói",
  });

  assert.equal(getAlarmIncidentFlowType([item()]), "security");
  assert.equal(getAlarmIncidentFlowType([item(), smoke]), "emergency");
  assert.equal(getEmergencyIncidentTitle([smoke]), "🔥 CẢNH BÁO KHÓI / CHÁY");
  assert.deepEqual(
    getAlarmIncidentLines([smoke]),
    ["Nhà chính: Phát hiện khói"],
  );
});

test("runtime preferences and change detection use normalized incident data", () => {
  const enabled = item();
  const disabled = item({
    deviceId: "door-2",
    notificationEnabled: false,
    fullscreenEnabled: false,
    physicalSirenEnabled: false,
  });

  assert.deepEqual(
    getAlarmIncidentRuntimePreferences([disabled]),
    {
      notificationEnabled: false,
      fullscreenEnabled: false,
      physicalSirenEnabled: false,
    },
  );
  assert.equal(
    haveAlarmIncidentItemsChanged([enabled], [enabled]),
    false,
  );
  assert.equal(
    haveAlarmIncidentItemsChanged([enabled], [disabled]),
    true,
  );
});

test("expiry, stage rank, device classes and physical siren policy remain safe", () => {
  const domain = createAlarmIncidentDomain({
    offlineTransientAlarmTtlMs: 300000,
    alarmIncidentAutoExpireMs: 1800000,
  });

  assert.equal(
    domain.getAlarmIncidentExpireDelayMs(
      "emergency",
      [item({ type: "sos" })],
    ),
    300000,
  );
  assert.equal(
    domain.getAlarmIncidentExpireDelayMs(
      "emergency",
      [item({ type: "smoke" })],
    ),
    1800000,
  );
  assert.equal(isPersistentEmergencyIncidentItem(item({ type: "smoke" })), true);
  assert.equal(isPersistentEmergencyIncidentItem(item({ type: "sos" })), false);
  assert.equal(getSecurityIncidentStageRank("siren"), 2);
  assert.equal(isSecurityDeviceType("door_lock"), true);
  assert.equal(isEmergencyDeviceType("carbon_monoxide"), true);
  assert.equal(
    incidentRequiresPhysicalSiren({
      status: "active",
      flowType: "security",
      stage: "siren",
      physicalSirenEnabled: true,
    }),
    true,
  );
  assert.equal(
    incidentRequiresPhysicalSiren({
      status: "active",
      flowType: "emergency",
      stage: "fullscreen_siren",
      physicalSirenEnabled: false,
    }),
    false,
  );
});
