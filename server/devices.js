"use strict";

const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require("node:crypto");
const { createDeviceStore } = require("./device-store");

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function unavailable() {
  fail(503, "FCM_DEVICES_UNAVAILABLE", "The device registry is unavailable.");
}

function key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) unavailable();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) unavailable();
  return decoded;
}

function identifier(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(value) ? value : undefined;
}

function installation(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{8,180}$/.test(value)) {
    fail(400, "FCM_INVALID_DEVICE", "Invalid device installation.");
  }
  return value;
}

function digest(secret, ...values) {
  return createHmac("sha256", secret).update(JSON.stringify(values)).digest("hex");
}

function aad(row) {
  return JSON.stringify([row.scope_hash, row.owner_id, row.installation_hash, row.token_hash, row.encryption_key_id]);
}

function encrypt(token, secret, row) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(aad(row)));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function decrypt(value, secret, row) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad(row)));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

function createDeviceService({ strapi, config, store, getClient }) {
  function settings() {
    if (config?.enabled !== true || typeof config.resolveScope !== "function") unavailable();
    const encryptionKeyId = identifier(config.encryptionKeyId);
    const projectId = identifier(config.projectId);
    if (!encryptionKeyId || !projectId) unavailable();
    const hashKey = key(config.hashKey);
    const encryptionKey = key(config.encryptionKey);
    if (hashKey.equals(encryptionKey)) unavailable();
    return { encryptionKeyId, projectId, hashKey, encryptionKey, store: store ?? createDeviceStore(strapi) };
  }

  async function session(ctx, options) {
    const ownerId = identifier(ctx.state?.user?.id);
    if (
      !ownerId || ctx.state.user.blocked === true ||
      ctx.state.auth?.strategy?.name !== "users-permissions"
    ) {
      fail(401, "FCM_DEVICE_UNAUTHENTICATED", "An authenticated user session is required.");
    }
    let scope;
    try {
      const verified = config.isProjectVerified === undefined || config.isProjectVerified(strapi) === true;
      if (verified) scope = await config.resolveScope(ctx, { strapi });
    } catch {
      fail(403, "FCM_DEVICE_SCOPE_DENIED", "Device access is unavailable for this context.");
    }
    const tenantId = identifier(scope?.tenantId);
    if (!tenantId || scope.projectId !== options.projectId) {
      fail(403, "FCM_DEVICE_SCOPE_DENIED", "Device access is unavailable for this context.");
    }
    return { ownerId, scopeHash: digest(options.hashKey, "scope", tenantId, options.projectId) };
  }

  async function sendToUsers({ tenantId, userIds, message }) {
    const options = settings();
    const tenant = identifier(tenantId);
    const ownerIds = Array.isArray(userIds) && userIds.length > 0 && userIds.length <= 500
      ? Array.from(userIds, identifier)
      : [];
    if (!tenant || !ownerIds.length || ownerIds.some((id) => !id) || !message || typeof message !== "object" || Array.isArray(message) ||
        ["token", "tokens", "topic", "condition"].some((field) => field in message)) {
      fail(400, "FCM_INVALID_MESSAGE", "A tenant, 1 to 500 user IDs and an untargeted FCM payload are required.");
    }
    let rows;
    try {
      rows = await options.store.listActive({
        scopeHash: digest(options.hashKey, "scope", tenant, options.projectId),
        ownerIds: [...new Set(ownerIds)],
      });
    } catch {
      unavailable();
    }
    const counts = { accepted: 0, failed: 0 };
    if (!rows.length) return counts;
    const client = getClient();
    for (let start = 0; start < rows.length; start += 500) {
      const tokens = [];
      for (const row of rows.slice(start, start + 500)) {
        try {
          const secret = row.encryption_key_id === options.encryptionKeyId
            ? options.encryptionKey
            : key(config.decryptionKeys?.[row.encryption_key_id]);
          tokens.push(decrypt(row.encrypted_token, secret, row));
        } catch {
          counts.failed += 1;
        }
      }
      if (!tokens.length) continue;
      try {
        const result = await client.sendEachForMulticast({ ...message, tokens });
        counts.accepted += result.successCount;
        counts.failed += result.failureCount;
      } catch {
        counts.failed += tokens.length;
      }
    }
    return counts;
  }

  return {
    async register(ctx) {
      const options = settings();
      const { ownerId, scopeHash } = await session(ctx, options);
      const { installationId, token } = ctx.request.body ?? {};
      const id = installation(installationId);
      if (typeof token !== "string" || !/^[A-Za-z0-9_:.-]{32,4096}$/.test(token) ||
          /^(ExponentPushToken|ExpoPushToken)/.test(token)) {
        fail(400, "FCM_INVALID_DEVICE", "Invalid FCM device token.");
      }
      const row = {
        scope_hash: scopeHash,
        owner_id: ownerId,
        installation_hash: digest(options.hashKey, "installation", scopeHash, id),
        token_hash: digest(options.hashKey, "token", scopeHash, token),
        encryption_key_id: options.encryptionKeyId,
      };
      row.encrypted_token = encrypt(token, options.encryptionKey, row);
      let registered;
      try {
        registered = await options.store.register(row);
      } catch (error) {
        if (error.code !== "FCM_DEVICE_CONFLICT") unavailable();
      }
      if (registered === false || registered === undefined) {
        fail(409, "FCM_DEVICE_CONFLICT", "The installation or token is already registered.");
      }
    },

    async revoke(ctx) {
      const options = settings();
      const scope = await session(ctx, options);
      const installationHash = digest(
        options.hashKey, "installation", scope.scopeHash, installation(ctx.params.installationId),
      );
      try {
        await options.store.revoke({ ...scope, installationHash });
      } catch {
        unavailable();
      }
    },

    sendToUser({ tenantId, userId, message }) {
      return sendToUsers({ tenantId, userIds: [userId], message });
    },
    sendToUsers,
  };
}

module.exports = { createDeviceService };
