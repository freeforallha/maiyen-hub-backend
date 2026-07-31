"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPresenceSessionCoordinator,
} = require("../domains/presence/presence_session");

function createCoordinator(overrides = {}) {
  const pushes = [];
  const coordinator = createPresenceSessionCoordinator({
    sendPushToUser: async (uid, message, label) => {
      pushes.push({ uid, message, label });
      return { sent: 1, failed: 0, targets: 1 };
    },
    accountSessionStaleMs: 100,
    iosStalePresenceMaxAgeMs: 1_000,
    monitoringHealthStaleMs: 500,
    recoveryTriggerAgeMs: 80,
    recoveryRetryCooldownMs: 50,
    recoveryGraceMs: 60,
    recoveryMaxAttempts: 2,
    ...overrides,
  });

  return { coordinator, pushes };
}

test("freshest signed-in session defines active, connected and platform state", () => {
  const { coordinator } = createCoordinator();
  const status = coordinator.getAccountSessionStatus(
    {
      sessions: {
        oldAndroid: {
          signedIn: true,
          connected: false,
          platform: "android",
          appState: "background",
          lastSeenAt: 900,
        },
        currentIos: {
          signedIn: true,
          connected: true,
          platform: "ios",
          appState: "foreground",
          lastSeenAt: 980,
        },
        signedOut: {
          signedIn: false,
          connected: true,
          lastSeenAt: 999,
        },
      },
    },
    1_000,
  );

  assert.equal(status.active, true);
  assert.equal(status.connected, true);
  assert.equal(status.platform, "ios");
  assert.equal(status.appState, "foreground");
  assert.equal(status.freshestSeenAt, 980);
  assert.equal(status.signedInSessionCount, 2);
});

test("stale and signed-out accounts receive deterministic session reasons", () => {
  const { coordinator } = createCoordinator();

  assert.equal(
    coordinator.getAccountSessionStatus(
      {
        sessions: {
          androidA: {
            signedIn: true,
            platform: "android",
            lastSeenAt: 800,
          },
        },
      },
      1_000,
    ).reason,
    "session_stale",
  );

  assert.equal(
    coordinator.getAccountSessionStatus(
      {
        sessions: {
          androidA: {
            signedIn: false,
            platform: "android",
            lastSeenAt: 990,
          },
        },
      },
      1_000,
    ).reason,
    "signed_out",
  );

  assert.equal(
    coordinator.getAccountSessionStatus({}, 1_000).reason,
    "legacy_session_missing",
  );
});

test("presence recovery candidate requires matching active installation session", () => {
  const { coordinator } = createCoordinator();
  const account = {
    activeSession: {
      installationId: "installA",
      sessionId: "sessionA",
    },
    sessions: {
      installA: {
        signedIn: true,
        sessionId: "sessionA",
        platform: "android",
        lastSeenAt: 123,
      },
    },
  };

  assert.deepEqual(
    coordinator.getPresenceRecoveryCandidate("userA", account),
    {
      uid: "userA",
      installationId: "installA",
      platform: "android",
      signedIn: true,
      lastSeenAt: 123,
    },
  );

  account.sessions.installA.sessionId = "other";
  assert.equal(
    coordinator.getPresenceRecoveryCandidate("userA", account),
    null,
  );
});

test("session context requests Android recovery once and exposes grace", async () => {
  const { coordinator, pushes } = createCoordinator();
  const accounts = {
    userA: {
      activeSession: {
        installationId: "installA",
        sessionId: "sessionA",
      },
      sessions: {
        installA: {
          signedIn: true,
          sessionId: "sessionA",
          platform: "android",
          lastSeenAt: 900,
        },
      },
    },
  };

  const first = await coordinator.prepareSessionContext(accounts, 1_000);

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].uid, "userA");
  assert.equal(pushes[0].label, "PRESENCE RECOVERY");
  assert.equal(pushes[0].message.data.type, "presence_recovery");
  assert.equal(first.recoveryGraceByUid.get("userA"), true);
  assert.match(first.logs[0], /PRESENCE RECOVERY REQUEST/);

  const second = await coordinator.prepareSessionContext(accounts, 1_020);
  assert.equal(pushes.length, 1);
  assert.equal(second.recoveryGraceByUid.get("userA"), true);
});

