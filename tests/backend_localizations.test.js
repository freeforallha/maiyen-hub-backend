"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SUPPORTED_LANGUAGE_CODES,
  normalizeLanguageCode,
  translate,
  localizeBackendText,
  localizeAlarmItemsJson,
  getBackendLocalizationDiagnostics,
} = require("../backend_localizations");

const EXPECTED_LANGUAGE_CODES = [
  "vi", "en", "zh", "ko", "ja", "de", "ru", "fr", "es", "id",
  "th", "ms", "fil", "km", "my", "lo", "ta", "pt", "tet", "it",
  "pl", "nl", "cs", "sk", "uk", "ro", "hu", "bg", "hr", "sr",
  "bs", "sl", "mk", "sq", "el", "tr", "sv", "da", "nb", "fi",
  "is", "et", "lv", "lt", "ga", "mt", "be", "lb", "ca", "cnr",
  "hy", "ka", "az",
];

test("backend localization có đúng 53 locale MaiYen", () => {
  assert.deepEqual(
    [...SUPPORTED_LANGUAGE_CODES],
    EXPECTED_LANGUAGE_CODES,
  );
});

test("mọi locale có đủ cùng bộ key và không có giá trị rỗng", () => {
  const diagnostics = getBackendLocalizationDiagnostics();

  assert.equal(diagnostics.languageCount, 53);
  assert.ok(diagnostics.baseKeyCount >= 1000);

  for (const code of diagnostics.languageCodes) {
    const locale = diagnostics.locales[code];
    assert.equal(
      locale.keyCount,
      diagnostics.baseKeyCount,
      `${code} lệch số key`,
    );
    assert.deepEqual(locale.missingKeys, [], `${code} thiếu key`);
    assert.deepEqual(locale.extraKeys, [], `${code} thừa key`);
    assert.deepEqual(locale.emptyKeys, [], `${code} có bản dịch rỗng`);
  }
});



test("backend localization hiển thị thương hiệu MaiYen", () => {
  assert.equal(
    localizeBackendText("vi", "Nhắc nhở MaiYen"),
    "Nhắc nhở MaiYen",
  );
  assert.equal(
    localizeBackendText("en", "Nhắc nhở MaiYen"),
    "MaiYen Reminder",
  );
  assert.equal(
    localizeBackendText("en", "Mở MaiYen để kiểm tra ngay."),
    "Open MaiYen to check now.",
  );
});

test("key Bật không fallback về tiếng Việt ở locale khác", () => {
  for (const code of EXPECTED_LANGUAGE_CODES) {
    if (code === "vi") continue;
    assert.notEqual(translate(code, "Bật"), "Bật", code);
  }
});

test("normalize locale chấp nhận region và fallback an toàn", () => {
  assert.equal(normalizeLanguageCode("en-US"), "en");
  assert.equal(normalizeLanguageCode("pt_BR"), "pt");
  assert.equal(normalizeLanguageCode("zh-Hans"), "zh");
  assert.equal(normalizeLanguageCode("unknown"), "vi");
});

test("backend text và alarmItems được localize nhưng tên thiết bị giữ nguyên", () => {
  assert.equal(
    localizeBackendText("en", "Cửa chính: Đang mở"),
    "Cửa chính: Open",
  );

  const localized = JSON.parse(
    localizeAlarmItemsJson(
      "en",
      JSON.stringify([
        {
          deviceName: "Cửa chính",
          reason: "Cửa chính: Đang mở",
        },
      ]),
    ),
  );

  assert.equal(localized[0].deviceName, "Cửa chính");
  assert.equal(localized[0].reason, "Cửa chính: Open");
});
