'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { resolveMessaging } = require('../server/messaging');

function forbidden(operation) {
  return () => assert.fail(`Unexpected operation: ${operation}`);
}

function application(name, projectId) {
  return {
    name,
    options: {
      projectId,
      get credential() {
        assert.fail('The test must not access the app credential');
      },
    },
  };
}

function messagingFor(app) {
  return {
    app,
    send: forbidden('FCM send'),
    sendEachForMulticast: forbidden('FCM multicast send'),
  };
}

function resolve(strapi, config, admin = {}, env = {}) {
  return resolveMessaging({
    strapi,
    config,
    admin: {
      getApps: admin.getApps ?? forbidden('read the Admin app registry'),
      getMessaging: admin.getMessaging ?? forbidden('get the Admin Messaging client'),
      initializeApp: forbidden('initialize a second Firebase app'),
    },
    env,
  });
}

test('reuses the Firebase Authentication Messaging client without push configuration', () => {
  const app = application('[DEFAULT]', 'example-auth-project');
  const client = messagingFor(app);
  let lookups = 0;
  const firebase = {
    app: () => app,
    messaging() {
      assert.equal(this, firebase);
      lookups += 1;
      return client;
    },
  };
  assert.equal(resolve({ firebase }), client);
  assert.equal(lookups, 1);
});

test('uses Firebase Authentication after application-level project verification', () => {
  const app = application('[DEFAULT]', 'example-expected-project');
  const client = messagingFor(app);
  assert.equal(
    resolve({
      firebaseProjectVerified: true,
      firebase: { app: () => app, messaging: () => client },
    }, {
      projectId: 'example-expected-project',
      isProjectVerified: (strapi) => strapi.firebaseProjectVerified === true,
    }),
    client,
  );
});

test('an Auth emulator blocks FCM before accessing the client', () => {
  assert.throws(() => resolve({
    firebase: { messaging: forbidden('get Messaging from an emulated Auth instance') },
  }, { projectId: 'example-expected-project' }, {}, { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }), {
    code: 'FCM_EMULATOR',
  });
});

test('fallback reuses the only initialized Firebase Admin app', () => {
  const app = application('[DEFAULT]', 'fallback-fixture');
  const client = messagingFor(app);
  assert.equal(resolve({}, { projectId: 'fallback-fixture' }, {
    getApps: () => [app],
    getMessaging: (selected) => {
      assert.equal(selected, app);
      return client;
    },
  }), client);
});

test('fallback requires an explicit name when multiple apps exist', () => {
  const apps = [
    application('[DEFAULT]', 'example-other-project'),
    application('push', 'example-selected-project'),
  ];
  const client = messagingFor(apps[1]);
  assert.throws(() => resolve({}, { projectId: 'example-selected-project' }, {
    getApps: () => apps,
  }), { code: 'FCM_AMBIGUOUS_APP' });

  assert.equal(resolve({}, { projectId: 'example-selected-project', appName: 'push' }, {
    getApps: () => apps,
    getMessaging: (selected) => {
      assert.equal(selected, apps[1]);
      return client;
    },
  }), client);
});

test('rejects an unknown app name without selecting another app', () => {
  assert.throws(() => resolve({}, { projectId: 'fixture', appName: 'missing-app' }, {
    getApps: () => [application('[DEFAULT]', 'fixture')],
  }), { code: 'FCM_APP_NOT_FOUND' });
});

test('returns a configuration error when no app is initialized', () => {
  assert.throws(() => resolve({}, { projectId: 'fixture' }, {
    getApps: () => [],
  }), { code: 'FCM_NOT_CONFIGURED' });
});

test('rejects a mismatched Admin project before creating a Messaging client', () => {
  assert.throws(() => resolve({}, { projectId: 'example-expected-project' }, {
    getApps: () => [application('[DEFAULT]', 'example-auth-project')],
  }), { code: 'FCM_PROJECT_MISMATCH' });
});

test('blocks Firebase access until the project is verified', () => {
  const strapi = {
    firebaseProjectVerified: false,
    get firebase() {
      assert.fail('Firebase must not be accessed before project verification');
    },
  };
  assert.throws(() => resolve(strapi, {
    projectId: 'example-expected-project',
    isProjectVerified: (app) => app.firebaseProjectVerified === true,
  }), { code: 'FCM_PROJECT_UNVERIFIED' });
});

test('a mismatched Firebase Authentication project blocks Messaging and fallback', () => {
  const app = application('[DEFAULT]', 'example-auth-project');
  assert.throws(() => resolve({
    firebaseProjectVerified: true,
    firebase: {
      app: () => app,
      messaging: forbidden('get Messaging from the mismatched project'),
    },
  }, {
    projectId: 'example-expected-project',
    isProjectVerified: (strapi) => strapi.firebaseProjectVerified === true,
  }), { code: 'FCM_PROJECT_MISMATCH' });
});

test('requires an expected project ID for standalone Firebase Admin', () => {
  assert.throws(() => resolve({}, {}), { code: 'FCM_PROJECT_REQUIRED' });
});

test('falls back to an initialized Admin app when Auth is unavailable', () => {
  const app = application('push', 'fallback-fixture');
  const client = messagingFor(app);
  assert.equal(resolve({
    firebase: {
      messaging() {
        throw new Error('Firebase Authentication is not ready');
      },
    },
  }, { projectId: 'fallback-fixture', appName: 'push' }, {
    getApps: () => [app],
    getMessaging: (selected) => {
      assert.equal(selected, app);
      return client;
    },
  }), client);
});

test('checks the in-memory credential project ID without requesting a token', () => {
  const app = {
    name: '[DEFAULT]',
    options: {
      credential: {
        projectId: 'fixture-cert',
        getAccessToken: forbidden('request an OAuth token'),
      },
    },
  };
  const client = messagingFor(app);
  assert.equal(resolve({
    firebase: { app: () => app, messaging: () => client },
  }, { projectId: 'fixture-cert' }), client);
});

test('the service reads the plugin configuration when called', () => {
  const plugin = require('../server');
  const app = application('[DEFAULT]', 'example-auth-project');
  const client = messagingFor(app);
  const strapi = {
    firebase: { app: () => app, messaging: () => client },
    plugin(name) {
      assert.equal(name, 'firebase-push');
      const config = { projectId: 'example-auth-project' };
      return { config: (key) => config[key] };
    },
  };
  assert.equal(plugin.services.messaging({ strapi }).getClient(), client);
});
