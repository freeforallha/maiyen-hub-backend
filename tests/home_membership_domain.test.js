"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildOwnerTransferUpdates,
  createHomeMembershipDomain,
  hasHomeRole,
  normalizeHomeOrder,
  normalizeHomeRole,
  normalizeTransferOwnerAcceptRequest,
  resolveCachedHomeAccess,
} = require("../domains/home/home_membership");

function createSnapshot(path, value, exists = value != null) {
  return {
    key: path.split("/").filter(Boolean).at(-1) || null,
    exists() {
      return exists;
    },
    val() {
      return value;
    },
  };
}

function createFakeDb(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  const rootUpdates = [];

  function ref(path = "") {
    const cleanPath = String(path || "");

    return {
      async once() {
        return createSnapshot(
          cleanPath,
          values.get(cleanPath),
          values.has(cleanPath) && values.get(cleanPath) != null,
        );
      },
      async update(updateValue) {
        if (!cleanPath) {
          rootUpdates.push(updateValue);
          for (const [key, value] of Object.entries(updateValue)) {
            if (value == null) values.delete(key);
            else values.set(key, value);
          }
          return;
        }

        const current = values.get(cleanPath);
        values.set(cleanPath, {
          ...(current && typeof current === "object" ? current : {}),
          ...updateValue,
        });
      },
      async remove() {
        values.delete(cleanPath);
      },
    };
  }

  return {
    db: { ref },
    rootUpdates,
    values,
  };
}

function createRequestSnapshot(requestId, request) {
  const updates = [];
  let removed = 0;

  return {
    key: requestId,
    val() {
      return request;
    },
    ref: {
      async update(value) {
        updates.push(value);
      },
      async remove() {
        removed += 1;
      },
    },
    get updates() {
      return updates;
    },
    get removed() {
      return removed;
    },
  };
}

test("Home roles and minimum permissions normalize deterministically", () => {
  assert.equal(normalizeHomeRole("OWNER"), "owner");
  assert.equal(normalizeHomeRole("admin"), "admin");
  assert.equal(normalizeHomeRole("guest"), "none");
  assert.equal(hasHomeRole("owner", "admin"), true);
  assert.equal(hasHomeRole("member", "admin"), false);
});

test("Home order accepts arrays and numeric-keyed objects", () => {
  assert.deepEqual(normalizeHomeOrder(["h2", null, "h1"]), ["h2", "h1"]);
  assert.deepEqual(
    normalizeHomeOrder({ 2: "h3", 0: "h1", 1: "h2" }),
    ["h1", "h2", "h3"],
  );
});

test("cached membership distinguishes Owner, shared Admin and stale links", () => {
  assert.deepEqual(
    resolveCachedHomeAccess({
      requesterUid: "owner",
      homeId: "h1",
      requesterAccount: { homes: { h1: { name: "Home" } } },
      sharedMembers: {},
    }),
    {
      allowed: true,
      ownerUid: "owner",
      role: "owner",
      source: "owned_home",
    },
  );

  assert.equal(
    resolveCachedHomeAccess({
      requesterUid: "admin",
      homeId: "h1",
      requesterAccount: {
        sharedHomes: { h1: { ownerUid: "owner", role: "member" } },
      },
      sharedMembers: { admin: { role: "admin" } },
    }).role,
    "admin",
  );

  assert.equal(
    resolveCachedHomeAccess({
      requesterUid: "member",
      homeId: "h1",
      requesterAccount: {
        sharedHomes: { h1: { ownerUid: "owner" } },
      },
      sharedMembers: {},
    }).allowed,
    false,
  );
});

test("ownership acceptance requires a fresh request from the new Owner", () => {
  const now = 1_000_000;

  assert.equal(
    normalizeTransferOwnerAcceptRequest(
      {
        status: "pending",
        requestedByUid: "new",
        oldOwnerUid: "old",
        newOwnerUid: "new",
        homeId: "h1",
        time: now,
      },
      "r1",
      now,
    ).valid,
    true,
  );

  assert.equal(
    normalizeTransferOwnerAcceptRequest(
      {
        status: "pending",
        requestedByUid: "old",
        oldOwnerUid: "old",
        newOwnerUid: "new",
        homeId: "h1",
        time: now,
      },
      "r1",
      now,
    ).valid,
    false,
  );
});

test("ownership transfer updates every Home, member and device index", () => {
  const result = buildOwnerTransferUpdates({
    oldOwnerUid: "old",
    newOwnerUid: "new",
    homeId: "h1",
    homeData: {
      _ownerUid: "old",
      name: "My Home",
      devices: { d1: {}, d2: {} },
      alarmPauseToday: { date: "2026-07-31" },
    },
    sharedByHome: {
      new: { role: "admin" },
      member: { role: "member", name: "M" },
    },
    oldShareList: {
      member: { email: "m@example.com" },
    },
    oldOwnerDirectory: {
      email: "old@example.com",
      name: "Old",
    },
    newOwnerOrder: { 0: "h0" },
    timestamp: 123,
  });

  assert.equal(
    result.updates["accounts/new/homes/h1"]._ownerUid,
    "new",
  );
  assert.equal(
    result.updates["accounts/old/sharedHomes/h1"].ownerUid,
    "new",
  );
  assert.equal(
    result.updates["accounts/member/sharedHomes/h1/ownerUid"],
    "new",
  );
  assert.equal(result.updates["system/devices_by_ieee/d1/uid"], "new");
  assert.deepEqual(result.newOwnerOrder, ["h0", "h1"]);
});

