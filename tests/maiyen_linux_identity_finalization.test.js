"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("Phase 8C finalizer is guarded and removes only retired Linux aliases", () => {
  const source = read("scripts/finalize_phase8c_linux_identity.sh");
  assert.match(source, /1\.2\.4/);
  assert.match(source, /maiyen-hub-backend\.service/);
  assert.match(source, /maiyen-hub-update\.path/);
  assert.match(source, /safehome-node\.service/);
  assert.match(source, /\/home\/pi\/safehome_nodejs/);
  assert.match(source, /\/opt\/safehome-node/);
  assert.match(source, /groupdel safehome/);
  assert.match(source, /PHASE 8C LINUX IDENTITY ĐÃ HOÀN TẤT/);
});

test("transition deploy replaces the privileged updater safely", () => {
  const source = read("scripts/deploy_backend_production.sh");
  assert.match(source, /apply_hub_update\.next\.js/);
  assert.match(source, /INSTALLED_UPDATER/);
  assert.match(source, /rollback_on_error/);
  assert.match(source, /systemctl daemon-reload/);
});
