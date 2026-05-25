import { afterEach, describe, expect, it, vi } from "vitest";

const originalBackendAiOpenaiModel = process.env.BACKEND_AI_OPENAI_MODEL;

afterEach(() => {
  vi.resetModules();
  if (originalBackendAiOpenaiModel === undefined) {
    delete process.env.BACKEND_AI_OPENAI_MODEL;
    return;
  }
  process.env.BACKEND_AI_OPENAI_MODEL = originalBackendAiOpenaiModel;
});

describe("backend ai env defaults", () => {
  it("defaults OpenAI Autoblog model to gpt-5-mini", async () => {
    delete process.env.BACKEND_AI_OPENAI_MODEL;
    vi.resetModules();
    const { env } = await import("@/lib/env");
    expect(env.backendAiOpenaiModel).toBe("gpt-5-mini");
  });
});
