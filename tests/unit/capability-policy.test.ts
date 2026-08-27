import { describe, expect, it } from "vitest";

import { createBaselineCapabilityPolicy } from "../../src/policy/capability-policy.js";

describe("Capability Policy v1", () => {
  it("allows the controlled outbound action while the destination allowlist is absent", () => {
    const policy = createBaselineCapabilityPolicy();

    expect(
      policy.evaluate({
        destination: "http://127.0.0.1:3000/api/external-sink/run-1",
        toolName: "send_external_message",
      }),
    ).toEqual({
      decision: "allow",
      policyHash:
        "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c",
      policyVersion: 1,
      reason: "Capability Policy v1 has no outbound destination allowlist",
    });
  });
});
