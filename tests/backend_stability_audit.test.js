"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertBackendStabilityAudit,
  buildBackendStabilityAudit,
  extractLifecycleComponentKeys,
  extractLocalRuntimeRequires,
  extractRequestListenerKeys,
  extractShellArray,
  normalizeRelativePath,
} = require("../scripts/lib/backend_stability_audit");

const ROOT = path.resolve(__dirname, "..");

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "maiyen-stability-audit-"),
  );

  fs.mkdirSync(path.join(fixtureRoot, "domains/runtime"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });

  fs.writeFileSync(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "maiyen-hub-backend", version: "1.2.39" }),
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "package-lock.json"),
    JSON.stringify({
      name: "maiyen-hub-backend",
      version: "1.2.39",
      packages: { "": { name: "maiyen-hub-backend", version: "1.2.39" } },
    }),
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "domains/runtime/example.js"),
    '"use strict";\nmodule.exports = {};\n',
  );

  const lifecycleComponents = Array.from(
    { length: 24 },
    (_, index) => `addBackendComponent({ key: "component_${index + 1}" });`,
  ).join("\n");
  const requestListeners = [
    "alarm_incident_action",
    "alarm_pause",
    "home_siren_action",
    "transfer_owner_accept",
  ].map((key) => `register({ key: "request:${key}" });`).join("\n");

  fs.writeFileSync(
    path.join(fixtureRoot, "index.js"),
    [
      '"use strict";',
      'require("./domains/runtime/example");',
      lifecycleComponents,
      requestListeners,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(fixtureRoot, "scripts/deploy_backend_production.sh"),
    `#!/usr/bin/env bash
FILES=(
  "index.js"
  "domains/runtime/example.js"
  "package.json"
  "package-lock.json"
)
node scripts/audit_backend_stability.js --strict
for file in "\${FILES[@]}"; do
  case "\${file}" in
    *.js)
      node --check "\${STAGE_DIR}/\${file}"
      ;;
    package.json|package-lock.json)
      node -e 'JSON.parse("{}")'
      ;;
  esac
done
`,
  );

  return fixtureRoot;
}

test("path and source extractors normalize deterministic identities", () => {
  assert.equal(normalizeRelativePath(".\\domains//home/test.js"), "domains/home/test.js");
  assert.deepEqual(
    extractShellArray('FILES=(\n  "b.js"\n  "a.js"\n  "b.js"\n)'),
    ["a.js", "b.js"],
  );
  assert.deepEqual(
    extractLocalRuntimeRequires('require("./b"); require("./a.js"); require("./serviceAccount.json");'),
    ["a.js", "b.js"],
  );
});

test("lifecycle and request keys are extracted uniquely", () => {
  const source = `
    addBackendComponent({ key: "cache" });
    addBackendComponent({ key: "cache" });
    addBackendComponent({ key: "ready" });
    register({ key: "request:alarm_pause" });
    register({ key: "request:alarm_pause" });
  `;

  assert.deepEqual(extractLifecycleComponentKeys(source), ["cache", "ready"]);
  assert.deepEqual(extractRequestListenerKeys(source), ["request:alarm_pause"]);
});

test("current backend passes every final stability audit", () => {
  const report = buildBackendStabilityAudit({
    rootDir: ROOT,
    now: () => new Date("2026-07-31T15:00:00.000Z"),
  });

  assert.equal(report.passed, true);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.lifecycleComponents, 24);
  assert.equal(report.summary.requestListeners, 4);
  assert.ok(report.summary.domainFiles >= 27);
  assert.ok(report.summary.deployFiles >= 39);
  assert.doesNotThrow(() => assertBackendStabilityAudit(report));
});

test("audit detects a domain omitted from the deploy manifest", () => {
  const fixtureRoot = createFixture();
  fs.writeFileSync(
    path.join(fixtureRoot, "domains/runtime/missing.js"),
    '"use strict";\n',
  );

  const report = buildBackendStabilityAudit({ rootDir: fixtureRoot });
  const check = report.checks.find(({ id }) => id === "all-domains-deployed");

  assert.equal(check.passed, false);
  assert.deepEqual(check.data.missing, ["domains/runtime/missing.js"]);
});

test("audit detects package-lock version drift", () => {
  const fixtureRoot = createFixture();
  const packageLockPath = path.join(fixtureRoot, "package-lock.json");
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
  packageLock.version = "1.2.38";
  fs.writeFileSync(packageLockPath, JSON.stringify(packageLock));

  const report = buildBackendStabilityAudit({ rootDir: fixtureRoot });
  const check = report.checks.find(({ id }) => id === "package-lock-version");

  assert.equal(check.passed, false);
});

test("audit detects direct legacy Firebase request listeners", () => {
  const fixtureRoot = createFixture();
  fs.appendFileSync(
    path.join(fixtureRoot, "index.js"),
    '\ndb.ref("alarm_pause_requests").on("child_added", () => {});\n',
  );

  const report = buildBackendStabilityAudit({ rootDir: fixtureRoot });
  const check = report.checks.find(({ id }) => id === "legacy-composition-code");

  assert.equal(check.passed, false);
  assert.deepEqual(check.data.matches, ["direct-alarm-pause-listener"]);
});

test("audit detects missing generic stage validation", () => {
  const fixtureRoot = createFixture();
  const deployPath = path.join(
    fixtureRoot,
    "scripts/deploy_backend_production.sh",
  );
  fs.writeFileSync(
    deployPath,
    'FILES=(\n  "index.js"\n  "domains/runtime/example.js"\n  "package.json"\n  "package-lock.json"\n)\nnode scripts/audit_backend_stability.js --strict\n',
  );

  const report = buildBackendStabilityAudit({ rootDir: fixtureRoot });
  assert.equal(
    report.checks.find(({ id }) => id === "generic-stage-js-validation").passed,
    false,
  );
  assert.equal(
    report.checks.find(({ id }) => id === "generic-stage-json-validation").passed,
    false,
  );
});

test("strict assertion exposes failed check identities", () => {
  assert.throws(
    () =>
      assertBackendStabilityAudit({
        passed: false,
        checks: [
          { id: "one", passed: false },
          { id: "two", passed: true },
        ],
      }),
    (error) => {
      assert.equal(error.code, "BACKEND_STABILITY_AUDIT_FAILED");
      assert.match(error.message, /one/);
      return true;
    },
  );
});
