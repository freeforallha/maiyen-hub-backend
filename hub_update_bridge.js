"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_UPDATE_PUBLIC_KEY_PATH,
  isReleaseNewerThanCurrent,
  normalizeReleaseManifest,
  validateReleaseCompatibility,
  verifyReleaseManifestSignature,
} = require("./hub_update_contract");

const UPDATE_BRIDGE_SCHEMA_VERSION = 1;
const DEFAULT_UPDATE_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_UPDATE_INBOX_FILE =
  process.env.MAIYEN_UPDATE_INBOX_FILE ||
  process.env.SAFEHOME_UPDATE_INBOX_FILE ||
  "/var/lib/maiyen-updater/inbox/update-request.json";
const DEFAULT_UPDATE_RESULT_FILE =
  process.env.MAIYEN_UPDATE_RESULT_FILE ||
  process.env.SAFEHOME_UPDATE_RESULT_FILE ||
  "/var/lib/maiyen-updater/outbox/update-result.json";

function normalizeHomeUpdateRequest(rawValue) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null;
  }

  const releaseId = String(rawValue.releaseId || "").trim();
  const requestedBy = String(rawValue.requestedBy || "").trim();
  const requestedAt = Number(rawValue.requestedAt);
  const status = String(rawValue.status || "requested").trim();

  if (
    !/^[A-Za-z0-9._-]{1,120}$/.test(releaseId) ||
    !requestedBy ||
    !Number.isSafeInteger(requestedAt) ||
    requestedAt <= 0 ||
    status !== "requested"
  ) {
    return null;
  }

  return {
    releaseId,
    requestedBy,
    requestedAt,
    status,
  };
}

function buildUpdateRequestEnvelope({
  hubId,
  ownerUid,
  homeId,
  request,
  manifest,
  signature,
}) {
  const normalizedRequest = normalizeHomeUpdateRequest(request);
  const normalizedManifest = normalizeReleaseManifest(manifest);

  if (!normalizedRequest) {
    throw new Error("invalid_home_update_request");
  }

  if (normalizedRequest.releaseId !== normalizedManifest.releaseId) {
    throw new Error("release_request_mismatch");
  }

  return {
    bridgeSchemaVersion: UPDATE_BRIDGE_SCHEMA_VERSION,
    queuedAt: Date.now(),
    hubId: String(hubId || "").trim(),
    ownerUid: String(ownerUid || "").trim(),
    homeId: String(homeId || "").trim(),
    requestedBy: normalizedRequest.requestedBy,
    requestedAt: normalizedRequest.requestedAt,
    manifest: normalizedManifest,
    signature: String(signature || "").trim(),
  };
}

