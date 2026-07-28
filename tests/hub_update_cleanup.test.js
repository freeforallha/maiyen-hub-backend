"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DAY_MS,
  cleanupUpdaterState,
  parseArguments,
} = require("../scripts/cleanup_maiyen_hub_updater");

function touch(targetPath, mtimeMs) {
  const date = new Date(mtimeMs);
  fs.utimesSync(targetPath, date, date);
}

function writeJson(filePath, value, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  touch(filePath, mtimeMs);
}

function makeDirectory(directoryPath, mtimeMs) {
  fs.mkdirSync(directoryPath, { recursive: true });
  touch(directoryPath, mtimeMs);
}

test("cleanup CLI state root derives all managed state paths", () => {
  const options = parseArguments([
    "node",
    "cleanup",
    "--state-root",
    "/tmp/maiyen-state",
  ]);

  assert.equal(options.workRoot, "/tmp/maiyen-state/work");
  assert.equal(options.archiveRoot, "/tmp/maiyen-state/archive");
  assert.equal(
    options.requestFile,
    "/tmp/maiyen-state/inbox/update-request.json",
  );
  assert.equal(
    options.resultFile,
    "/tmp/maiyen-state/outbox/update-result.json",
  );
});

test("cleanup only rotates canonical OTA backups and preserves special backups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-cleanup-backup-"));
  const backupRoot = path.join(root, "backups");
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);

  try {
    for (let index = 1; index <= 5; index += 1) {
      const name = `2026-07-2${index}T10-00-00-000Z-v1.2.${index}`;
      const backupDir = path.join(backupRoot, name);
      makeDirectory(backupDir, nowMs - index * 1000);
      fs.writeFileSync(path.join(backupDir, "source.tar.gz"), "backup");
      touch(backupDir, nowMs - index * 1000);
    }

    makeDirectory(path.join(backupRoot, "manual-deploy"), nowMs - 50_000);
    makeDirectory(
      path.join(backupRoot, "phase8c-finalize-20260726_223818"),
      nowMs - 60_000,
    );
    makeDirectory(path.join(backupRoot, "unrelated-folder"), nowMs - 70_000);

    cleanupUpdaterState({
      stateRoot: path.join(root, "state"),
      backupRoot,
      nowMs,
      otaBackupKeepCount: 3,
      manualBackupKeepCount: 3,
    });

    const remaining = fs.readdirSync(backupRoot).sort();
    assert.equal(
      remaining.filter((name) => name.startsWith("2026-07-")).length,
      3,
    );
    assert.ok(remaining.includes("manual-deploy"));
    assert.ok(remaining.includes("phase8c-finalize-20260726_223818"));
    assert.ok(remaining.includes("unrelated-folder"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup keeps only the newest manual deploy backups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-cleanup-manual-"));
  const backupRoot = path.join(root, "backups");
  const manualRoot = path.join(backupRoot, "manual-deploy");
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);

  try {
    for (let index = 1; index <= 5; index += 1) {
      makeDirectory(
        path.join(manualRoot, `2026072${index}_120000`),
        nowMs - index * 1000,
      );
    }
    makeDirectory(path.join(manualRoot, "keep-me"), nowMs - 100_000);

    cleanupUpdaterState({
      stateRoot: path.join(root, "state"),
      backupRoot,
      nowMs,
      manualBackupKeepCount: 3,
    });

    const remaining = fs.readdirSync(manualRoot).sort();
    assert.equal(
      remaining.filter((name) => /^\d{8}_\d{6}$/.test(name)).length,
      3,
    );
    assert.ok(remaining.includes("keep-me"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup prunes update archive by age and count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-cleanup-archive-"));
  const stateRoot = path.join(root, "state");
  const archiveRoot = path.join(stateRoot, "archive");
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);

  try {
    for (let index = 0; index < 6; index += 1) {
      writeJson(
        path.join(archiveRoot, `recent-${index}.json`),
        { index },
        nowMs - index * 1000,
      );
    }
    writeJson(
      path.join(archiveRoot, "expired.json"),
      { expired: true },
      nowMs - 31 * DAY_MS,
    );
    fs.writeFileSync(path.join(archiveRoot, "keep.txt"), "keep");

    cleanupUpdaterState({
      stateRoot,
      backupRoot: path.join(root, "backups"),
      nowMs,
      archiveKeepCount: 3,
      archiveMaxAgeMs: 30 * DAY_MS,
    });

    const remaining = fs.readdirSync(archiveRoot).sort();
    assert.equal(remaining.filter((name) => name.endsWith(".json")).length, 3);
    assert.ok(!remaining.includes("expired.json"));
    assert.ok(remaining.includes("keep.txt"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup removes abandoned work and stale outbox, and archives stale inbox", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-cleanup-state-"));
  const stateRoot = path.join(root, "state");
  const workRoot = path.join(stateRoot, "work");
  const archiveRoot = path.join(stateRoot, "archive");
  const requestFile = path.join(stateRoot, "inbox", "update-request.json");
  const resultFile = path.join(stateRoot, "outbox", "update-result.json");
  const oldInboxTemp = path.join(stateRoot, "inbox", "update-request.json.tmp-old");
  const freshOutboxTemp = path.join(stateRoot, "outbox", "update-result.json.tmp-new");
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);

  try {
    makeDirectory(path.join(workRoot, "v1.2.4-old"), nowMs - 25 * 60 * 60 * 1000);
    makeDirectory(path.join(workRoot, "v1.2.6-fresh"), nowMs - 60 * 60 * 1000);
    writeJson(
      requestFile,
      {
        manifest: { releaseId: "v1.2.5" },
        ownerUid: "owner-1",
        homeId: "home-1",
        requestedBy: "owner-1",
        queuedAt: nowMs - 26 * 60 * 60 * 1000,
      },
      nowMs - 25 * 60 * 60 * 1000,
    );
    writeJson(
      resultFile,
      { releaseId: "v1.2.4", status: "success" },
      nowMs - 8 * DAY_MS,
    );
    writeJson(oldInboxTemp, { temp: true }, nowMs - 25 * 60 * 60 * 1000);
    writeJson(freshOutboxTemp, { temp: true }, nowMs - 60 * 60 * 1000);

    const result = cleanupUpdaterState({
      stateRoot,
      backupRoot: path.join(root, "backups"),
      nowMs,
    });

    assert.equal(fs.existsSync(path.join(workRoot, "v1.2.4-old")), false);
    assert.equal(fs.existsSync(path.join(workRoot, "v1.2.6-fresh")), true);
    assert.equal(fs.existsSync(requestFile), false);
    assert.equal(fs.existsSync(resultFile), true);
    const recovery = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(recovery.status, "failed");
    assert.equal(recovery.errorCode, "stale_update_request");
    assert.equal(recovery.ownerUid, "owner-1");
    assert.equal(fs.existsSync(oldInboxTemp), false);
    assert.equal(fs.existsSync(freshOutboxTemp), true);
    assert.equal(result.archivedCount, 1);
    assert.equal(result.recoveryResultCount, 1);
    assert.match(fs.readdirSync(archiveRoot).join("\n"), /v1\.2\.5-stale/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dry run reports cleanup without deleting data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-cleanup-dry-"));
  const stateRoot = path.join(root, "state");
  const oldWork = path.join(stateRoot, "work", "old");
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);

  try {
    makeDirectory(oldWork, nowMs - 2 * DAY_MS);
    const result = cleanupUpdaterState({
      stateRoot,
      backupRoot: path.join(root, "backups"),
      nowMs,
      dryRun: true,
    });

    assert.equal(result.removedCount, 1);
    assert.equal(fs.existsSync(oldWork), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup systemd timer shares the updater lock", () => {
  const root = path.resolve(__dirname, "..");
  const service = fs.readFileSync(
    path.join(root, "systemd/maiyen-hub-updater-cleanup.service"),
    "utf8",
  );
  const timer = fs.readFileSync(
    path.join(root, "systemd/maiyen-hub-updater-cleanup.timer"),
    "utf8",
  );
  const deploy = fs.readFileSync(
    path.join(root, "scripts/deploy_backend_production.sh"),
    "utf8",
  );

  assert.match(service, /maiyen-hub-update\.lock/);
  assert.match(service, /SuccessExitStatus=75/);
  assert.match(service, /ReadWritePaths=\/run\/lock \/var\/lib\/maiyen-updater \/var\/backups\/maiyen-hub/);
  assert.match(timer, /OnUnitActiveSec=24h/);
  assert.match(timer, /Persistent=true/);
  assert.match(deploy, /apply_hub_update\.next\.js/);
  assert.match(deploy, /cleanup_maiyen_hub_updater\.js/);
});
