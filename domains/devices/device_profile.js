"use strict";

// Pure device normalization and classification helpers.
// This module has no Firebase, MQTT or timer side effects.

function includesAny(text, keywords) {
  return keywords.some((keyword) => {
    return text.includes(keyword);
  });
}

function isActiveSignal(value) {
  if (value === true || value === 1) {
    return true;
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "on" ||
    normalized === "active" ||
    normalized === "alarm" ||
    normalized === "detected" ||
    normalized === "triggered" ||
    normalized === "emergency" ||
    normalized === "unsafe" ||
    normalized === "open" ||
    normalized === "unlocked"
  );
}

function normalizeDeviceAction(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isVibrationAction(value) {
  const action = normalizeDeviceAction(value);

  return (
    action === "vibration" ||
    action === "shock" ||
    action === "tilt" ||
    action === "drop" ||
    action === "vibrate" ||
    action === "vibration_detected"
  );
}

function isGlassBreakAction(value) {
  const action = normalizeDeviceAction(value);

  return (
    action === "glass_break" ||
    action === "glass_broken" ||
    action === "broken_glass"
  );
}

function normalizeLockState(device) {
  const raw =
    device?.lock_state ??
    device?.lockState ??
    device?.lock ??
    device?.state;

  if (raw === true || raw === 1) {
    return "locked";
  }

  if (raw === false || raw === 0) {
    return "unlocked";
  }

  const normalized = String(raw || "")
    .trim()
    .toLowerCase();

  if (
    normalized === "lock" ||
    normalized === "locked" ||
    normalized === "closed"
  ) {
    return "locked";
  }

  if (
    normalized === "unlock" ||
    normalized === "unlocked" ||
    normalized === "open"
  ) {
    return "unlocked";
  }

  return "";
}

function inferDeviceTypeFromPayload(
  data,
  currentType = "unknown",
) {
  const normalizedCurrentType = String(
    currentType || "unknown",
  ).trim();

  if (
    normalizedCurrentType &&
    normalizedCurrentType !== "unknown"
  ) {
    return normalizedCurrentType;
  }

  if (data.smoke !== undefined) {
    return "smoke";
  }

  if (
    data.carbon_monoxide !== undefined ||
    data.co_alarm !== undefined ||
    data.co !== undefined
  ) {
    return "carbon_monoxide";
  }

  if (
    data.alarm !== undefined &&
    (
      data.melody !== undefined ||
      data.duration !== undefined ||
      data.volume !== undefined ||
      data.battpercentage !== undefined
    )
  ) {
    return "siren";
  }

  if (
    data.gas !== undefined ||
    data.gas_alarm !== undefined
  ) {
    return "gas";
  }

  if (
    data.water_leak !== undefined ||
    data.leak !== undefined ||
    data.water !== undefined
  ) {
    return "water_leak";
  }

  if (
    data.heat !== undefined ||
    data.heat_alarm !== undefined ||
    data.high_temperature_alarm !== undefined
  ) {
    return "heat";
  }

  if (
    data.occupancy !== undefined ||
    data.motion !== undefined
  ) {
    return "motion";
  }

  if (data.presence !== undefined) {
    return "presence";
  }

  if (
    data.vibration !== undefined ||
    data.vibration_strength !== undefined ||
    data.sensitivity !== undefined
  ) {
    return "vibration";
  }

  if (data.contact !== undefined) {
    return "door";
  }

  if (
    data.power !== undefined ||
    data.current !== undefined ||
    data.voltage !== undefined ||
    data.energy !== undefined
  ) {
    return "smart_plug";
  }

  if (
    data.temperature !== undefined ||
    data.humidity !== undefined
  ) {
    return "temperature";
  }

  return "unknown";
}

function getDeviceTypeFromModel(modelId, description, ieee) {
  const id = String(ieee || "").trim().toLowerCase();
  const model = String(modelId || "").trim().toLowerCase();
  const desc = String(description || "").trim().toLowerCase();
  const searchable = `${model} ${desc}`;

  // Các thiết bị đang dùng thực tế.
  if (id === "0xa4c1388295d25926") return "smoke";
  if (id === "0xa4c138b872c891a2") return "temperature";
  if (id === "0xa4c1381162d4d15b") return "sos";
  if (id === "0xa4c13898b084dbdc") return "repeater";

  // Bốn thiết bị mới đang dùng thực tế. Giữ nhận diện theo cả IEEE
  // và model để pair lại vẫn đúng nếu người dùng đổi tên friendly_name.
  if (
    id === "0xa4c138ea6ee11777" ||
    model === "dcr-co"
  ) {
    return "carbon_monoxide";
  }

  if (
    id === "0xa4c13839bfd34161" ||
    model === "809wzt"
  ) {
    return "motion";
  }

  if (
    id === "0xa4c138f00d9289fc" ||
    model === "ts0210"
  ) {
    return "vibration";
  }

  if (
    id === "0xa4c1382b53b62852" ||
    model === "nas-ab02b2"
  ) {
    return "siren";
  }

  // Loại cụ thể phải được kiểm tra trước loại chung.
  if (
    includesAny(searchable, [
      "smart lock",
      "door lock",
      "deadbolt",
      "keyless lock",
      "electronic lock",
    ])
  ) {
    return "door_lock";
  }

  if (
    includesAny(searchable, [
      "glass break",
      "glassbreak",
      "broken glass",
    ])
  ) {
    return "glass_break";
  }

  if (
    includesAny(searchable, [
      "carbon monoxide",
      "carbon-monoxide",
      "co alarm",
      "co sensor",
    ]) &&
    !searchable.includes("co2")
  ) {
    return "carbon_monoxide";
  }

  if (
    includesAny(searchable, [
      "water leak",
      "water leakage",
      "leak sensor",
      "flood sensor",
      "water sensor",
    ])
  ) {
    return "water_leak";
  }

  if (
    includesAny(searchable, [
      "combustible gas",
      "natural gas",
      "gas detector",
      "gas sensor",
      "methane",
      "lpg",
    ])
  ) {
    return "gas";
  }

  if (
    includesAny(searchable, [
      "heat detector",
      "heat alarm",
      "temperature alarm",
    ])
  ) {
    return "heat";
  }

  if (
    includesAny(searchable, [
      "smoke",
      "fire detector",
      "fire alarm",
    ]) ||
    model.includes("ts0205")
  ) {
    return "smoke";
  }

  if (
    includesAny(searchable, [
      "presence sensor",
      "human presence",
      "mmwave",
      "radar presence",
    ])
  ) {
    return "presence";
  }

  if (
    includesAny(searchable, [
      "motion sensor",
      "pir sensor",
      "occupancy sensor",
      "motion detector",
    ]) ||
    model.includes("snzb-03") ||
    model.includes("ts0202")
  ) {
    return "motion";
  }

  if (
    includesAny(searchable, [
      "vibration",
      "shock sensor",
      "tilt sensor",
    ]) ||
    model.includes("djt11lm")
  ) {
    return "vibration";
  }

  if (
    includesAny(searchable, [
      "door contact",
      "window contact",
      "contact sensor",
      "door sensor",
      "window sensor",
      "open close sensor",
    ]) ||
    model.includes("snzb-04") ||
    model.includes("ts0203")
  ) {
    if (desc.includes("window")) return "window";
    return "door";
  }

  if (
    includesAny(searchable, [
      "panic button",
      "sos",
      "emergency button",
    ])
  ) {
    return "sos";
  }

  if (
    includesAny(searchable, [
      "smart plug",
      "smart socket",
      "wall plug",
      "power outlet",
      "socket outlet",
    ]) ||
    model.includes("ts011f")
  ) {
    return "smart_plug";
  }

  if (
    includesAny(searchable, [
      "power monitor",
      "energy monitor",
      "clamp meter",
    ])
  ) {
    return "power_monitor";
  }

  if (includesAny(searchable, ["ups", "backup power"])) {
    return "ups";
  }

  if (
    includesAny(searchable, [
      "siren",
      "alarm bell",
      "warning horn",
    ])
  ) {
    return "siren";
  }

  if (
    includesAny(searchable, [
      "water valve",
      "gas valve",
      "valve controller",
      "smart valve",
    ])
  ) {
    return "smart_valve";
  }

  if (includesAny(searchable, ["doorbell", "video bell"])) {
    return "doorbell";
  }

  if (includesAny(searchable, ["camera", "ip cam"])) {
    return "camera";
  }

  if (includesAny(searchable, ["keypad", "key fob"])) {
    return "keypad";
  }

  if (
    includesAny(searchable, [
      "temperature",
      "humidity",
      "thermometer",
      "hygrometer",
    ])
  ) {
    return "temperature";
  }

  if (
    includesAny(searchable, [
      "repeater",
      "range extender",
      "signal extender",
    ])
  ) {
    return "repeater";
  }

  // Không mặc định thành cửa để tránh một thiết bị lạ
  // vô tình tạo Alarm sai.
  return "unknown";
}

module.exports = {
  isActiveSignal,
  isVibrationAction,
  isGlassBreakAction,
  normalizeLockState,
  inferDeviceTypeFromPayload,
  getDeviceTypeFromModel,
};
