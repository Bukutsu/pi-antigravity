import assert from "node:assert/strict";
import { formatUsageSummary } from "../src/usage/usage.js";

console.log("Running usage formatter tests...");

const baseUsage = {
  projectId: "test",
  endpoint: "test",
  groups: [],
  models: [],
  fetchedAt: Date.now(),
};

// Regression fixture for #3501 error message
const message3501 =
  "/v1internal:retrieveUserQuotaSummary failed: You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. Please contact your administrator to request a license. (#3501)";

const out = formatUsageSummary({
  ...baseUsage,
  quotaSummaryError: message3501,
});

assert.ok(
  out.includes("needs a paid subscription") || out.includes("free-tier can't use that endpoint"),
);

console.log("Usage formatter tests passed!");
