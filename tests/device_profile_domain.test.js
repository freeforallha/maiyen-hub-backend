"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isActiveSignal,
  isVibrationAction,
  isGlassBreakAction,
  normalizeLockState,
  inferDeviceTypeFromPayload,
  getDeviceTypeFromModel,
} = require("../domains/devices/device_profile");

test("active signal and action helpers normalize common Zigbee values", () => {
  assert.equal(isActiveSignal(true), true);
  assert.equal(isActiveSignal("triggered"), true);
  assert.equal(isActiveSignal("unlocked"), true);
  assert.equal(isActiveSignal("off"), false);

  assert.equal(isVibrationAction("VIBRATION_DETECTED"), true);
  assert.equal(isVibrationAction("drop"), true);
  assert.equal(isVibrationAction("single"), false);

  assert.equal(isGlassBreakAction("glass_broken"), true);
  assert.equal(isGlassBreakAction("broken_glass"), true);
  assert.equal(isGlassBreakAction("vibration"), false);
});

test("lock state normalization supports boolean and textual payloads", () => {
  assert.equal(normalizeLockState({ lock_state: true }), "locked");
  assert.equal(normalizeLockState({ lockState: "closed" }), "locked");
  assert.equal(normalizeLockState({ lock: false }), "unlocked");
  assert.equal(normalizeLockState({ state: "OPEN" }), "unlocked");
  assert.equal(normalizeLockState({ state: "jammed" }), "");
});

test("payload inference preserves known types and uses safe precedence", () => {
  assert.equal(
    inferDeviceTypeFromPayload({ smoke: true }, "door"),
    "door",
  );
  assert.equal(
    inferDeviceTypeFromPayload({ carbon_monoxide: 45 }),
    "carbon_monoxide",
  );
  assert.equal(
    inferDeviceTypeFromPayload({
      alarm: true,
      melody: 3,
      duration: 60,
    }),
    "siren",
  );
  assert.equal(
    inferDeviceTypeFromPayload({ occupancy: true }),
    "motion",
  );
  assert.equal(
    inferDeviceTypeFromPayload({ contact: false }),
    "door",
  );
  assert.equal(
    inferDeviceTypeFromPayload({ arbitrary: true }),
    "unknown",
  );
});

test("model classification keeps deployed IDs and avoids unsafe defaults", () => {
  assert.equal(
    getDeviceTypeFromModel("", "", "0xa4c1388295d25926"),
    "smoke",
  );
  assert.equal(
    getDeviceTypeFromModel("DCR-CO", "", ""),
    "carbon_monoxide",
  );
  assert.equal(
    getDeviceTypeFromModel("NAS-AB02B2", "", ""),
    "siren",
  );
  assert.equal(
    getDeviceTypeFromModel("", "Human presence mmWave sensor", ""),
    "presence",
  );
  assert.equal(
    getDeviceTypeFromModel("", "Window contact sensor", ""),
    "window",
  );
  assert.equal(
    getDeviceTypeFromModel("", "CO2 air quality monitor", ""),
    "unknown",
  );
  assert.equal(
    getDeviceTypeFromModel("", "Unrecognized Zigbee device", ""),
    "unknown",
  );
});
