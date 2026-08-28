import { describe, expect, it } from "vitest";

import { classifyTrueForgeFailure } from "../../src/failure.js";

describe("TrueForge failure classification", () => {
  it("classifies an incomplete canonical sequence as Victim Agent noncompliance", () => {
    expect(
      classifyTrueForgeFailure(
        "TrueForge canonical tool sequence was incomplete: get_support_ticket, search_internal_documents, read_internal_document",
      ),
    ).toEqual({
      failure: {
        message:
          "Victim Agent ended before completing the canonical tool workflow",
        retryable: false,
      },
      stage: "victim-agent",
    });
  });
});
