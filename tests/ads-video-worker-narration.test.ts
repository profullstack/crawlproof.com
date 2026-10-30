import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ synth: vi.fn(), render: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/ads/video/narration", async (original) => ({ ...await original<typeof import("@/lib/ads/video/narration")>(), synthesiseNarration: mocks.synth }));
vi.mock("@/lib/ads/video/render", async (original) => ({ ...await original<typeof import("@/lib/ads/video/render")>(), renderPreroll: mocks.render }));
vi.mock("../worker/frames", () => ({ captureFrames: mocks.capture }));
import { processRenderJob } from "../worker/video";
import { NarrationError } from "@/lib/ads/video/narration";
const snapshot = { audioMode: "narrated", narration: "Approved copy." };
function fixture(attemptsMade = 0) {
  const states: Record<string, unknown>[] = [];
  const db = { from: () => ({ update: (patch: Record<string, unknown>) => ({ eq: async () => { states.push(patch); return { error: null }; } }) }) };
  const job = { data: { jobRowId: "fixture", snapshot, creativeId: null, campaignId: null }, attemptsMade, opts: { attempts: 3 } };
  return { states, db, job };
}
beforeEach(() => vi.clearAllMocks());
describe("worker narration failures", () => {
  it("stops retrying permanent payment errors before capturing any frames", async () => {
    const f = fixture();mocks.synth.mockRejectedValue(new NarrationError("narration_payment_required", false));
    await expect(processRenderJob(f.db as never, f.job as never)).rejects.toMatchObject({ name: "UnrecoverableError", message: "narration_payment_required" });
    expect(f.states.at(-1)).toEqual({ state: "failed", error_code: "narration_payment_required" });
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("keeps temporary failures queued until retries are exhausted", async () => {
    mocks.synth.mockRejectedValue(new NarrationError("narration_rate_limited", true));
    const first = fixture();await expect(processRenderJob(first.db as never, first.job as never)).rejects.toMatchObject({ code: "narration_rate_limited" });
    expect(first.states.at(-1)?.state).toBe("queued");
    const last = fixture(2);await expect(processRenderJob(last.db as never, last.job as never)).rejects.toMatchObject({ code: "narration_rate_limited" });
    expect(last.states.at(-1)?.state).toBe("failed");
  });
  it("passes the generated track and unchanged approved snapshot to the renderer", async () => {
    const f = fixture();mocks.synth.mockResolvedValue({ filePath: "/fixture/audio.mp3", byteSize: 100, script: "Approved copy." });mocks.render.mockResolvedValue({ assets: [], problems: [] });
    await processRenderJob(f.db as never, f.job as never);
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ snapshot, audioPath: "/fixture/audio.mp3" }));
    expect(f.states.at(-1)?.state).toBe("ready");
  });
});
