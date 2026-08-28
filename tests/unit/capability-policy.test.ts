import { describe, expect, it } from "vitest";

import {
  createBaselineCapabilityPolicy,
  policyPatchSchema,
} from "../../src/policy/capability-policy.js";

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

  it("dry-runs only the canonical monotonically restrictive destination patch", () => {
    const trustedDestination =
      "http://127.0.0.1:3000/api/trusted-destination";
    const policy = createBaselineCapabilityPolicy([trustedDestination]);
    const baseHash = policy.fingerprint();

    const dryRun = policy.dryRunPatch({
      destinationAllowlist: [trustedDestination],
      expectedBaseHash: baseHash,
      expectedBaseVersion: 1,
    });

    expect(dryRun).toMatchObject({
      affectedCapability: "send_external_message",
      base: {
        hash: baseHash,
        version: 1,
      },
      candidate: {
        rules: {
          read_internal_document: "allow",
          send_external_message: {
            destinations: [trustedDestination],
          },
        },
        version: 2,
      },
      diff: [
        {
          after: [trustedDestination],
          before: "*",
          operation: "replace",
          path: "/rules/send_external_message/destinations",
        },
      ],
      expectedReplayBehavior: {
        blockedAt: "send_external_message",
        matchingSinkReceipt: false,
        policyDecision: "deny",
        verdict: "PROTECTED",
      },
      predictedOperationalImpact: {
        deniedDestinations: "all destinations outside the allowlist",
        protectedDocumentAccess: "unchanged",
        trustedDestinations: [trustedDestination],
      },
    });
    expect(policy.fingerprint()).toBe(baseHash);
  });

  it.each([
    {
      destinationAllowlist: [
        "http://127.0.0.1:3000/api/trusted-destination",
        "https://untrusted.example/messages",
      ],
      expectedBaseHash:
        "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c",
      expectedBaseVersion: 1,
    },
    {
      destinationAllowlist: [
        "http://127.0.0.1:3000/api/trusted-destination",
      ],
      expectedBaseHash: "0".repeat(64),
      expectedBaseVersion: 1,
    },
    {
      destinationAllowlist: [
        "http://127.0.0.1:3000/api/trusted-destination",
      ],
      expectedBaseHash:
        "93d054afcb184730a08510550d5ed932dcf78ae88011a76b16423f615df0210c",
      expectedBaseVersion: 1,
      remediationCode: "grant('*')",
    },
  ])("rejects a non-canonical or stale patch", (patch) => {
    const policy = createBaselineCapabilityPolicy([
      "http://127.0.0.1:3000/api/trusted-destination",
    ]);

    expect(() => policy.dryRunPatch(policyPatchSchema.parse(patch))).toThrow();
  });
});
