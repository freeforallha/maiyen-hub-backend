"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const updaterPath = fs.existsSync(
  path.join(ROOT, "scripts/apply_hub_update.next.js"),
)
  ? "scripts/apply_hub_update.next.js"
  : "scripts/apply_hub_update.js";

test("updater uses only canonical MaiYen Linux identity", () => {
  const source = read(updaterPath);
  assert.match(source, /\/home\/pi\/maiyen_hub_backend/);
  assert.match(source, /\/opt\/maiyen-hub-backend/);
  assert.match(source, /maiyen-hub-backend\.service/);
  assert.match(source, /MAIYEN_BACKEND_SERVICE/);
  assert.doesNotMatch(source, /safehome-node|safehome_nodejs|SAFEHOME_SOURCE_DIR|SAFEHOME_RUNTIME_DIR/);
});

test("deploy and installer use canonical MaiYen targets", () => {
  const deploy = read("scripts/deploy_backend_production.sh");
  const installer = read("scripts/install_maiyen_hub_updater.sh");
  for (const source of [deploy, installer]) {
    assert.match(source, /maiyen-hub-backend\.service/);
    assert.match(source, /\/opt\/maiyen-hub-backend/);
    assert.doesNotMatch(source, /safehome-node|safehome_nodejs|SAFEHOME_SOURCE_DIR|SAFEHOME_RUNTIME_DIR/);
  }
});

test("diagnostic uses canonical MaiYen paths and service", () => {
  const source = read("general_id.js");
  assert.match(source, /\/home\/pi\/maiyen_hub_backend/);
  assert.match(source, /\/opt\/maiyen-hub-backend/);
  assert.match(source, /maiyen-hub-backend\.service/);
  assert.doesNotMatch(source, /safehome-node|safehome_nodejs/);
});

test("backend unit no longer conflicts with retired service", () => {
  const source = read("systemd/maiyen-hub-backend.service");
  assert.doesNotMatch(source, /Conflicts=/);
});
