"use strict";

module.exports = {
  schema: {
    kind: "collectionType",
    collectionName: "firebase_push_devices",
    info: {
      singularName: "device",
      pluralName: "devices",
      displayName: "Firebase Push Device",
    },
    options: { draftAndPublish: false },
    indexes: [
      { name: "firebase_push_installation_unique", columns: ["installation_hash"], type: "unique" },
      { name: "firebase_push_token_unique", columns: ["token_hash"], type: "unique" },
    ],
    pluginOptions: {
      "content-manager": { visible: false },
      "content-type-builder": { visible: false },
    },
    attributes: {
      scopeHash: { type: "string", required: true, private: true },
      ownerId: { type: "string", required: true, private: true },
      installationHash: { type: "string", required: true, unique: true, private: true },
      tokenHash: { type: "string", required: true, unique: true, private: true },
      encryptedToken: { type: "text", private: true },
      encryptionKeyId: { type: "string", required: true, private: true },
      revokedAt: { type: "datetime", private: true },
    },
  },
};
