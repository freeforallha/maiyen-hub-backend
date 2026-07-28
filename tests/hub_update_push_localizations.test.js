"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HUB_UPDATE_PUSH_TEXTS,
  getHubUpdatePushText,
  normalizeHubUpdateLanguageCode,
} = require("../hub_update_push_localizations");

test("Hub update push localization covers all 53 App locales", () => {
  assert.equal(
    Object.keys(HUB_UPDATE_PUSH_TEXTS).length,
    53,
  );

  for (const [languageCode, values] of Object.entries(
    HUB_UPDATE_PUSH_TEXTS,
  )) {
    assert.equal(values.length, 3, languageCode);

    for (const value of values) {
      assert.equal(
        typeof value,
        "string",
        languageCode,
      );
      assert.notEqual(value.trim(), "", languageCode);
    }
  }
});

test("regional locale falls back to its supported base language", () => {
  assert.equal(
    normalizeHubUpdateLanguageCode("en-US"),
    "en",
  );
  assert.equal(
    normalizeHubUpdateLanguageCode("pt_BR"),
    "pt",
  );
  assert.equal(
    normalizeHubUpdateLanguageCode("unknown"),
    "vi",
  );
});

test("localized push text formats normal and critical releases", () => {
  assert.deepEqual(
    getHubUpdatePushText({
      languageCode: "en",
      releaseId: "v1.2.6",
      homeName: "Main home",
    }),
    {
      languageCode: "en",
      title: "Version v1.2.6 is ready.",
      body: "Main home",
    },
  );

  assert.deepEqual(
    getHubUpdatePushText({
      languageCode: "vi",
      releaseId: "v1.2.6",
      critical: true,
    }),
    {
      languageCode: "vi",
      title: "Bản cập nhật quan trọng: v1.2.6",
      body: "Cập nhật Hub",
    },
  );
});
