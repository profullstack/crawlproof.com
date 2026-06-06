import { describe, expect, it } from "vitest";
import {
  analyzeIntegration,
  extractIntegrationSource,
} from "@/lib/tracker/integration-analyzer";

const SAMPLE_TAG =
  '<script src="https://track.anderro.com/a.js" data-key="pk_test_d237ac5dc1fced18daddcd191af5a02473013e9498cb37dc" data-auto="true"></script>';

describe("tracker integration analyzer", () => {
  it("extracts script src and data attributes from a pasted script tag", () => {
    const source = extractIntegrationSource(SAMPLE_TAG);

    expect(source.inputType).toBe("script-tag");
    expect(source.scriptUrl).toBe("https://track.anderro.com/a.js");
    expect(source.attributes["data-auto"]).toBe("true");
    expect(source.attributes["data-key"]).toMatch(/^pk_test_/);
  });

  it("maps public endpoints, sdk surface, config keys, and named events", () => {
    const analysis = analyzeIntegration({
      originalInput: SAMPLE_TAG,
      fetchedText: `
        window.Anderro = { track: function(name) { return name; } };
        var endpoint = "https://track.anderro.com/api/events";
        fetch("/v1/batch", { method: "POST" });
        Anderro.track("signup");
      `,
      fetchedBytes: 220,
      contentType: "application/javascript",
      httpStatus: 200,
    });

    expect(analysis.source.origin).toBe("https://track.anderro.com");
    expect(analysis.source.attributes["data-key"]).toBe("pk_test_...37dc");
    expect(analysis.endpoints.map((endpoint) => endpoint.url)).toContain(
      "https://track.anderro.com/api/events",
    );
    expect(analysis.endpoints.map((endpoint) => endpoint.url)).toContain(
      "https://track.anderro.com/v1/batch",
    );
    expect(analysis.endpoints.find((endpoint) => endpoint.path === "/v1/batch")?.method).toBe(
      "POST",
    );
    expect(analysis.globals).toContain("Anderro");
    expect(analysis.methods).toContain("track");
    expect(analysis.configKeys).toEqual(expect.arrayContaining(["key", "auto"]));
    expect(analysis.events).toContain("signup");
    expect(analysis.authHints).toContain("data-key=pk_test_...37dc");
  });
});
