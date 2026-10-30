import { describe, expect, it } from "vitest";
import { renderFailureMessage } from "@/lib/ads/video/errors";
describe("render error guidance", () => {
  it("does not tell advertisers to edit copy to fix service configuration", () => {
    for (const code of ["missing_narration_audio", "narration_payment_required", "narration_not_configured"]) {
      expect(renderFailureMessage(code)).toContain("editing it will not fix");
      expect(renderFailureMessage(code)).toContain("copy is saved");
    }
  });
});
