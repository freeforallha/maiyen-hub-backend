"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_REQUEST_LISTENER_KEYS = Object.freeze([
  "request:alarm_incident_action",
  "request:alarm_pause",
  "request:home_siren_action",
  "request:transfer_owner_accept",
]);

const FORBIDDEN_COMPOSITION_ROOT_PATTERNS = Object.freeze([
  {
    id: "legacy-init-function",
    pattern: /async function init\s*\(/,
  },
  {
    id: "legacy-cloud-step-runner",
    pattern: /function runCloudInitStep\s*\(/,
  },
  {
    id: "direct-sigterm-handler",
    pattern: /process\.once\(["']SIGTERM["']/,
  },
  {
    id: "direct-sigint-handler",
    pattern: /process\.once\(["']SIGINT["']/,
  },
  {
    id: "direct-transfer-owner-listener",
    pattern: /db\.ref\(["']transfer_owner_accept_requests["']\)\.on/,
  },
  {
    id: "direct-alarm-pause-listener",
    pattern: /db\.ref\(["']alarm_pause_requests["']\)\.on/,
  },
  {
    id: "direct-home-siren-listener",
    pattern: /db\.ref\(["']home_siren_action_requests["']\)\.on/,
  },
  {
    id: "direct-alarm-incident-listener",
    pattern: /db\.ref\(["']alarm_incident_action_requests["']\)\.on/,
  },
]);

function normalizeRelativePath(rawValue) {
  return String(rawValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRelativePath).filter(Boolean))].sort();
}

function listFilesRecursive(rootDir, relativeDir, predicate = () => true) {
  const baseDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(baseDir)) return [];

  const result = [];
  const queue = [baseDir];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = normalizeRelativePath(
          path.relative(rootDir, absolutePath),
        );
        if (predicate(relativePath)) result.push(relativePath);
      }
    }
  }

  return uniqueSorted(result);
}

function extractShellArray(source, variableName = "FILES") {
  const escapedName = String(variableName || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const pattern = new RegExp(
    `(?:^|\\n)${escapedName}=\\(\\n([\\s\\S]*?)\\n\\)`,
  );
  const match = pattern.exec(String(source || ""));
  if (!match) return [];

  return uniqueSorted(
    [...match[1].matchAll(/["']([^"']+)["']/g)].map(
      (item) => item[1],
    ),
  );
}

function extractLocalRuntimeRequires(source) {
  const requiredPaths = [];

  for (const match of String(source || "").matchAll(
    /require\(["'](\.\/[^"']+)["']\)/g,
  )) {
    const rawPath = normalizeRelativePath(match[1]);
    if (!rawPath || rawPath === "serviceAccount.json") continue;
    requiredPaths.push(path.posix.extname(rawPath) ? rawPath : `${rawPath}.js`);
  }

  return uniqueSorted(requiredPaths);
}

function extractLifecycleComponentKeys(source) {
  return uniqueSorted(
    [...String(source || "").matchAll(
      /addBackendComponent\(\{[\s\S]*?key:\s*["']([^"']+)["']/g,
    )].map((match) => match[1]),
  );
}

function extractRequestListenerKeys(source) {
  return uniqueSorted(
    [...String(source || "").matchAll(
      /key:\s*["'](request:[^"']+)["']/g,
    )].map((match) => match[1]),
  );
}

function createCheck(id, passed, detail, data = undefined) {
  const check = {
    id: String(id),
    passed: Boolean(passed),
    detail: String(detail || ""),
  };
  if (data !== undefined) check.data = data;
  return check;
}

function readJson(rootDir, relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(rootDir, relativePath), "utf8"),
  );
}

function buildBackendStabilityAudit({
  rootDir,
  now = () => new Date(),
  maxIndexLines = 7000,
} = {}) {
  const resolvedRoot = path.resolve(rootDir || path.resolve(__dirname, "../.."));
  const indexSource = fs.readFileSync(
    path.join(resolvedRoot, "index.js"),
    "utf8",
  );
  const deploySource = fs.readFileSync(
    path.join(resolvedRoot, "scripts/deploy_backend_production.sh"),
    "utf8",
  );
  const packageJson = readJson(resolvedRoot, "package.json");
  const packageLock = readJson(resolvedRoot, "package-lock.json");

  const deployFiles = extractShellArray(deploySource, "FILES");
  const domainFiles = listFilesRecursive(
    resolvedRoot,
    "domains",
    (relativePath) => relativePath.endsWith(".js"),
  );
  const localRuntimeRequires = extractLocalRuntimeRequires(indexSource);
  const lifecycleKeys = extractLifecycleComponentKeys(indexSource);
  const requestListenerKeys = extractRequestListenerKeys(indexSource);
  const indexLineCount = indexSource.split(/\r?\n/).length;

  const missingDomainDeployFiles = domainFiles.filter(
    (relativePath) => !deployFiles.includes(relativePath),
  );
  const missingRequiredDeployFiles = localRuntimeRequires.filter(
    (relativePath) => !deployFiles.includes(relativePath),
  );
  const missingDeploySourceFiles = deployFiles.filter(
    (relativePath) => !fs.existsSync(path.join(resolvedRoot, relativePath)),
  );
  const missingRequestKeys = REQUIRED_REQUEST_LISTENER_KEYS.filter(
    (key) => !requestListenerKeys.includes(key),
  );
  const unexpectedRequestKeys = requestListenerKeys.filter(
    (key) => !REQUIRED_REQUEST_LISTENER_KEYS.includes(key),
  );
  const forbiddenMatches = FORBIDDEN_COMPOSITION_ROOT_PATTERNS
    .filter(({ pattern }) => pattern.test(indexSource))
    .map(({ id }) => id);

  const deployUsesGenericJsValidation =
    /for file in "\$\{FILES\[@\]\}"; do[\s\S]*?\*\.js\)[\s\S]*?node --check "\$\{STAGE_DIR\}\/\$\{file\}"/m.test(
      deploySource,
    );
  const deployUsesGenericJsonValidation =
    /package\.json\|package-lock\.json\)[\s\S]*?JSON\.parse/m.test(
      deploySource,
    );
  const auditRunsBeforeDeploy =
    /audit_backend_stability\.js["']?\s+--strict/.test(deploySource);

  const checks = [
    createCheck(
      "package-lock-version",
      packageLock.version === packageJson.version &&
        packageLock.packages?.[""]?.version === packageJson.version,
      "package.json and package-lock.json versions must match",
      {
        packageVersion: packageJson.version,
        lockVersion: packageLock.version,
        rootLockVersion: packageLock.packages?.[""]?.version || null,
      },
    ),
    createCheck(
      "deploy-manifest-files-exist",
      missingDeploySourceFiles.length === 0,
      "every deploy manifest file must exist in source",
      { missing: missingDeploySourceFiles },
    ),
    createCheck(
      "all-domains-deployed",
      missingDomainDeployFiles.length === 0,
      "every domain module must be included in the production deploy manifest",
      {
        domainCount: domainFiles.length,
        missing: missingDomainDeployFiles,
      },
    ),
    createCheck(
      "all-index-local-requires-deployed",
      missingRequiredDeployFiles.length === 0,
      "every local JavaScript module required by index.js must be deployed",
      {
        requiredCount: localRuntimeRequires.length,
        missing: missingRequiredDeployFiles,
      },
    ),
    createCheck(
      "generic-stage-js-validation",
      deployUsesGenericJsValidation,
      "deploy staging must syntax-check every JavaScript file in FILES",
    ),
    createCheck(
      "generic-stage-json-validation",
      deployUsesGenericJsonValidation,
      "deploy staging must parse both package JSON files",
    ),
    createCheck(
      "audit-before-deploy",
      auditRunsBeforeDeploy,
      "the strict stability audit must run before production backup/install",
    ),
    createCheck(
      "lifecycle-component-count",
      lifecycleKeys.length === 24,
      "backend lifecycle must contain exactly 24 unique components",
      { count: lifecycleKeys.length, keys: lifecycleKeys },
    ),
    createCheck(
      "firebase-request-listeners",
      missingRequestKeys.length === 0 && unexpectedRequestKeys.length === 0,
      "Firebase request coordinator must expose exactly the four canonical request listeners",
      {
        count: requestListenerKeys.length,
        keys: requestListenerKeys,
        missing: missingRequestKeys,
        unexpected: unexpectedRequestKeys,
      },
    ),
    createCheck(
      "legacy-composition-code",
      forbiddenMatches.length === 0,
      "legacy startup, signal and direct request listener code must stay removed",
      { matches: forbiddenMatches },
    ),
    createCheck(
      "composition-root-size",
      indexLineCount <= maxIndexLines,
      `index.js must remain at or below ${maxIndexLines} lines`,
      { lineCount: indexLineCount, limit: maxIndexLines },
    ),
  ];

  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    backendVersion: packageJson.version,
    passed: checks.every((check) => check.passed),
    summary: {
      checks: checks.length,
      passed: checks.filter((check) => check.passed).length,
      failed: checks.filter((check) => !check.passed).length,
      indexLines: indexLineCount,
      domainFiles: domainFiles.length,
      deployFiles: deployFiles.length,
      localRuntimeRequires: localRuntimeRequires.length,
      lifecycleComponents: lifecycleKeys.length,
      requestListeners: requestListenerKeys.length,
    },
    checks,
  };
}

function assertBackendStabilityAudit(report) {
  if (!report || typeof report !== "object") {
    throw new TypeError("Backend stability audit report is required");
  }

  const failedChecks = Array.isArray(report.checks)
    ? report.checks.filter((check) => !check?.passed)
    : [];

  if (!report.passed || failedChecks.length > 0) {
    const labels = failedChecks.map((check) => check.id).join(", ");
    const error = new Error(
      `Backend stability audit failed${labels ? `: ${labels}` : ""}`,
    );
    error.code = "BACKEND_STABILITY_AUDIT_FAILED";
    error.failedChecks = failedChecks;
    throw error;
  }

  return report;
}

module.exports = {
  FORBIDDEN_COMPOSITION_ROOT_PATTERNS,
  REQUIRED_REQUEST_LISTENER_KEYS,
  assertBackendStabilityAudit,
  buildBackendStabilityAudit,
  extractLifecycleComponentKeys,
  extractLocalRuntimeRequires,
  extractRequestListenerKeys,
  extractShellArray,
  listFilesRecursive,
  normalizeRelativePath,
};
