import { describe, it, expect } from "vitest";
import { anthropicThinkingFor } from "@/lib/lx/backendAi";

describe("anthropicThinkingFor", () => {
  it("runs adaptive thinking on the current frontier models", () => {
    // Fable 5.1 rejects `disabled` with a 400; Opus 5 accepts it but leaks
    // reasoning into the visible answer. Adaptive is the documented default.
    for (const m of ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1"]) {
      expect(anthropicThinkingFor(m)).toEqual({ type: "adaptive" });
    }
  });

  it("keeps thinking off on Haiku 4.5, which predates adaptive", () => {
    expect(anthropicThinkingFor("claude-haiku-4-5-20251001")).toEqual({ type: "disabled" });
    expect(anthropicThinkingFor("claude-haiku-4-5")).toEqual({ type: "disabled" });
  });
});
