"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

for (const filename of ["server.js", "migrate_structure.js"]) {
  test(`${filename} bị vô hiệu và không chạy Firebase/MQTT`, () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, filename)], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /đã ngừng sử dụng/);
    assert.doesNotMatch(result.stdout + result.stderr, /MQTT connected/);
  });
}

test("firebase.js không khởi tạo Firebase app thứ hai khi được require", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "require('./firebase.js'); console.log('loaded')"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5000,
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "loaded");
  assert.equal(result.stderr.trim(), "");
});
