"use strict";

const { createDispatchService } = require("./dispatch");
const { createDeviceService } = require("./devices");
const device = require("./content-types/device");
const { resolveMessaging } = require("./messaging");

module.exports = {
  config: {
    default: {
      projectId: "", appName: undefined, isProjectVerified: undefined,
      devices: { enabled: false },
    },
  },
  contentTypes: { device },
  routes: {
    "content-api": {
      type: "content-api",
      routes: [
        { method: "POST", path: "/devices", handler: "devices.register" },
        { method: "DELETE", path: "/devices/:installationId", handler: "devices.revoke" },
      ],
    },
  },
  controllers: {
    devices: ({ strapi }) => ({
      async register(ctx) {
        await strapi.plugin("firebase-push").service("devices").register(ctx);
        ctx.status = 204;
      },
      async revoke(ctx) {
        await strapi.plugin("firebase-push").service("devices").revoke(ctx);
        ctx.status = 204;
      },
    }),
  },
  services: {
    dispatch: ({ strapi }) => createDispatchService(
      () => strapi.plugin("firebase-push").service("messaging").getClient(),
    ),
    devices: ({ strapi }) => {
      const plugin = strapi.plugin("firebase-push");
      return createDeviceService({
        strapi,
        config: {
          ...plugin.config("devices"),
          projectId: plugin.config("projectId"),
          isProjectVerified: plugin.config("isProjectVerified"),
        },
        getClient: () => plugin.service("messaging").getClient(),
      });
    },
    messaging: ({ strapi }) => ({
      getClient() {
        const plugin = strapi.plugin("firebase-push");
        return resolveMessaging({
          strapi,
          config: {
            projectId: plugin.config("projectId"),
            appName: plugin.config("appName"),
            isProjectVerified: plugin.config("isProjectVerified"),
          },
        });
      },
    }),
  },
};
