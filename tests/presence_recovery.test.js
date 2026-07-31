"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildPresenceRecoveryMessage,
  createPresenceRecoveryCoordinator,
} = require("../presence_recovery");

function candidate(overrides = {}) {
  return {
    uid: "user-1",
    installationId: "install-1",
    platform: "android",
    signedIn: true,
    lastSeenAt: 1_000,
    ...overrides,
  };
}

test("presence recovery chỉ bắt đầu khi Android session gần stale", () => {
  const coordinator = createPresenceRecoveryCoordinator({
    triggerAgeMs: 100,
    retryCooldownMs: 50,
    graceMs: 60,
    maxAttempts: 2,
  });

  assert.equal(
    coordinator.evaluate(candidate(), 1_099).shouldRequest,
    false,
  );
  assert.equal(
    coordinator.evaluate(candidate(), 1_100).shouldRequest,
    true,
  );
  assert.equal(
    coordinator.evaluate(
      candidate({ platform: "ios" }),
      1_100,
    ).eligible,
    false,
  );
});

test("push thành công tạo grace và chỉ thử tối đa hai lần", () => {
  const coordinator = createPresenceRecoveryCoordinator({
    triggerAgeMs: 100,
    retryCooldownMs: 50,
    graceMs: 60,
    maxAttempts: 2,
  });

  const first = coordinator.evaluate(candidate(), 1_100);
  coordinator.recordAttempt(first, { sent: 1 }, 1_100);

  assert.equal(
    coordinator.evaluate(candidate(), 1_130).graceActive,
    true,
  );
  assert.equal(
    coordinator.evaluate(candidate(), 1_149).shouldRequest,
    false,
  );

  const second = coordinator.evaluate(candidate(), 1_150);
  assert.equal(second.attemptNumber, 2);
  coordinator.recordAttempt(second, { sent: 1 }, 1_150);

  const afterSecond = coordinator.evaluate(candidate(), 1_151);
  assert.equal(afterSecond.shouldRequest, false);
  assert.equal(afterSecond.graceActive, true);

  const expired = coordinator.evaluate(candidate(), 1_211);
  assert.equal(expired.shouldRequest, false);
  assert.equal(expired.graceActive, false);
});

test("heartbeat mới reset toàn bộ retry của stale episode cũ", () => {
  const coordinator = createPresenceRecoveryCoordinator({
    triggerAgeMs: 100,
    retryCooldownMs: 50,
    graceMs: 60,
    maxAttempts: 2,
  });

  const first = coordinator.evaluate(candidate(), 1_100);
  coordinator.recordAttempt(first, { sent: 1 }, 1_100);

  const fresh = candidate({ lastSeenAt: 1_090 });
  assert.equal(coordinator.evaluate(fresh, 1_100).shouldRequest, false);

  const staleAgain = coordinator.evaluate(fresh, 1_190);
  assert.equal(staleAgain.shouldRequest, true);
  assert.equal(staleAgain.attemptNumber, 1);
});

test("push thất bại không tạo grace nhưng vẫn áp dụng cooldown", () => {
  const coordinator = createPresenceRecoveryCoordinator({
    triggerAgeMs: 100,
    retryCooldownMs: 50,
    graceMs: 60,
    maxAttempts: 2,
  });

  const first = coordinator.evaluate(candidate(), 1_100);
  coordinator.recordAttempt(first, { sent: 0 }, 1_100);

  const state = coordinator.evaluate(candidate(), 1_120);
  assert.equal(state.graceActive, false);
  assert.equal(state.shouldRequest, false);
});

test("presence recovery payload là data-only Android high priority", () => {
  const message = buildPresenceRecoveryMessage({
    requestedAt: 12345,
    attemptNumber: 2,
  });

  assert.deepEqual(message.data, {
    type: "presence_recovery",
    trigger: "session_stale_watchdog",
    requestedAt: "12345",
    attemptNumber: "2",
  });
  assert.equal(message.notification, undefined);
  assert.equal(message.android.priority, "high");
  assert.equal(
    message.android.collapseKey,
    "maiyen_presence_recovery",
  );
});

test("manual deploy luôn mang theo mọi module local mà index.js require", () => {
  const root = path.resolve(__dirname, "..");
  const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const deploySource = fs.readFileSync(
    path.join(root, "scripts/deploy_backend_production.sh"),
    "utf8",
  );

  const filesBlock = deploySource.match(/FILES=\(\n([\s\S]*?)\n\)/);
  assert.ok(filesBlock, "Không đọc được FILES trong deploy script");

  const deployedFiles = new Set(
    [...filesBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
  const requiredLocalModules = new Set(
    [...indexSource.matchAll(/require\(["']\.\/([^"']+)["']\)/g)]
      .map((match) => match[1])
      .filter((relativePath) => !relativePath.endsWith(".json"))
      .map((relativePath) =>
        relativePath.endsWith(".js") ? relativePath : `${relativePath}.js`,
      ),
  );

  for (const relativePath of requiredLocalModules) {
    assert.ok(
      deployedFiles.has(relativePath),
      `Deploy script thiếu module runtime: ${relativePath}`,
    );
  }

  assert.ok(deployedFiles.has("presence_recovery.js"));
  assert.match(
    deploySource,
    /for file in "\$\{FILES\[@\]\}"; do[\s\S]*?\*\.js\)[\s\S]*?node --check "\$\{STAGE_DIR\}\/\$\{file\}"/,
  );
});

