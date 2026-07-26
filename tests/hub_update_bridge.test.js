"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  atomicWriteJson,
  buildUpdateRequestEnvelope,
  normalizeHomeUpdateRequest,
  readJsonIfExists,
} = require("../hub_update_bridge");

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
