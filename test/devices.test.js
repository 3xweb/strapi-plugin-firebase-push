'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createDeviceService } = require('../server/devices');

const PROJECT = 'verified-firebase-fixture';
const TENANT = 'fixture-workspace';
const INSTALLATION = '757308d0-49b8-4bf3-846a-3661c5b5f659';
const TOKEN = 'fixture-fcm-token-should-never-be-persisted-0123456789';
const OTHER_TOKEN = 'other-fixture-fcm-token-should-never-be-persisted-9876543210';

function key(byte) {
  return Buffer.alloc(32, byte).toString('base64');
}

function configuration(overrides = {}) {
  return {
    projectId: PROJECT,
    enabled: true,
    resolveScope: () => ({ tenantId: TENANT, projectId: PROJECT }),
    hashKey: key(7),
    encryptionKey: key(17),
    encryptionKeyId: 'fixture-key-1',
    ...overrides,
  };
}

function context({ userId = 41, body = {}, installationId = INSTALLATION } = {}) {
  return {
    state: {
      user: userId === null ? undefined : { id: userId },
      auth: { strategy: { name: 'users-permissions' } },
    },
    request: { body },
    params: { installationId },
    throw(status, message) {
      throw Object.assign(new Error(message), { status });
    },
  };
}

function forbidden(operation) {
  return () => assert.fail(`Unexpected operation: ${operation}`);
}

test('registration is opt-in and anonymous callers cannot access storage', async () => {
  const stub = { register: forbidden('writing without configuration or authentication') };
  const body = { token: TOKEN, installationId: INSTALLATION };
  const disabled = createDeviceService({ strapi: {}, config: configuration({ enabled: false }), store: stub });
  await assert.rejects(async () => disabled.register(context({ body })), { status: 503 });

  const enabled = createDeviceService({ strapi: {}, config: configuration(), store: stub });
  await assert.rejects(async () => enabled.register(context({ userId: null, body })), { status: 401 });
});

test('rejects mismatched project before persisting', async () => {
  const service = createDeviceService({
    strapi: {},
    config: configuration({
      projectId: PROJECT,
      resolveScope: () => ({ tenantId: TENANT, projectId: 'outro-projeto' }),
    }),
    store: { register: forbidden('writing in the wrong project') },
  });
  await assert.rejects(async () => service.register(context({
    body: { token: TOKEN, installationId: INSTALLATION },
  })), { status: 403 });
});

function memoryStore() {
  const rows = new Map();
  const index = (scope, installation) => `${scope}:${installation}`;
  return {
    rows,
    async register(row) {
      const id = index(row.scope_hash, row.installation_hash);
      const previous = rows.get(id);
      if (previous && previous.owner_id !== row.owner_id) return false;
      rows.set(id, { ...row, revoked_at: null });
      return true;
    },
    async revoke({ scopeHash, ownerId, installationHash }) {
      const existing = rows.get(index(scopeHash, installationHash));
      if (existing?.owner_id === ownerId) existing.revoked_at = new Date(0);
    },
    async listActive({ scopeHash, ownerIds }) {
      return [...rows.values()].filter((row) =>
        row.scope_hash === scopeHash && ownerIds.includes(row.owner_id) && !row.revoked_at,
      );
    },
  };
}

function register(service, { userId, token = TOKEN, installationId = INSTALLATION, extra } = {}) {
  return service.register(context({ userId, body: { token, installationId, ...extra } }));
}

