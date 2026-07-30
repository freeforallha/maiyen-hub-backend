"use strict";

function createHubHeartbeat({
  db,
  deviceId,
  hubName,
  hubModel,
  startedAt,
  intervalMs,
  readConnectedWifiInfo,
  getMqttConnected,
  getSystemVersionHeartbeatFields,
  getHubUpdateHeartbeatFields,
  processId,
  log = console.log,
}) {
  if (!db || !deviceId) {
    throw new Error("hub_heartbeat_missing_dependencies");
  }

  let timer = null;
  let writeInProgress = false;
  let writeCount = 0;

  async function getHomesLinkedToThisHub() {
    const snap = await db.ref("system/devices_by_ieee").once("value");
    const index = snap.val() || {};
    const homes = new Map();

    for (const value of Object.values(index)) {
      const item = value || {};
      const itemHubId = String(item.deviceId || "").trim();

      if (itemHubId !== deviceId) {
        continue;
      }

      const uid = String(item.uid || "").trim();
      const homeId = String(item.homeId || "").trim();

      if (!uid || !homeId) {
        continue;
      }

      homes.set(`${uid}|${homeId}`, { uid, homeId });
    }

    return [...homes.values()];
  }

  async function writeHubHeartbeat() {
    if (writeInProgress) {
      return;
    }

    writeInProgress = true;

    try {
      const linkedHomes = await getHomesLinkedToThisHub();
      const now = Date.now();
      const wifiInfo = readConnectedWifiInfo();
      const mqttConnected = getMqttConnected() === true;
      const heartbeat = {
        hubId: deviceId,
        hubName,
        hubType: "raspberry_pi",
        hubModel,
        status: "online",
        mqttConnected,
        wifiConnected: wifiInfo.connected,
        wifiSsid: wifiInfo.ssid,
        wifiInterface: wifiInfo.interfaceName,
        backendPid: processId,
        startedAt,
        lastHeartbeatAt: now,
        heartbeatIntervalMs: intervalMs,
        ...getSystemVersionHeartbeatFields(),
        ...getHubUpdateHeartbeatFields(),
      };
      const updates = {
        [`system/hubs/${deviceId}`]: heartbeat,
      };

      for (const item of linkedHomes) {
        const basePath = `accounts/${item.uid}/homes/${item.homeId}`;
        updates[`${basePath}/hubId`] = deviceId;
        updates[`${basePath}/hubStatus`] = heartbeat;
      }

      await db.ref().update(updates);
      writeCount++;

      if (writeCount === 1 || writeCount % 10 === 0) {
        log(
          "💓 HUB HEARTBEAT:",
          deviceId,
          `homes=${linkedHomes.length}`,
          `mqtt=${mqttConnected}`,
        );
      }
    } catch (error) {
      log("HUB HEARTBEAT ERROR:", error.message);
    } finally {
      writeInProgress = false;
    }
  }

  function startHubHeartbeat() {
    if (timer) {
      return;
    }

    void writeHubHeartbeat();
    timer = setInterval(() => {
      void writeHubHeartbeat();
    }, intervalMs);

    log(
      "💓 HUB HEARTBEAT STARTED:",
      deviceId,
      `interval=${intervalMs / 1000}s`,
    );
  }

  function stopHubHeartbeat() {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = null;
  }

  return {
    getHomesLinkedToThisHub,
    startHubHeartbeat,
    stopHubHeartbeat,
    writeHubHeartbeat,
  };
}

module.exports = { createHubHeartbeat };
