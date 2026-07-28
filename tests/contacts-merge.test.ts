import { describe, it, expect } from "vitest";
import { identityKey } from "@/lib/outreach/contacts";

// The merge itself talks to the database; what is testable in isolation, and
// what actually decides whether two records are the same human, is the key.
describe("identityKey", () => {
  it("keys on email when there is one", () => {
    expect(identityKey({ email: "Jane@Acme.TEST" })).toBe("email:jane@acme.test");
  });

  it("treats addresses differing only in case as the same person", () => {
    expect(identityKey({ email: "JANE@acme.test" })).toBe(identityKey({ email: "jane@acme.test" }));
  });

  it("prefers email over name even when both are present", () => {
    // Two people can share a name; an address is definitionally one inbox.
    const key = identityKey({ email: "jane@acme.test", fullName: "Jane Doe" });
    expect(key).toMatch(/^email:/);
  });

  it("falls back to name and employer when there is no address", () => {
    // Person discovery finds exactly this: a name, a title, no email. Before
    // the fallback these people could not be stored at all.
    expect(identityKey({ fullName: "Jane Doe", companyName: "Acme Robotics" })).toBe(
      "name:janedoe@acmerobotics",
    );
  });

  it("normalises punctuation and case out of the name key", () => {
    expect(identityKey({ fullName: "Marc van Neerven", companyName: "Acme, Inc." })).toBe(
      identityKey({ fullName: "MARC VAN NEERVEN", companyName: "Acme Inc" }),
    );
  });

  it("keeps two same-named people at different employers apart", () => {
    expect(identityKey({ fullName: "Jane Doe", companyName: "Acme" })).not.toBe(
      identityKey({ fullName: "Jane Doe", companyName: "Globex" }),
    );
  });

  it("keys a name with no employer rather than refusing it", () => {
    expect(identityKey({ fullName: "Jane Doe" })).toBe("name:janedoe@");
  });

  it("returns null when there is nothing to key on", () => {
    // A row that can never be matched again is worse than no row: every run
    // would insert another copy of it.
    expect(identityKey({})).toBeNull();
    expect(identityKey({ companyName: "Acme" })).toBeNull();
    expect(identityKey({ email: "   " })).toBeNull();
  });

  it("changes form when an address is finally found for a known name", () => {
    // The reason the key is maintained by trigger rather than generated:
    // enriching a name-keyed contact has to move it onto the email key.
    const before = identityKey({ fullName: "Jane Doe", companyName: "Acme" });
    const after = identityKey({ fullName: "Jane Doe", companyName: "Acme", email: "jane@acme.test" });
    expect(before).toMatch(/^name:/);
    expect(after).toMatch(/^email:/);
  });
});
