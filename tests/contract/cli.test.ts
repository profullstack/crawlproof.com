import { describe, it, expect } from "vitest";
import { parseArgs } from "../../cli/index";

describe("cli parseArgs", () => {
  it("defaults to the 'help' command when no args given", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("captures the command and positional args", () => {
    const r = parseArgs(["audit", "https://example.com"]);
    expect(r.command).toBe("audit");
    expect(r.positional).toEqual(["https://example.com"]);
  });

  it("parses --flag=value style", () => {
    const r = parseArgs(["audit", "https://x", "--engine=claude", "--format=json"]);
    expect(r.flags).toEqual({ engine: "claude", format: "json" });
  });

  it("parses --flag value (space-separated)", () => {
    const r = parseArgs(["audit", "https://x", "--engine", "claude"]);
    expect(r.flags).toEqual({ engine: "claude" });
  });

  it("treats a bare --flag (no value) as boolean true", () => {
    const r = parseArgs(["audit", "https://x", "--verbose"]);
    expect(r.flags).toEqual({ verbose: true });
  });

  it("mixes positional and flag in any order", () => {
    const r = parseArgs(["audit", "--engine=claude", "https://x", "--format", "json"]);
    expect(r.command).toBe("audit");
    expect(r.positional).toEqual(["https://x"]);
    expect(r.flags).toEqual({ engine: "claude", format: "json" });
  });
});
