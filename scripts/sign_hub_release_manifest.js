#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  HUB_UPDATE_SCHEMA_VERSION,
  normalizeReleaseManifest,
  signReleaseManifest,
} = require("../hub_update_contract");

function parseArguments(argv) {
  const options = { critical: false, notesFile: "" };
  const mappings = {
    "--package": "packagePath",
    "--private-key": "privateKeyPath",
    "--release-id": "releaseId",
    "--backend-version": "backendVersion",
    "--firmware-version": "hubFirmwareVersion",
    "--protocol-version": "protocolVersion",
    "--min-backend-version": "minBackendVersion",
    "--url": "packageUrl",
    "--published-at": "publishedAt",
    "--notes": "notesFile",
    "--output": "outputPath",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--critical") {
      options.critical = true;
      continue;
    }
    const key = mappings[arg];
    if (!key) continue;
    const value = argv[index + 1];
    if (!value) throw new Error(`missing_value_for_${arg}`);
    options[key] = value;
    index += 1;
  }

  return options;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function main() {
  const options = parseArguments(process.argv);
  const required = [
    "packagePath",
    "privateKeyPath",
    "releaseId",
    "backendVersion",
    "hubFirmwareVersion",
    "protocolVersion",
    "minBackendVersion",
    "packageUrl",
    "outputPath",
  ];

  for (const field of required) {
    if (!options[field]) throw new Error(`missing_${field}`);
  }

  const packagePath = path.resolve(options.packagePath);
  const privateKeyPath = path.resolve(options.privateKeyPath);
  const notes = options.notesFile
    ? JSON.parse(fs.readFileSync(path.resolve(options.notesFile), "utf8"))
    : {};

  const manifest = normalizeReleaseManifest({
    schemaVersion: HUB_UPDATE_SCHEMA_VERSION,
    releaseId: options.releaseId,
    backendVersion: options.backendVersion,
    hubFirmwareVersion: options.hubFirmwareVersion,
    protocolVersion: options.protocolVersion,
    minBackendVersion: options.minBackendVersion,
    packageUrl: options.packageUrl,
    packageSha256: sha256File(packagePath),
    publishedAt: options.publishedAt
      ? Number(options.publishedAt)
      : Date.now(),
    critical: options.critical,
    notes,
  });

  const privateKey = crypto.createPrivateKey(
    fs.readFileSync(privateKeyPath, "utf8"),
  );
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Private key phải là Ed25519");
  }

  const signature = signReleaseManifest({ manifest, privateKey });
  const releaseRecord = { manifest, signature };
  const outputPath = path.resolve(options.outputPath);
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(releaseRecord, null, 2)}\n`,
    "utf8",
  );
  console.log(`Release manifest: ${outputPath}`);
  console.log(`Package SHA-256: ${manifest.packageSha256}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, sha256File };
