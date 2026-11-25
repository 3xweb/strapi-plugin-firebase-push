"use strict";

const TABLE = "firebase_push_devices";

function createDeviceStore(strapi) {
  const db = strapi.db.connection;
  if (!["pg", "postgres", "postgresql", "sqlite3", "better-sqlite3"].includes(db.client.config.client)) {
    throw Object.assign(new Error("The device registry requires PostgreSQL or SQLite."), { status: 503 });
  }
  return {
    async register(row) {
      let records;
      try {
        records = await db(TABLE)
          .insert(row)
          .onConflict("installation_hash")
          .merge({
            token_hash: row.token_hash,
            encrypted_token: db.raw(
              'case when ?? is null and ?? = ? and ?? = ? then ?? else ? end',
              [
                TABLE + ".revoked_at", TABLE + ".token_hash", row.token_hash,
                TABLE + ".encryption_key_id", row.encryption_key_id,
                TABLE + ".encrypted_token", row.encrypted_token,
              ],
            ),
            encryption_key_id: row.encryption_key_id,
            revoked_at: null,
          })
          .where(TABLE + ".owner_id", row.owner_id)
          .where(TABLE + ".scope_hash", row.scope_hash)
          .returning("id");
      } catch (error) {
        if (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          return false;
        }
        throw error;
      }
      return records.length === 1;
    },
    async revoke({ scopeHash, ownerId, installationHash }) {
      await db(TABLE)
        .where({ scope_hash: scopeHash, owner_id: ownerId, installation_hash: installationHash })
        .whereNull("revoked_at")
        .update({ revoked_at: new Date().toISOString(), encrypted_token: null });
    },
    listActive({ scopeHash, ownerIds }) {
      return db(TABLE)
        .where({ scope_hash: scopeHash })
        .whereIn("owner_id", ownerIds)
        .whereNull("revoked_at")
        .select("scope_hash", "owner_id", "installation_hash", "token_hash", "encrypted_token", "encryption_key_id");
    },
  };
}

module.exports = { createDeviceStore };
