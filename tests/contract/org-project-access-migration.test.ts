import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260608030000_limit_org_member_project_access.sql",
  ),
  "utf8",
);

describe("org project access migration", () => {
  it("removes broad org-member project read access", () => {
    expect(migration).toContain('drop policy if exists "projects org member read"');
    expect(migration).not.toMatch(/create policy "projects org member read"/i);
    expect(migration).not.toMatch(/is_org_member\(organization_id/i);
  });

  it("keeps org-owner project read access for workspace admins", () => {
    expect(migration).toContain('create policy "projects org owner read"');
    expect(migration).toMatch(/is_org_owner\(organization_id,\s*\(select auth\.uid\(\)\)\)/);
  });
});
