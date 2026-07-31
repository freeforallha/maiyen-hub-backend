#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  assertBackendStabilityAudit,
  buildBackendStabilityAudit,
} = require("./lib/backend_stability_audit");

function readArgumentValue(argumentsList, name) {
  const prefix = `${name}=`;
  const inline = argumentsList.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = argumentsList.indexOf(name);
  if (index >= 0 && index + 1 < argumentsList.length) {
    return argumentsList[index + 1];
  }

  return "";
}

function main() {
  const argumentsList = process.argv.slice(2);
  const rootDir = path.resolve(
    readArgumentValue(argumentsList, "--root") || path.resolve(__dirname, ".."),
  );
  const outputValue = readArgumentValue(argumentsList, "--output");
  const outputPath = outputValue ? path.resolve(outputValue) : "";
  const strict = argumentsList.includes("--strict");
  const report = buildBackendStabilityAudit({ rootDir });
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, reportJson, "utf8");
  }

  console.log("=== MAIYEN BACKEND STABILITY AUDIT ===");
  console.log(`Version             : ${report.backendVersion}`);
  console.log(`Checks              : ${report.summary.checks}`);
  console.log(`Passed              : ${report.summary.passed}`);
  console.log(`Failed              : ${report.summary.failed}`);
  console.log(`index.js lines      : ${report.summary.indexLines}`);
  console.log(`Domain files        : ${report.summary.domainFiles}`);
  console.log(`Deploy files        : ${report.summary.deployFiles}`);
  console.log(`Lifecycle components: ${report.summary.lifecycleComponents}`);
  console.log(`Request listeners   : ${report.summary.requestListeners}`);

  for (const check of report.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"}: ${check.id}`);
  }

  if (outputPath) console.log(`Report              : ${outputPath}`);

  if (strict) assertBackendStabilityAudit(report);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
