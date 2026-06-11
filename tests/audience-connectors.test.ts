import { describe, it, expect } from "vitest";
import { normalizeEmail, assertReadOnlySelect } from "@/lib/audience/connectors";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("rejects non-strings and blanks", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("requires a single @ with a dotted domain", () => {
    expect(normalizeEmail("nope")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull(); // no dot in domain
    expect(normalizeEmail("a@@b.com")).toBeNull();
    expect(normalizeEmail("@example.com")).toBeNull();
    expect(normalizeEmail("user@")).toBeNull();
    expect(normalizeEmail("user@example.com")).toBe("user@example.com");
  });

  it("rejects internal whitespace and overlong values", () => {
    expect(normalizeEmail("us er@example.com")).toBeNull();
    expect(normalizeEmail("a".repeat(250) + "@example.com")).toBeNull();
  });
});

describe("assertReadOnlySelect", () => {
  it("accepts a plain SELECT", () => {
    expect(assertReadOnlySelect("select email from users")).toBeNull();
  });

  it("accepts a trailing semicolon and a CTE", () => {
    expect(assertReadOnlySelect("select email from users;")).toBeNull();
    expect(
      assertReadOnlySelect("with a as (select email from users) select email from a"),
    ).toBeNull();
  });

  it("rejects empty queries", () => {
    expect(assertReadOnlySelect("   ")).toMatch(/empty/i);
  });

  it("rejects multiple statements", () => {
    expect(assertReadOnlySelect("select 1; drop table users")).toMatch(/single statement/i);
  });

  it("rejects non-SELECT statements", () => {
    expect(assertReadOnlySelect("update users set email='x'")).toMatch(/SELECT/i);
  });

  it("rejects write/DDL keywords even inside a SELECT", () => {
    expect(assertReadOnlySelect("select email from users where x in (delete from t)")).toMatch(
      /only read/i,
    );
    expect(assertReadOnlySelect("select email from users; pragma table_info(users)")).not.toBeNull();
  });
});
