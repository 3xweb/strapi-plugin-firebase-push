"use strict";

function failedOutcome(error) {
  switch (error?.code) {
    case "messaging/invalid-registration-token":
    case "messaging/registration-token-not-registered":
      return "invalid-token";
    default:
      // A transport failure does not prove that FCM rejected the message.
      return "uncertain";
  }
}

function createDispatchService(getClient) {
  return {
    async send(message, dryRun) {
      const client = getClient();
      try {
        await client.send(message, dryRun);
        return "accepted";
      } catch (error) {
        return failedOutcome(error);
      }
    },

    async sendBatch(message, dryRun) {
      const { tokens } = message;
      if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 500) {
        throw new RangeError("A multicast batch requires 1 to 500 device tokens.");
      }

      const client = getClient();
      try {
        const result = await client.sendEachForMulticast(message, dryRun);
        return tokens.map((_, index) => {
          const response = result.responses[index];
          return response?.success === true ? "accepted" : failedOutcome(response?.error);
        });
      } catch {
        throw Object.assign(new Error("The FCM batch outcome could not be confirmed."), {
          code: "FCM_BATCH_UNCERTAIN",
        });
      }
    },
  };
}

module.exports = { createDispatchService };
