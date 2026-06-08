import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260608031000_restore_org_and_project_access_scopes.sql",
  ),
  "utf8",
);

describe("org project access migration", () => {
  it("expands project access helper to include explicit project and org membership", () => {
    expect(migration).toContain("create or replace function public.is_project_member");
    expect(migration).toMatch(/from public\.project_members pm/);
    expect(migration).toMatch(/join public\.organization_members om/);
    expect(migration).toMatch(/om\.organization_id = p\.organization_id/);
  });

  it("restores org-member project read access", () => {
    expect(migration).toContain('create policy "projects org member read"');
    expect(migration).toMatch(/is_org_member\(organization_id,\s*\(select auth\.uid\(\)\)\)/);
  });

  it("removes the narrower superseded owner-only read policy", () => {
    expect(migration).toContain('drop policy if exists "projects org owner read"');
  });
});