test('retry keeps stable hashes and rotates the encrypted envelope', async () => {
  const store = memoryStore();
  const old = createDeviceService({ strapi: {}, config: configuration(), store });
  await register(old, { extra: { ownerId: 999 } });
  const before = { ...[...store.rows.values()][0] };
  assert.equal(String(before.owner_id), '41');
  assert.ok(before.encrypted_token);
  assert.ok(before.token_hash);
  assert.equal(before.encryption_key_id, 'fixture-key-1');
  assert.equal(JSON.stringify(before).includes(TOKEN), false);
  assert.equal(JSON.stringify(before).includes(INSTALLATION), false);

  const rotated = createDeviceService({
    strapi: {},
    config: configuration({ encryptionKey: key(18), encryptionKeyId: 'fixture-key-2' }),
    store,
  });
  await register(rotated);
  assert.equal(store.rows.size, 1);
  const after = [...store.rows.values()][0];
  assert.equal(after.installation_hash, before.installation_hash);
  assert.equal(after.token_hash, before.token_hash);
  assert.notEqual(after.encrypted_token, before.encrypted_token);
  assert.equal(after.encryption_key_id, 'fixture-key-2');
  assert.equal(JSON.stringify(after).includes(TOKEN), false);
});

test('another user cannot claim or revoke the installation', async () => {
  const store = memoryStore();
  const service = createDeviceService({ strapi: {}, config: configuration(), store });
  await register(service);
  await assert.rejects(async () => register(service, {
    userId: 99, token: OTHER_TOKEN,
  }), { status: 409 });
  await service.revoke(context({ userId: 99 }));
  const recorded = [...store.rows.values()][0];
  assert.equal(String(recorded.owner_id), '41');
  assert.equal(recorded.revoked_at, null);

  await service.revoke(context());
  assert.notEqual(recorded.revoked_at, null);
  await service.revoke(context());
  assert.equal(store.rows.size, 1);
});

test('adapts a path-based registration and leaves account policy in the host', async () => {
  const store = memoryStore();
  const service = createDeviceService({ strapi: {}, config: configuration(), store });
  const legacy = context({ body: {
    token: TOKEN, platform: 'android', locale: 'pt-BR', appVersion: '1.0.0',
  } });
  async function pathRegistrationAdapter(ctx, active) {
    if (!active) ctx.throw(403, 'account-deletion-pending');
    const { token } = ctx.request.body;
    return service.register(context({
      userId: ctx.state.user.id,
      body: { token, installationId: ctx.params.installationId },
    }));
  }
  await assert.rejects(() => pathRegistrationAdapter(legacy, false), { status: 403 });
  assert.equal(store.rows.size, 0);
  await pathRegistrationAdapter(legacy, true);
  assert.equal(store.rows.size, 1);
});

test('adapts a body-based registration and leaves consent in the host', async () => {
  const store = memoryStore();
  const service = createDeviceService({ strapi: {}, config: configuration(), store });
  const legacy = context({ body: {
    installation: INSTALLATION, token: TOKEN, platform: 'android', permission: 'granted',
  } });
  async function bodyRegistrationAdapter(ctx, enabled) {
    const { installation, token, permission } = ctx.request.body;
    if (!enabled || permission !== 'granted') ctx.throw(403, 'Notifications not authorized');
    return service.register(context({
      userId: ctx.state.user.id,
      body: { token, installationId: installation },
    }));
  }
  await assert.rejects(() => bodyRegistrationAdapter(legacy, false), { status: 403 });
  assert.equal(store.rows.size, 0);
  await bodyRegistrationAdapter(legacy, true);
  assert.equal(store.rows.size, 1);
});