function atomicWriteJson(filePath, value) {
  const targetPath = path.resolve(filePath);
  const directory = path.dirname(targetPath);
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", mode: 0o660 },
  );
  fs.renameSync(temporaryPath, targetPath);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function createHubUpdateBridge({
  db,
  deviceId,
  currentVersions,
  getLinkedHomes,
  onStateChanged,
  onReleaseChecked,
  publicKeyPath = DEFAULT_UPDATE_PUBLIC_KEY_PATH,
  inboxFile = DEFAULT_UPDATE_INBOX_FILE,
  resultFile = DEFAULT_UPDATE_RESULT_FILE,
  pollIntervalMs = DEFAULT_UPDATE_POLL_INTERVAL_MS,
}) {
  if (!db || typeof db.ref !== "function") {
    throw new Error("hub_update_bridge_requires_database");
  }

  if (typeof getLinkedHomes !== "function") {
    throw new Error("hub_update_bridge_requires_linked_home_provider");
  }

  const state = {
    updateAgentSchemaVersion: UPDATE_BRIDGE_SCHEMA_VERSION,
    updateAgentStatus: "initializing",
    updateAvailable: false,
    latestReleaseId: "",
    latestBackendVersion: "",
    latestHubFirmwareVersion: "",
    latestProtocolVersion: "",
    latestReleaseCritical: false,
    latestReleasePublishedAt: 0,
    lastUpdateStatus: "",
    lastUpdateReleaseId: "",
    lastUpdateAt: 0,
    lastUpdateError: "",
  };

  let timer = null;
  let pollInProgress = false;

  function notifyStateChanged() {
    if (typeof onStateChanged === "function") {
      try {
        onStateChanged({ ...state });
      } catch (_) {
        // Không để callback làm dừng updater bridge.
      }
    }
  }

  function setState(patch) {
    let changed = false;

    for (const [key, value] of Object.entries(patch || {})) {
      if (state[key] !== value) {
        state[key] = value;
        changed = true;
      }
    }

    if (changed) {
      notifyStateChanged();
    }
  }

  async function writeHomeUpdateStatus(ownerUid, homeId, statusValue) {
    const basePath = `accounts/${ownerUid}/homes/${homeId}`;
    await db.ref(`${basePath}/hubUpdateStatus`).set(statusValue);
  }

  async function processResultFile() {
    const result = readJsonIfExists(resultFile);
    if (!result) {
      return;
    }

    const ownerUid = String(result.ownerUid || "").trim();
    const homeId = String(result.homeId || "").trim();
    const releaseId = String(result.releaseId || "").trim();
    const status = result.status === "success" ? "success" : "failed";
    const finishedAt = Number(result.finishedAt) || Date.now();
    const errorMessage = String(
      result.errorMessage || result.errorCode || "",
    ).slice(0, 500);

    if (ownerUid && homeId) {
      const updateStatus = {
        releaseId,
        status,
        startedAt: Number(result.startedAt) || 0,
        finishedAt,
        installedBackendVersion: String(
          result.installedBackendVersion || "",
        ),
        installedHubFirmwareVersion: String(
          result.installedHubFirmwareVersion || "",
        ),
        errorCode: String(result.errorCode || "").slice(0, 120),
        errorMessage,
      };

      await writeHomeUpdateStatus(ownerUid, homeId, updateStatus);
      await db
        .ref(`accounts/${ownerUid}/homes/${homeId}/hubUpdateRequest`)
        .update({
          status,
          finishedAt,
          errorCode: updateStatus.errorCode,
        });
    }

    setState({
      lastUpdateStatus: status,
      lastUpdateReleaseId: releaseId,
      lastUpdateAt: finishedAt,
      lastUpdateError: errorMessage,
    });

    fs.unlinkSync(resultFile);
  }

  async function readVerifiedLatestRelease() {
    let publicKeyAvailable = true;
    try {
      fs.accessSync(publicKeyPath, fs.constants.R_OK);
    } catch (_) {
      publicKeyAvailable = false;
    }

    if (!publicKeyAvailable) {
      setState({
        updateAgentStatus: "not_configured",
        updateAvailable: false,
        lastUpdateError: "missing_update_public_key",
      });
      return null;
    }

    const snapshot = await db.ref("system/hubReleases/latest").once("value");
    const releaseRecord = snapshot.val();

    if (!releaseRecord || typeof releaseRecord !== "object") {
      setState({
        updateAgentStatus: "ready",
        updateAvailable: false,
        latestReleaseId: "",
        latestBackendVersion: "",
        latestHubFirmwareVersion: "",
        latestProtocolVersion: "",
        latestReleaseCritical: false,
        latestReleasePublishedAt: 0,
      });
      return null;
    }

    const manifest = verifyReleaseManifestSignature({
      manifest: releaseRecord.manifest,
      signature: releaseRecord.signature,
      publicKeyPath,
    });

    validateReleaseCompatibility(manifest, currentVersions);
    const updateAvailable = isReleaseNewerThanCurrent(
      manifest,
      currentVersions,
    );

    setState({
      updateAgentStatus: "ready",
      updateAvailable,
      latestReleaseId: manifest.releaseId,
      latestBackendVersion: manifest.backendVersion,
      latestHubFirmwareVersion: manifest.hubFirmwareVersion,
      latestProtocolVersion: manifest.protocolVersion,
      latestReleaseCritical: manifest.critical,
      latestReleasePublishedAt: manifest.publishedAt,
      lastUpdateError: "",
    });

    if (typeof onReleaseChecked === "function") {
      try {
        await onReleaseChecked({
          manifest: { ...manifest },
          updateAvailable,
        });
      } catch (error) {
        console.log(
          "HUB UPDATE RELEASE CALLBACK ERROR:",
          String(error?.message || error || "unknown_error"),
        );
      }
    }

    return {
      manifest,
      signature: String(releaseRecord.signature || "").trim(),
    };
  }

  async function queueRequestedUpdate(releaseRecord) {
    if (!releaseRecord || fs.existsSync(inboxFile)) {
      return false;
    }

    const linkedHomes = await getLinkedHomes();

    for (const linkedHome of linkedHomes) {
      const ownerUid = String(linkedHome.uid || "").trim();
      const homeId = String(linkedHome.homeId || "").trim();

      if (!ownerUid || !homeId) {
        continue;
      }

      const requestSnapshot = await db
        .ref(`accounts/${ownerUid}/homes/${homeId}/hubUpdateRequest`)
        .once("value");
      const request = normalizeHomeUpdateRequest(requestSnapshot.val());

      if (!request || request.releaseId !== releaseRecord.manifest.releaseId) {
        continue;
      }

      if (request.requestedBy !== ownerUid) {
        await writeHomeUpdateStatus(ownerUid, homeId, {
          releaseId: request.releaseId,
          status: "rejected",
          finishedAt: Date.now(),
          errorCode: "owner_confirmation_required",
        });
        continue;
      }

      const envelope = buildUpdateRequestEnvelope({
        hubId: deviceId,
        ownerUid,
        homeId,
        request,
        manifest: releaseRecord.manifest,
        signature: releaseRecord.signature,
      });

      atomicWriteJson(inboxFile, envelope);
      const queuedAt = envelope.queuedAt;

      await db
        .ref(`accounts/${ownerUid}/homes/${homeId}/hubUpdateRequest`)
        .update({ status: "queued", queuedAt });
      await writeHomeUpdateStatus(ownerUid, homeId, {
        releaseId: envelope.manifest.releaseId,
        status: "queued",
        queuedAt,
      });

      setState({
        lastUpdateStatus: "queued",
        lastUpdateReleaseId: envelope.manifest.releaseId,
        lastUpdateAt: queuedAt,
        lastUpdateError: "",
      });

      return true;
    }

    return false;
  }

  async function poll() {
    if (pollInProgress) {
      return;
    }

    pollInProgress = true;

    try {
      await processResultFile();
      const latestRelease = await readVerifiedLatestRelease();

      if (latestRelease && state.updateAvailable) {
        await queueRequestedUpdate(latestRelease);
      }
    } catch (error) {
      const message = String(error?.message || error || "unknown_error");
      setState({
        updateAgentStatus: "error",
        lastUpdateError: message.slice(0, 500),
      });
      console.log("HUB UPDATE BRIDGE ERROR:", message);
    } finally {
      pollInProgress = false;
    }
  }

  function start() {
    if (timer) {
      return;
    }

    void poll();
    timer = setInterval(() => {
      void poll();
    }, Math.max(15 * 1000, Number(pollIntervalMs) || 0));
  }

  function stop() {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = null;
  }

  function getHeartbeatFields() {
    return { ...state };
  }

  return {
    getHeartbeatFields,
    poll,
    start,
    stop,
  };
}

module.exports = {
  DEFAULT_UPDATE_INBOX_FILE,
  DEFAULT_UPDATE_POLL_INTERVAL_MS,
  DEFAULT_UPDATE_RESULT_FILE,
  UPDATE_BRIDGE_SCHEMA_VERSION,
  atomicWriteJson,
  buildUpdateRequestEnvelope,
  createHubUpdateBridge,
  normalizeHomeUpdateRequest,
  readJsonIfExists,
};
