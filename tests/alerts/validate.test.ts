import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  isDisposableEmail,
  validateTerm,
  validateCompiledQuery,
} from "@/lib/alerts/validate";

describe("email validation", () => {
  it("accepts a normal address", () => {
    expect(isValidEmail("jane@company.com")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
  it("flags disposable domains", () => {
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
  });
});

describe("query validation", () => {
  it("rejects empty terms", () => {
    expect(validateTerm("   ").ok).toBe(false);
  });
  it("rejects overly long queries", () => {
    expect(validateCompiledQuery("a".repeat(600)).ok).toBe(false);
  });
  it("blocks illegal-content patterns", () => {
    expect(validateTerm("child porn links").ok).toBe(false);
    expect(validateCompiledQuery("hitman for hire").ok).toBe(false);
  });
  it("passes a normal query", () => {
    const r = validateCompiledQuery('"acme" -site:acme.com');
    expect(r.ok).toBe(true);
  });
});