test('internal send uses only active devices for the target user and scope', async () => {
  const store = memoryStore();
  const seen = [];
  const getClient = () => ({
    async send(payload) {
      seen.push(payload.token);
      return 'mock-id-accepted';
    },
    async sendEachForMulticast(payload) {
      seen.push(...payload.tokens);
      return { successCount: payload.tokens.length, failureCount: 0 };
    },
  });
  const config = configuration();
  const service = createDeviceService({ strapi: {}, config, store, getClient });
  const revokedInstallation = 'cbb72bcc-d0ff-444c-af7c-3fb68d063238';
  await register(service);
  await register(service, {
    userId: 99, token: OTHER_TOKEN, installationId: 'ea191306-b62e-4644-9750-b6d06b200092',
  });
  await register(service, {
    token: 'revoked-fixture-fcm-token-0123456789012345678901',
    installationId: revokedInstallation,
  });
  await service.revoke(context({ installationId: revokedInstallation }));
  const anotherTenant = createDeviceService({
    strapi: {},
    config: configuration({
      resolveScope: () => ({ tenantId: 'other-tenant', projectId: PROJECT }),
    }),
    store,
    getClient,
  });
  await register(anotherTenant, {
    token: 'other-tenant-fixture-fcm-token-01234567890123456',
    installationId: 'bcdc38aa-26bb-4532-8e7e-2687533c3a00',
  });

  const result = await service.sendToUser({
    tenantId: TENANT, userId: 41, message: { notification: { title: 'Test', body: 'Synthetic message' } },
  });
  assert.deepEqual(seen, [TOKEN]);
  assert.deepEqual(result, { accepted: 1, failed: 0 });
  seen.length = 0;
  const batch = await service.sendToUsers({
    tenantId: TENANT, userIds: [41, 99, '41'], message: { data: { type: 'test' } },
  });
  assert.deepEqual(seen.sort(), [TOKEN, OTHER_TOKEN].sort());
  assert.deepEqual(batch, { accepted: 2, failed: 0 });
  await assert.rejects(() => service.sendToUsers({
    tenantId: TENANT, userIds: [41, null], message: { data: { type: 'test' } },
  }), { code: 'FCM_INVALID_MESSAGE' });
  assert.equal(seen.length, 2);
});

test('storage and transport failures do not return tokens', async () => {
  const store = memoryStore();
  const service = createDeviceService({
    strapi: {},
    config: configuration(),
    store,
    getClient: () => ({
      async sendEachForMulticast() {
        throw new Error(`fixture provider error containing ${TOKEN}`);
      },
    }),
  });
  await register(service);
  const result = await service.sendToUser({
    tenantId: TENANT, userId: 41, message: { notification: { title: 'Fixture' } },
  });
  assert.deepEqual(result, { accepted: 0, failed: 1 });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);

  store.register = async () => { throw new Error(`fixture DB error containing ${TOKEN}`); };
  await assert.rejects(() => register(service), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('API tokens, blocked users and explicit send recipients are rejected', async () => {
  const service = createDeviceService({
    strapi: {},
    config: configuration(),
    store: { register: forbidden('persisting a device'), listActive: forbidden('listing recipients') },
  });
  const body = { token: TOKEN, installationId: INSTALLATION };
  const apiToken = context({ body });
  apiToken.state.auth.strategy.name = 'api-token';
  await assert.rejects(() => service.register(apiToken), { status: 401 });

  const blocked = context({ body });
  blocked.state.user.blocked = true;
  await assert.rejects(() => service.register(blocked), { status: 401 });
  await assert.rejects(() => service.sendToUser({
    tenantId: TENANT, userId: 41, message: { token: TOKEN },
  }), { status: 400 });
});

test('exposes only device registration and revocation in the Content API', async () => {
  const plugin = require('../server');
  assert.equal(plugin.config.default.devices.enabled, false);
  assert.equal(plugin.routes['content-api'].type, 'content-api');
  assert.deepEqual(plugin.routes['content-api'].routes.map(({ method, path }) => [method, path]), [
    ['POST', '/devices'],
    ['DELETE', '/devices/:installationId'],
  ]);

  const calls = [];
  const strapi = {
    plugin: () => ({
      service: () => ({
        async register(ctx) { calls.push(['register', ctx]); },
        async revoke(ctx) { calls.push(['revoke', ctx]); },
      }),
    }),
  };
  const controller = plugin.controllers.devices({ strapi });
  const registration = context({ body: { token: TOKEN, installationId: INSTALLATION } });
  const revocation = context();
  await controller.register(registration);
  await controller.revoke(revocation);
  assert.deepEqual(calls, [['register', registration], ['revoke', revocation]]);
  assert.equal(registration.status, 204);
  assert.equal(revocation.status, 204);
  assert.equal(registration.body, undefined);
  assert.equal(revocation.body, undefined);
});
