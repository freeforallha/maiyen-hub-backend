"use strict";

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");

function getPiSerial() {
  try {
    const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const match = cpuInfo.match(/Serial\s*:\s*(.+)/);

    if (match && match[1]) {
      return match[1].trim();
    }

    return "unknown_serial";
  } catch (error) {
    return "unknown_serial";
  }
}

function readHubModel() {
  const modelFiles = [
    "/proc/device-tree/model",
    "/sys/firmware/devicetree/base/model",
  ];

  for (const modelFile of modelFiles) {
    try {
      const value = fs
        .readFileSync(modelFile, "utf8")
        .replace(/\0/g, "")
        .trim();

      if (value) {
        return value;
      }
    } catch (_) {
      // Thử đường dẫn tiếp theo.
    }
  }

  return "Raspberry Pi";
}

function tryExecText(command, args = []) {
  try {
    return String(
      execFileSync(command, args, {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }) || "",
    ).trim();
  } catch (_) {
    return "";
  }
}

function readConnectedWifiInfo() {
  const iwgetidCandidates = [
    "/usr/sbin/iwgetid",
    "/sbin/iwgetid",
    "iwgetid",
  ];

  for (const command of iwgetidCandidates) {
    const ssid = tryExecText(command, ["-r"]);

    if (ssid) {
      return {
        connected: true,
        ssid,
        interfaceName: "wlan0",
      };
    }
  }

  const nmcliOutput = tryExecText(
    "/usr/bin/nmcli",
    ["-t", "-f", "ACTIVE,SSID,DEVICE", "dev", "wifi"],
  );

  if (nmcliOutput) {
    const activeLine = nmcliOutput
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("yes:"));

    if (activeLine) {
      const parts = activeLine.split(":");
      const ssid = String(parts[1] || "")
        .replace(/\\:/g, ":")
        .trim();
      const interfaceName = String(parts[2] || "wlan0").trim();

      return {
        connected: true,
        ssid,
        interfaceName,
      };
    }
  }

  let interfaceUp = false;

  try {
    interfaceUp = fs
      .readFileSync("/sys/class/net/wlan0/operstate", "utf8")
      .trim() === "up";
  } catch (_) {
    interfaceUp = false;
  }

  return {
    connected: interfaceUp,
    ssid: "",
    interfaceName: "wlan0",
  };
}

function createHubIdentity({ env = process.env } = {}) {
  const rawId = getPiSerial();
  const deviceId =
    "dev_" +
    crypto.createHash("sha256").update(rawId).digest("hex").slice(0, 16);
  const hubName =
    String(
      env.MAIYEN_HUB_NAME ||
        env.SAFEHOME_HUB_NAME ||
        os.hostname() ||
        "MaiYen Hub",
    ).trim() || "MaiYen Hub";

  return {
    deviceId,
    hubName,
    hubModel: readHubModel(),
    readConnectedWifiInfo,
  };
}

module.exports = {
  createHubIdentity,
  getPiSerial,
  readConnectedWifiInfo,
  readHubModel,
};