test("monitoring warnings normalize legacy blockers without making them fatal", () => {
  const { coordinator } = createCoordinator();
  const warnings = coordinator.normalizePresenceMonitoringWarnings({
    monitoringWarnings: {
      z_warning: true,
      ignored: false,
    },
    batteryUnrestricted: false,
    backgroundRestricted: true,
    autoStartConfirmed: false,
    monitoringBlockingReason: "battery_optimization_required",
  });

  assert.deepEqual(warnings, [
    "auto_start_recommended",
    "background_activity_restricted",
    "battery_optimization_recommended",
    "z_warning",
  ]);
  assert.deepEqual(
    coordinator.monitoringWarningsToFirebaseMap(warnings),
    {
      auto_start_recommended: true,
      background_activity_restricted: true,
      battery_optimization_recommended: true,
      z_warning: true,
    },
  );
  assert.equal(
    coordinator.getPresenceMonitoringAvailability({
      locationAlwaysGranted: true,
      monitoringAvailable: false,
    }),
    true,
  );
});

test("recent iOS geofence state survives stale session while Android becomes unknown", () => {
  const { coordinator } = createCoordinator();
  const accounts = {
    iosUser: {
      homePresence: {
        homeA: {
          ownerUid: "ownerA",
          homeId: "homeA",
          state: "inside",
          event: "enter",
          locationAlwaysGranted: true,
          lastConfirmedAt: 950,
          updatedAt: 950,
        },
      },
    },
    androidUser: {
      homePresence: {
        homeA: {
          ownerUid: "ownerA",
          homeId: "homeA",
          state: "outside",
          event: "exit",
          locationAlwaysGranted: true,
          lastConfirmedAt: 950,
          updatedAt: 950,
        },
      },
    },
  };

  const ios = coordinator.getMemberPresenceStatus(
    accounts,
    "iosUser",
    "ownerA",
    "homeA",
    {
      active: false,
      platform: "ios",
      signedInSessionCount: 1,
      freshestSeenAt: 950,
      reason: "session_stale",
    },
    1_000,
  );
  const android = coordinator.getMemberPresenceStatus(
    accounts,
    "androidUser",
    "ownerA",
    "homeA",
    {
      active: false,
      platform: "android",
      signedInSessionCount: 1,
      freshestSeenAt: 950,
      reason: "session_stale",
    },
    1_000,
  );

  assert.equal(ios.state, "inside");
  assert.equal(ios.staleIosPresenceAllowed, true);
  assert.equal(android.state, "unknown");
  assert.equal(android.needsSessionCleanup, true);
});

test("fresh login does not reuse a signed-out presence marker", () => {
  const { coordinator } = createCoordinator();
  const accounts = {
    userA: {
      homePresence: {
        homeA: {
          ownerUid: "ownerA",
          homeId: "homeA",
          state: "inside",
          event: "signed_out",
          monitoringBlockingReason: "signed_out",
          locationAlwaysGranted: true,
          updatedAt: 990,
        },
      },
    },
  };

  const status = coordinator.getMemberPresenceStatus(
    accounts,
    "userA",
    "ownerA",
    "homeA",
    {
      active: true,
      connected: true,
      platform: "android",
      signedInSessionCount: 1,
      freshestSeenAt: 1_000,
    },
    1_000,
  );

  assert.equal(status.reactivatedAfterSignedOut, true);
  assert.equal(status.state, "unknown");
  assert.equal(status.unknownWhileMonitored, true);
  assert.equal(status.needsSessionCleanup, false);
});

test("monitoring health becomes stale without discarding a valid known state", () => {
  const { coordinator } = createCoordinator();
  const accounts = {
    userA: {
      homePresence: {
        homeA: {
          ownerUid: "ownerA",
          homeId: "homeA",
          state: "outside",
          event: "exit",
          locationAlwaysGranted: true,
          lastConfirmedAt: 100,
          updatedAt: 100,
        },
      },
    },
  };

  const status = coordinator.getMemberPresenceStatus(
    accounts,
    "userA",
    "ownerA",
    "homeA",
    {
      active: true,
      connected: false,
      platform: "android",
      signedInSessionCount: 1,
      freshestSeenAt: 1_000,
    },
    1_000,
  );

  assert.equal(status.state, "outside");
  assert.equal(status.eligibleForArming, true);
  assert.equal(status.monitoringHealth, "stale");
  assert.equal(status.monitoringHealthReason, "no_recent_confirmation");
});
