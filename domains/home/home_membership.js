"use strict";

const TRANSFER_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const TRANSFER_REQUEST_FUTURE_SKEW_MS = 1000;
const TRANSFER_RESULT_TTL_MS = 30 * 1000;

const HOME_ROLE_RANK = Object.freeze({
  none: 0,
  member: 1,
  admin: 2,
  owner: 3,
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeHomeRole(rawRole) {
  const role = cleanText(rawRole).toLowerCase();

  if (role === "owner" || role === "admin" || role === "member") {
    return role;
  }

  return "none";
}

function normalizeHomeOrder(rawOrder) {
  if (Array.isArray(rawOrder)) {
    return rawOrder
      .filter((value) => value != null)
      .map((value) => cleanText(value))
      .filter(Boolean);
  }

  if (rawOrder && typeof rawOrder === "object") {
    return Object.keys(rawOrder)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => rawOrder[key])
      .filter((value) => value != null)
      .map((value) => cleanText(value))
      .filter(Boolean);
  }

  return [];
}

function hasHomeRole(role, minimumRole = "member") {
  const normalizedRole = normalizeHomeRole(role);
  const normalizedMinimum = normalizeHomeRole(minimumRole);

  return (
    HOME_ROLE_RANK[normalizedRole] >=
    HOME_ROLE_RANK[normalizedMinimum]
  );
}

function resolveCachedHomeAccess({
  requesterUid,
  homeId,
  requesterAccount,
  sharedMembers,
} = {}) {
  const cleanRequesterUid = cleanText(requesterUid);
  const cleanHomeId = cleanText(homeId);
  const account = asObject(requesterAccount);

  if (!cleanRequesterUid || !cleanHomeId) {
    return {
      allowed: false,
      ownerUid: "",
      role: "none",
      source: "invalid",
    };
  }

  if (asObject(account.homes)[cleanHomeId]) {
    return {
      allowed: true,
      ownerUid: cleanRequesterUid,
      role: "owner",
      source: "owned_home",
    };
  }

  const sharedHome = asObject(
    asObject(account.sharedHomes)[cleanHomeId],
  );
  const ownerUid = cleanText(sharedHome.ownerUid);
  const memberRecord = asObject(
    asObject(sharedMembers)[cleanRequesterUid],
  );

  if (!ownerUid || Object.keys(memberRecord).length === 0) {
    return {
      allowed: false,
      ownerUid,
      role: "none",
      source: "stale_shared_home",
    };
  }

  const role = normalizeHomeRole(
    memberRecord.role || sharedHome.role || "member",
  );

  return {
    allowed: hasHomeRole(role, "member"),
    ownerUid,
    role: role === "none" ? "member" : role,
    source: "shared_home",
  };
}

function normalizeTransferOwnerAcceptRequest(
  rawRequest,
  requestId,
  now,
  {
    maxAgeMs = TRANSFER_REQUEST_MAX_AGE_MS,
    futureSkewMs = TRANSFER_REQUEST_FUTURE_SKEW_MS,
  } = {},
) {
  const request = asObject(rawRequest);
  const currentTime = Number(now);
  const requestTime = Number(request.time);
  const normalized = {
    requestId: cleanText(requestId),
    status: cleanText(request.status),
    requestedByUid: cleanText(request.requestedByUid),
    oldOwnerUid: cleanText(request.oldOwnerUid),
    newOwnerUid: cleanText(request.newOwnerUid),
    homeId: cleanText(request.homeId),
    requestTime,
  };

  normalized.valid = Boolean(
    normalized.requestId &&
      normalized.status === "pending" &&
      normalized.requestedByUid &&
      normalized.oldOwnerUid &&
      normalized.newOwnerUid &&
      normalized.homeId &&
      normalized.requestedByUid === normalized.newOwnerUid &&
      normalized.oldOwnerUid !== normalized.newOwnerUid &&
      Number.isFinite(currentTime) &&
      Number.isFinite(requestTime) &&
      requestTime <= currentTime + futureSkewMs &&
      requestTime >= currentTime - maxAgeMs,
  );

  return normalized;
}

function isValidTransferRequestRecord(
  rawTransferRequest,
  {
    homeId,
    oldOwnerUid,
    newOwnerUid,
  } = {},
) {
  const request = asObject(rawTransferRequest);

  return Boolean(
    request.type === "transfer_owner_request" &&
      cleanText(request.homeId) === cleanText(homeId) &&
      cleanText(request.oldOwnerUid) === cleanText(oldOwnerUid) &&
      cleanText(request.newOwnerUid) === cleanText(newOwnerUid),
  );
}

function buildOwnerTransferUpdates({
  oldOwnerUid,
  newOwnerUid,
  homeId,
  homeData,
  sharedByHome,
  oldShareList,
  oldOwnerDirectory,
  newOwnerOrder,
  timestamp,
} = {}) {
  const cleanOldOwnerUid = cleanText(oldOwnerUid);
  const cleanNewOwnerUid = cleanText(newOwnerUid);
  const cleanHomeId = cleanText(homeId);
  const home = asObject(homeData);
  const sharedMembers = asObject(sharedByHome);
  const oldList = asObject(oldShareList);
  const oldDirectory = asObject(oldOwnerDirectory);
  const now = Number(timestamp) || Date.now();

  if (!cleanOldOwnerUid || !cleanNewOwnerUid || !cleanHomeId) {
    throw new Error("TRANSFER OWNER IDENTITY MISSING");
  }

  const migratedHome = {
    ...home,
    _ownerUid: cleanNewOwnerUid,
    _shared: false,
  };

  const oldOwnerMemberData = {
    role: "member",
    email: cleanText(oldDirectory.email),
    name: cleanText(oldDirectory.name),
    photoUrl: cleanText(oldDirectory.photoUrl),
    sharedAt: now,
  };

  const oldOwnerSharedHome = {
    ownerUid: cleanNewOwnerUid,
    role: "member",
  };

  if (home.alarmPauseToday) {
    oldOwnerSharedHome.alarmPauseToday = home.alarmPauseToday;
  }

  const newShareList = {};

  for (const [memberUid, rawMember] of Object.entries(sharedMembers)) {
    if (
      memberUid === cleanNewOwnerUid ||
      memberUid === cleanOldOwnerUid
    ) {
      continue;
    }

    const memberData = asObject(rawMember);
    const oldListData = asObject(oldList[memberUid]);

    newShareList[memberUid] = {
      ...memberData,
      ...oldListData,
      role:
        normalizeHomeRole(memberData.role) !== "none"
          ? normalizeHomeRole(memberData.role)
          : normalizeHomeRole(oldListData.role) !== "none"
            ? normalizeHomeRole(oldListData.role)
            : "member",
    };
  }

  newShareList[cleanOldOwnerUid] = {
    ...oldOwnerMemberData,
  };

  const normalizedOrder = normalizeHomeOrder(newOwnerOrder);

  if (!normalizedOrder.includes(cleanHomeId)) {
    normalizedOrder.push(cleanHomeId);
  }

  const updates = {
    [`accounts/${cleanNewOwnerUid}/homes/${cleanHomeId}`]: migratedHome,
    [`accounts/${cleanOldOwnerUid}/homes/${cleanHomeId}`]: null,
    [`accounts/${cleanNewOwnerUid}/sharedHomes/${cleanHomeId}`]: null,
    [`accounts/${cleanOldOwnerUid}/sharedHomes/${cleanHomeId}`]:
      oldOwnerSharedHome,
    [`sharedByHome/${cleanHomeId}/${cleanNewOwnerUid}`]: null,
    [`sharedByHome/${cleanHomeId}/${cleanOldOwnerUid}`]:
      oldOwnerMemberData,
    [`accounts/${cleanOldOwnerUid}/shareList/${cleanHomeId}`]: null,
    [`accounts/${cleanNewOwnerUid}/shareList/${cleanHomeId}`]:
      newShareList,
    [`accounts/${cleanNewOwnerUid}/homeOrder`]: normalizedOrder,
    [`accounts/${cleanNewOwnerUid}/customRules/${cleanHomeId}`]: null,
  };

  for (const memberUid of Object.keys(sharedMembers)) {
    if (
      memberUid === cleanNewOwnerUid ||
      memberUid === cleanOldOwnerUid
    ) {
      continue;
    }

    updates[
      `accounts/${memberUid}/sharedHomes/${cleanHomeId}/ownerUid`
    ] = cleanNewOwnerUid;
  }

  const devices = asObject(home.devices);

  for (const deviceId of Object.keys(devices)) {
    updates[`system/devices_by_ieee/${deviceId}/uid`] =
      cleanNewOwnerUid;
    updates[`system/devices_by_ieee/${deviceId}/homeId`] =
      cleanHomeId;
  }

  return {
    devices,
    migratedHome,
    newOwnerOrder: normalizedOrder,
    oldOwnerMemberData,
    updates,
  };
}

function createHomeMembershipDomain({
  db,
  deviceMap,
  getCachedAccountData,
  getCachedHomeData,
  getSharedMembersForHome,
  addHomeNotificationFromBackend,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  resultTtlMs = TRANSFER_RESULT_TTL_MS,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db || typeof db.ref !== "function") {
    throw new Error("Home Membership requires db.ref");
  }
  if (!deviceMap || typeof deviceMap !== "object") {
    throw new Error("Home Membership requires deviceMap");
  }
  if (typeof getCachedAccountData !== "function") {
    throw new Error("Home Membership requires getCachedAccountData");
  }
  if (typeof getCachedHomeData !== "function") {
    throw new Error("Home Membership requires getCachedHomeData");
  }
  if (typeof getSharedMembersForHome !== "function") {
    throw new Error("Home Membership requires getSharedMembersForHome");
  }
  if (typeof addHomeNotificationFromBackend !== "function") {
    throw new Error(
      "Home Membership requires addHomeNotificationFromBackend",
    );
  }

  const transferOwnerAcceptInProgress = new Set();
  const requestCleanupTimers = new Set();

  function scheduleRequestCleanup(requestRef) {
    const timer = setTimeoutFn(() => {
      requestCleanupTimers.delete(timer);
      void requestRef.remove().catch(() => {});
    }, Math.max(0, Number(resultTtlMs) || 0));

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }

    requestCleanupTimers.add(timer);
  }

  async function finishRequest(
    requestRef,
    status,
    errorMessage = "",
  ) {
    const result = {
      status,
      processedAt: now(),
    };

    if (errorMessage) {
      result.error = errorMessage;
    }

    await requestRef.update(result);
    scheduleRequestCleanup(requestRef);
  }

  function getCachedHomeAccess(requesterUid, homeId) {
    const cleanHomeId = cleanText(homeId);

    return resolveCachedHomeAccess({
      requesterUid,
      homeId: cleanHomeId,
      requesterAccount: getCachedAccountData(requesterUid),
      sharedMembers: getSharedMembersForHome(cleanHomeId),
    });
  }

  function isCachedHomeParticipant({
    requesterUid,
    ownerUid,
    homeId,
  } = {}) {
    const cleanRequesterUid = cleanText(requesterUid);
    const cleanOwnerUid = cleanText(ownerUid);

    if (!cleanRequesterUid || !cleanOwnerUid || !cleanText(homeId)) {
      return false;
    }

    if (cleanRequesterUid === cleanOwnerUid) {
      return true;
    }

    const access = getCachedHomeAccess(cleanRequesterUid, homeId);

    return (
      access.allowed &&
      access.ownerUid === cleanOwnerUid &&
      hasHomeRole(access.role, "member")
    );
  }

  async function verifyHomeParticipant({
    requesterUid,
    ownerUid,
    homeId,
  } = {}) {
    const cleanRequesterUid = cleanText(requesterUid);
    const cleanOwnerUid = cleanText(ownerUid);
    const cleanHomeId = cleanText(homeId);

    if (!cleanRequesterUid || !cleanOwnerUid || !cleanHomeId) {
      return false;
    }

    if (cleanRequesterUid === cleanOwnerUid) {
      return true;
    }

    const cachedAccess = getCachedHomeAccess(
      cleanRequesterUid,
      cleanHomeId,
    );

    if (
      cachedAccess.allowed &&
      cachedAccess.ownerUid === cleanOwnerUid
    ) {
      return true;
    }

    const [sharedHomeSnap, sharedMemberSnap] = await Promise.all([
      db
        .ref(
          `accounts/${cleanRequesterUid}/sharedHomes/${cleanHomeId}`,
        )
        .once("value"),
      db
        .ref(`sharedByHome/${cleanHomeId}/${cleanRequesterUid}`)
        .once("value"),
    ]);

    const sharedHome = asObject(sharedHomeSnap.val());

    return Boolean(
      cleanText(sharedHome.ownerUid) === cleanOwnerUid &&
        sharedMemberSnap.exists(),
    );
  }

  async function handleTransferOwnerAcceptRequest(snap) {
    const rawRequest = snap?.val?.();
    const requestId = cleanText(snap?.key);
    const request = normalizeTransferOwnerAcceptRequest(
      rawRequest,
      requestId,
      now(),
    );

    try {
      if (!rawRequest || !requestId) {
        return;
      }

      if (transferOwnerAcceptInProgress.has(requestId)) {
        return;
      }

      transferOwnerAcceptInProgress.add(requestId);

      if (!request.valid) {
        await finishRequest(snap.ref, "rejected", "INVALID DATA");
        return;
      }

      const {
        oldOwnerUid,
        newOwnerUid,
        homeId,
      } = request;
      const transferRequestKey =
        `transfer_${homeId}_${oldOwnerUid}`;

      const [
        oldHomeSnap,
        targetHomeSnap,
        transferRequestSnap,
        sharedByHomeSnap,
        oldShareListSnap,
        oldOwnerDirectorySnap,
        newOwnerAccountSnap,
        newOwnerOrderSnap,
      ] = await Promise.all([
        db
          .ref(`accounts/${oldOwnerUid}/homes/${homeId}`)
          .once("value"),
        db
          .ref(`accounts/${newOwnerUid}/homes/${homeId}`)
          .once("value"),
        db
          .ref(
            `accounts/${newOwnerUid}/shareRequests/${transferRequestKey}`,
          )
          .once("value"),
        db.ref(`sharedByHome/${homeId}`).once("value"),
        db
          .ref(`accounts/${oldOwnerUid}/shareList/${homeId}`)
          .once("value"),
        db.ref(`userDirectory/${oldOwnerUid}`).once("value"),
        db.ref(`accounts/${newOwnerUid}`).once("value"),
        db
          .ref(`accounts/${newOwnerUid}/homeOrder`)
          .once("value"),
      ]);

      if (!oldHomeSnap.exists() || !newOwnerAccountSnap.exists()) {
        await finishRequest(
          snap.ref,
          "rejected",
          "ACCOUNT OR HOME NOT FOUND",
        );
        return;
      }

      if (targetHomeSnap.exists()) {
        await finishRequest(
          snap.ref,
          "rejected",
          "TARGET HOME ALREADY EXISTS",
        );
        return;
      }

      if (
        !isValidTransferRequestRecord(
          transferRequestSnap.val(),
          request,
        )
      ) {
        await finishRequest(
          snap.ref,
          "rejected",
          "TRANSFER REQUEST NOT FOUND",
        );
        return;
      }

      const homeData = asObject(oldHomeSnap.val());

      if (cleanText(homeData._ownerUid) !== oldOwnerUid) {
        await finishRequest(
          snap.ref,
          "rejected",
          "OWNER MISMATCH",
        );
        return;
      }

      const transferPlan = buildOwnerTransferUpdates({
        oldOwnerUid,
        newOwnerUid,
        homeId,
        homeData,
        sharedByHome: sharedByHomeSnap.val(),
        oldShareList: oldShareListSnap.val(),
        oldOwnerDirectory: oldOwnerDirectorySnap.val(),
        newOwnerOrder: newOwnerOrderSnap.val(),
        timestamp: now(),
      });

      await db.ref().update(transferPlan.updates);

      for (const deviceId of Object.keys(transferPlan.devices)) {
        deviceMap[deviceId] = {
          uid: newOwnerUid,
          homeId,
        };
      }

      const transferHomeName =
        cleanText(homeData.name) || homeId;
      const newOwnerAccount = asObject(newOwnerAccountSnap.val());
      const newOwnerProfile = asObject(newOwnerAccount.profile);
      const oldOwnerDirectory = asObject(oldOwnerDirectorySnap.val());
      const newOwnerName =
        cleanText(
          newOwnerProfile.name ||
            newOwnerAccount.name ||
            newOwnerAccount.email,
        ) || "Chủ nhà mới";
      const oldOwnerName =
        cleanText(oldOwnerDirectory.name || oldOwnerDirectory.email) ||
        "Chủ nhà cũ";
      const transferMessage =
        `${newOwnerName} đã trở thành chủ nhà của "${transferHomeName}".`;
      const transferData = {
        oldOwnerUid,
        oldOwnerName,
        newOwnerUid,
        newOwnerName,
        actorName: newOwnerName,
        homeName: transferHomeName,
      };

      await Promise.all([
        addHomeNotificationFromBackend({
          uid: oldOwnerUid,
          ownerUid: newOwnerUid,
          homeId,
          homeName: transferHomeName,
          type: "transfer_owner_accepted",
          category: "member",
          severity: "success",
          title: "Yêu cầu chuyển quyền chủ nhà",
          message: transferMessage,
          actorUid: newOwnerUid,
          entityType: "home",
          entityId: homeId,
          data: transferData,
        }),
        addHomeNotificationFromBackend({
          uid: newOwnerUid,
          ownerUid: newOwnerUid,
          homeId,
          homeName: transferHomeName,
          type: "transfer_owner_accepted",
          category: "member",
          severity: "success",
          title: "Yêu cầu chuyển quyền chủ nhà",
          message: transferMessage,
          actorUid: newOwnerUid,
          entityType: "home",
          entityId: homeId,
          data: transferData,
        }),
      ]);

      await finishRequest(snap.ref, "completed");

      log(
        "👑 TRANSFER OWNER COMPLETED:",
        oldOwnerUid,
        "→",
        newOwnerUid,
        homeId,
      );
    } catch (error) {
      log(
        "TRANSFER OWNER ACCEPT ERROR:",
        requestId,
        error.message,
      );

      try {
        const oldOwnerUid = cleanText(rawRequest?.oldOwnerUid);
        const newOwnerUid = cleanText(rawRequest?.newOwnerUid);
        const homeId = cleanText(rawRequest?.homeId);

        if (oldOwnerUid && newOwnerUid && homeId) {
          const failedHome =
            getCachedHomeData(oldOwnerUid, homeId) || {};
          const failedHomeName = cleanText(failedHome.name) || homeId;
          const failureData = {
            oldOwnerUid,
            newOwnerUid,
            homeName: failedHomeName,
            reason: cleanText(error.message || "UNKNOWN ERROR").slice(
              0,
              200,
            ),
          };

          await Promise.all([
            addHomeNotificationFromBackend({
              uid: oldOwnerUid,
              ownerUid: oldOwnerUid,
              homeId,
              homeName: failedHomeName,
              type: "transfer_owner_failed",
              category: "member",
              severity: "warning",
              title: "Yêu cầu chuyển quyền chủ nhà",
              message:
                `Không thể hoàn tất chuyển quyền chủ nhà "${failedHomeName}".`,
              actorUid: newOwnerUid,
              entityType: "home",
              entityId: homeId,
              data: failureData,
            }),
            addHomeNotificationFromBackend({
              uid: newOwnerUid,
              ownerUid: oldOwnerUid,
              homeId,
              homeName: failedHomeName,
              type: "transfer_owner_failed",
              category: "member",
              severity: "warning",
              title: "Yêu cầu chuyển quyền chủ nhà",
              message:
                `Không thể hoàn tất chuyển quyền chủ nhà "${failedHomeName}".`,
              actorUid: newOwnerUid,
              entityType: "home",
              entityId: homeId,
              data: failureData,
            }),
          ]);
        }
      } catch (notificationError) {
        log(
          "TRANSFER OWNER FAILURE NOTIFICATION ERROR:",
          notificationError.message,
        );
      }

      try {
        await finishRequest(
          snap.ref,
          "rejected",
          error.message || "UNKNOWN ERROR",
        );
      } catch (_) {}
    } finally {
      if (requestId) {
        transferOwnerAcceptInProgress.delete(requestId);
      }
    }
  }

  function stopHomeMembershipRuntime() {
    for (const timer of requestCleanupTimers) {
      clearTimeoutFn(timer);
    }

    const clearedTimers = requestCleanupTimers.size;
    requestCleanupTimers.clear();
    transferOwnerAcceptInProgress.clear();

    return clearedTimers > 0;
  }

  function getHomeMembershipRuntimeState() {
    return {
      inProgressRequests: transferOwnerAcceptInProgress.size,
      cleanupTimers: requestCleanupTimers.size,
    };
  }

  return {
    getCachedHomeAccess,
    getHomeMembershipRuntimeState,
    handleTransferOwnerAcceptRequest,
    isCachedHomeParticipant,
    stopHomeMembershipRuntime,
    verifyHomeParticipant,
  };
}

module.exports = {
  HOME_ROLE_RANK,
  TRANSFER_REQUEST_FUTURE_SKEW_MS,
  TRANSFER_REQUEST_MAX_AGE_MS,
  TRANSFER_RESULT_TTL_MS,
  buildOwnerTransferUpdates,
  createHomeMembershipDomain,
  hasHomeRole,
  isValidTransferRequestRecord,
  normalizeHomeOrder,
  normalizeHomeRole,
  normalizeTransferOwnerAcceptRequest,
  resolveCachedHomeAccess,
};
