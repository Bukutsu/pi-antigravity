import assert from "node:assert/strict";
import register from "../src/index.js";

let registered: { id: string; config: { oauth?: { isSubscription?: boolean } } } | undefined;
const pi = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "registerProvider")
        return (id: string, config: { oauth?: { isSubscription?: boolean } }) => {
          registered = { id, config };
        };
      return () => undefined;
    },
  },
);
register(pi as Parameters<typeof register>[0]);

assert.equal(registered?.id, "antigravity");
assert.equal(
  registered?.config.oauth?.isSubscription,
  true,
  "Antigravity OAuth is marked subscription-backed so Pi shows the (sub) marker",
);

console.log("provider registration: subscription-backed oauth passed");
