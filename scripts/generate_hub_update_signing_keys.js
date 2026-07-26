#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const outputDir = path.resolve(process.argv[2] || ".");
fs.mkdirSync(outputDir, { recursive: true });

const privateKeyPath = path.join(outputDir, "maiyen-release-private-key.pem");
const publicKeyPath = path.join(outputDir, "maiyen-release-public-key.pem");

for (const filePath of [privateKeyPath, publicKeyPath]) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing key: ${filePath}`);
  }
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(
  privateKeyPath,
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
fs.writeFileSync(
  publicKeyPath,
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o644 },
);

console.log(`Private key: ${privateKeyPath}`);
console.log(`Public key:  ${publicKeyPath}`);
console.log("Không chép private key lên Hub hoặc đưa vào Git/ZIP dự án.");
