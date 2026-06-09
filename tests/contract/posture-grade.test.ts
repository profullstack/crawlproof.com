import { describe, expect, it } from "vitest";
import {
  gradeCategory,
  gradeScore,
  gradeStatus,
  letterFromScore,
} from "@/lib/audit/posture/grade";
import type { Finding } from "@/lib/audit/types";

function f(status: Finding["status"], priority: Finding["priority"], key = "k"): Finding {
  return { section: "x", check_key: key, status, title: "t", priority };
}

describe("posture gradeCategory", () => {
  it("grades all-pass as A", () => {
    expect(gradeCategory([f("pass", 5), f("pass", 5)]).grade).toBe("A");
  });

  it("ignores inventory findings when grading", () => {
    expect(gradeCategory([f("fail", 1, "posture.dns.inventory")]).grade).toBe("A");
  });

  it("drops to F on a critical (priority-1) failure", () => {
    expect(gradeCategory([f("fail", 1), f("pass", 5)]).grade).toBe("F");
  });

  it("drops to D on a non-critical failure", () => {
    expect(gradeCategory([f("fail", 2), f("pass", 5)]).grade).toBe("D");
  });

  it("grades a high-severity warning as C", () => {
    expect(gradeCategory([f("warn", 2), f("pass", 5)]).grade).toBe("C");
  });

  it("grades a nice-to-have warning as B", () => {
    expect(gradeCategory([f("warn", 3), f("pass", 5)]).grade).toBe("B");
  });

  it("treats unknown (tool unavailable) as C", () => {
    expect(gradeCategory([f("unknown", 2)]).grade).toBe("C");
  });
});

describe("posture grade helpers", () => {
  it("maps grades to summary-grid status", () => {
    expect(gradeStatus("A")).toBe("pass");
    expect(gradeStatus("B")).toBe("pass");
    expect(gradeStatus("C")).toBe("warn");
    expect(gradeStatus("D")).toBe("warn");
    expect(gradeStatus("F")).toBe("fail");
  });

  it("rolls a band score back to a letter", () => {
    expect(letterFromScore(gradeScore("A"))).toBe("A");
    expect(letterFromScore(gradeScore("F"))).toBe("F");
    expect(letterFromScore(95)).toBe("A");
    expect(letterFromScore(40)).toBe("F");
  });
});
