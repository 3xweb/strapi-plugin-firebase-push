"use strict";

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function assertProject(app, expectedProjectId) {
  // A certificate initialized without options.projectId retains the identifier
  // on the in-memory credential. Access only that identifier.
  const projectId = app?.options?.projectId || app?.options?.credential?.projectId;
  if (projectId !== expectedProjectId) {
    fail("FCM_PROJECT_MISMATCH", "Could not verify the configured Firebase project.");
  }
}

function authMessaging(firebase, projectId) {
  if (typeof firebase?.messaging !== "function") return undefined;

  if (projectId && typeof firebase.app === "function") {
    let app;
    try {
      app = firebase.app();
    } catch {
      return undefined;
    }
    if (!app) return undefined;
    if (projectId) assertProject(app, projectId);
  }

  try {
    return firebase.messaging();
  } catch {
    return undefined;
  }
}

function resolveMessaging({ strapi, config = {}, admin, env = process.env }) {
  const projectId = typeof config.projectId === "string" ? config.projectId.trim() : "";
  if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIREBASE_MESSAGING_EMULATOR_HOST) {
    fail("FCM_EMULATOR", "The FCM client is unavailable while a Firebase emulator is configured.");
  }
  if (config.isProjectVerified !== undefined) {
    let verified = false;
    try {
      if (typeof config.isProjectVerified === "function") {
        verified = config.isProjectVerified(strapi) === true;
      }
    } catch {
      fail("FCM_PROJECT_UNVERIFIED", "The application has not verified the Firebase project.");
    }
    if (!verified) {
      fail("FCM_PROJECT_UNVERIFIED", "The application has not verified the Firebase project.");
    }
  }

  const ready = authMessaging(strapi.firebase, projectId);
  if (ready) {
    if (projectId) assertProject(ready.app, projectId);
    return ready;
  }

  if (!projectId) {
    fail("FCM_PROJECT_REQUIRED", "Set the expected Firebase project ID.");
  }

  if (!projectId) {
    fail("FCM_PROJECT_REQUIRED", "Configure the expected Firebase project ID for the Admin fallback.");
  }

  const getApps = admin ? admin.getApps : require("firebase-admin/app").getApps;
  const apps = getApps();
  if (!apps.length) {
    fail("FCM_NOT_CONFIGURED", "No Firebase Admin app has been initialized.");
  }
  if (config.appName === undefined && apps.length !== 1) {
    fail("FCM_AMBIGUOUS_APP", "Set appName to select a Firebase Admin app.");
  }
  const app = config.appName === undefined
    ? apps[0]
    : apps.find((candidate) => candidate.name === config.appName);
  if (!app) {
    fail("FCM_APP_NOT_FOUND", "The configured Firebase Admin app was not found.");
  }
  assertProject(app, projectId);

  try {
    const getMessaging = admin ? admin.getMessaging : require("firebase-admin/messaging").getMessaging;
    const messaging = getMessaging(app);
    if (messaging) {
      return messaging;
    }
  } catch {
    fail("FCM_MESSAGING_UNAVAILABLE", "The Firebase Messaging client is unavailable.");
  }
  fail("FCM_MESSAGING_UNAVAILABLE", "The Firebase Messaging client is unavailable.");
}

module.exports = { resolveMessaging };