test("participant verification uses cache first and database fallback safely", async () => {
  const { db } = createFakeDb({
    "accounts/member/sharedHomes/h1": { ownerUid: "owner" },
    "sharedByHome/h1/member": { role: "member" },
  });
  const domain = createHomeMembershipDomain({
    db,
    deviceMap: {},
    getCachedAccountData: () => null,
    getCachedHomeData: () => null,
    getSharedMembersForHome: () => ({}),
    addHomeNotificationFromBackend: async () => {},
  });

  assert.equal(
    await domain.verifyHomeParticipant({
      requesterUid: "member",
      ownerUid: "owner",
      homeId: "h1",
    }),
    true,
  );
  assert.equal(
    await domain.verifyHomeParticipant({
      requesterUid: "outsider",
      ownerUid: "owner",
      homeId: "h1",
    }),
    false,
  );
});

test("valid ownership transfer is atomic and notifies both Owners", async () => {
  const now = 2_000_000;
  const requestId = "accept_1";
  const request = {
    status: "pending",
    requestedByUid: "new",
    oldOwnerUid: "old",
    newOwnerUid: "new",
    homeId: "h1",
    time: now,
  };
  const { db, rootUpdates } = createFakeDb({
    "accounts/old/homes/h1": {
      _ownerUid: "old",
      name: "Home One",
      devices: { d1: {} },
    },
    "accounts/new/shareRequests/transfer_h1_old": {
      type: "transfer_owner_request",
      homeId: "h1",
      oldOwnerUid: "old",
      newOwnerUid: "new",
    },
    "sharedByHome/h1": {
      new: { role: "admin" },
      member: { role: "member" },
    },
    "accounts/old/shareList/h1": {
      member: { role: "member" },
    },
    "userDirectory/old": {
      name: "Old Owner",
      email: "old@example.com",
    },
    "accounts/new": {
      profile: { name: "New Owner" },
    },
    "accounts/new/homeOrder": ["h0"],
  });
  const deviceMap = {};
  const notifications = [];
  const requestSnap = createRequestSnapshot(requestId, request);
  const timers = [];
  const domain = createHomeMembershipDomain({
    db,
    deviceMap,
    getCachedAccountData: () => null,
    getCachedHomeData: () => null,
    getSharedMembersForHome: () => ({}),
    addHomeNotificationFromBackend: async (payload) => {
      notifications.push(payload);
    },
    now: () => now,
    setTimeoutFn(callback) {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn() {},
  });

  await domain.handleTransferOwnerAcceptRequest(requestSnap);

  assert.equal(rootUpdates.length, 1);
  assert.equal(rootUpdates[0]["accounts/new/homes/h1"]._ownerUid, "new");
  assert.deepEqual(deviceMap.d1, { uid: "new", homeId: "h1" });
  assert.deepEqual(
    notifications.map((item) => item.uid).sort(),
    ["new", "old"],
  );
  assert.equal(requestSnap.updates.at(-1).status, "completed");
  assert.equal(timers.length, 1);
});

test("missing canonical transfer request is rejected before any root update", async () => {
  const now = 3_000_000;
  const requestSnap = createRequestSnapshot("accept_2", {
    status: "pending",
    requestedByUid: "new",
    oldOwnerUid: "old",
    newOwnerUid: "new",
    homeId: "h1",
    time: now,
  });
  const { db, rootUpdates } = createFakeDb({
    "accounts/old/homes/h1": {
      _ownerUid: "old",
    },
    "accounts/new": {
      profile: { name: "New" },
    },
  });
  const domain = createHomeMembershipDomain({
    db,
    deviceMap: {},
    getCachedAccountData: () => null,
    getCachedHomeData: () => null,
    getSharedMembersForHome: () => ({}),
    addHomeNotificationFromBackend: async () => {},
    now: () => now,
    setTimeoutFn: () => ({}),
    clearTimeoutFn() {},
  });

  await domain.handleTransferOwnerAcceptRequest(requestSnap);

  assert.equal(rootUpdates.length, 0);
  assert.equal(requestSnap.updates.at(-1).status, "rejected");
  assert.equal(
    requestSnap.updates.at(-1).error,
    "TRANSFER REQUEST NOT FOUND",
  );
});

test("membership runtime stop clears pending result timers", async () => {
  const { db } = createFakeDb();
  const cleared = [];
  const domain = createHomeMembershipDomain({
    db,
    deviceMap: {},
    getCachedAccountData: () => null,
    getCachedHomeData: () => null,
    getSharedMembersForHome: () => ({}),
    addHomeNotificationFromBackend: async () => {},
    now: () => 100,
    setTimeoutFn: () => ({ id: 1 }),
    clearTimeoutFn: (timer) => cleared.push(timer),
  });
  const requestSnap = createRequestSnapshot("bad", {
    status: "pending",
    requestedByUid: "",
  });

  await domain.handleTransferOwnerAcceptRequest(requestSnap);
  assert.equal(domain.getHomeMembershipRuntimeState().cleanupTimers, 1);
  domain.stopHomeMembershipRuntime();
  assert.equal(domain.getHomeMembershipRuntimeState().cleanupTimers, 0);
  assert.equal(cleared.length, 1);
});
