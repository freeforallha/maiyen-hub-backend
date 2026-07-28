"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const {
  atomicWriteJson,
  buildUpdateRequestEnvelope,
  createHubUpdateBridge,
  normalizeHomeUpdateRequest,
  readJsonIfExists,
} = require("../hub_update_bridge");
const {
  canonicalizeReleaseManifest,
} = require("../hub_update_contract");

function manifest() {
  return {
    schemaVersion: 1,
    releaseId: "maiyen-hub-1.2.1",
    backendVersion: "1.2.1",
    hubFirmwareVersion: "1.1.1",
    protocolVersion: "1.0.0",
    minBackendVersion: "1.2.0",
    packageUrl: "https://storage.googleapis.com/example/update.zip",
    packageSha256: "b".repeat(64),
    publishedAt: 1784900000000,
    critical: false,
    notes: { vi: "Cập nhật" },
  };
}

test("home update request accepts only fresh owner-confirmation shape", () => {
  assert.deepEqual(
    normalizeHomeUpdateRequest({
      releaseId: "maiyen-hub-1.2.1",
      requestedBy: "owner-uid",
      requestedAt: 1784900000000,
      status: "requested",
    }),
    {
      releaseId: "maiyen-hub-1.2.1",
      requestedBy: "owner-uid",
      requestedAt: 1784900000000,
      status: "requested",
    },
  );
  assert.equal(normalizeHomeUpdateRequest({ releaseId: "../bad" }), null);
  assert.equal(
    normalizeHomeUpdateRequest({
      releaseId: "ok",
      requestedBy: "owner",
      requestedAt: 1,
      status: "queued",
    }),
    null,
  );
});

test("bridge creates a deterministic local root-agent envelope", () => {
  const envelope = buildUpdateRequestEnvelope({
    hubId: "dev_1234",
    ownerUid: "owner-uid",
    homeId: "home-1",
    request: {
      releaseId: "maiyen-hub-1.2.1",
      requestedBy: "owner-uid",
      requestedAt: 1784900000000,
      status: "requested",
    },
    manifest: manifest(),
    signature: "signature",
  });

  assert.equal(envelope.hubId, "dev_1234");
  assert.equal(envelope.ownerUid, "owner-uid");
  assert.equal(envelope.manifest.releaseId, "maiyen-hub-1.2.1");
  assert.equal(envelope.signature, "signature");
});

test("bridge writes request/result JSON atomically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maiyen-bridge-"));
  const filePath = path.join(tempDir, "inbox", "request.json");
  atomicWriteJson(filePath, { status: "queued" });
  assert.deepEqual(readJsonIfExists(filePath), { status: "queued" });
  assert.equal(readJsonIfExists(path.join(tempDir, "missing.json")), null);
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)),
    ["request.json"],
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});


test("bridge reports every verified release check to the optional callback", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "maiyen-bridge-release-"),
  );
  const publicKeyPath = path.join(tempDir, "public.pem");
  const inboxFile = path.join(tempDir, "inbox", "request.json");
  const resultFile = path.join(tempDir, "outbox", "result.json");
  const releaseManifest = manifest();

  const {
    privateKey,
    publicKey,
  } = crypto.generateKeyPairSync("ed25519");

  fs.writeFileSync(
    publicKeyPath,
    publicKey.export({
      type: "spki",
      format: "pem",
    }),
  );

  const signature = crypto.sign(
    null,
    Buffer.from(
      canonicalizeReleaseManifest(releaseManifest),
      "utf8",
    ),
    privateKey,
  ).toString("base64");

  const values = new Map([
    [
      "system/hubReleases/latest",
      {
        manifest: releaseManifest,
        signature,
      },
    ],
  ]);

  const db = {
    ref(refPath) {
      return {
        async once() {
          return {
            val() {
              return values.get(refPath) ?? null;
            },
          };
        },
        async set(value) {
          values.set(refPath, value);
        },
        async update(patch) {
          values.set(refPath, {
            ...(values.get(refPath) || {}),
            ...patch,
          });
        },
      };
    },
  };

  const checks = [];

  const bridge = createHubUpdateBridge({
    db,
    deviceId: "dev_1234",
    currentVersions: {
      backendVersion: "1.2.0",
      hubFirmwareVersion: "1.1.0",
      protocolVersion: "1.0.0",
    },
    getLinkedHomes: async () => [],
    onReleaseChecked: async (value) => {
      checks.push(value);
    },
    publicKeyPath,
    inboxFile,
    resultFile,
  });

  await bridge.poll();

  assert.equal(checks.length, 1);
  assert.equal(checks[0].updateAvailable, true);
  assert.equal(
    checks[0].manifest.releaseId,
    releaseManifest.releaseId,
  );

  fs.rmSync(tempDir, {
    recursive: true,
    force: true,
  });
});
