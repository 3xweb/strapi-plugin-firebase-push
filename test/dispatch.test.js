"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createDispatchService } = require("../server/dispatch");

test("dispatch preserves message options and returns only a safe outcome", async () => {
  const message = { token: "synthetic-token", android: { ttl: 60000 } };
  const service = createDispatchService(() => ({
    async send(payload, dryRun) {
      assert.equal(payload, message);
      assert.equal(dryRun, true);
      throw Object.assign(new Error(payload.token), {
        code: "messaging/registration-token-not-registered",
      });
    },
  }));
  assert.equal(await service.send(message, true), "invalid-token");
});

test("multicast preserves response order and separates invalid tokens from uncertainty", async () => {
  const message = { tokens: ["a", "b", "c", "d"], data: { type: "sample" } };
  const service = createDispatchService(() => ({
    async sendEachForMulticast(payload) {
      assert.equal(payload, message);
      return { responses: [
        { success: true },
        { error: { code: "messaging/invalid-registration-token" } },
        { error: { code: "messaging/server-unavailable" } },
      ] };
    },
  }));
  assert.deepEqual(await service.sendBatch(message), [
    "accepted", "invalid-token", "uncertain", "uncertain",
  ]);
});

test("batch transport failures are redacted and oversized batches are rejected", async () => {
  let calls = 0;
  const service = createDispatchService(() => ({
    async sendEachForMulticast() {
      calls++;
      throw new Error("synthetic provider failure");
    },
  }));
  await assert.rejects(() => service.sendBatch({ tokens: ["a", "b"] }), {
    code: "FCM_BATCH_UNCERTAIN",
    message: "The FCM batch outcome could not be confirmed.",
  });
  await assert.rejects(() => service.sendBatch({ tokens: Array(501).fill("a") }), RangeError);
  assert.equal(calls, 1);
});
