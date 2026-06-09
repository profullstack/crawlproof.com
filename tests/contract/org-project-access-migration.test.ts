import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260609133000_project_scoped_org_membership.sql",
  ),
  "utf8",
);

describe("org project access migration", () => {
  it("adds a project-scoped org role for visible-but-limited org membership", () => {
    expect(migration).toContain("project_member");
    expect(migration).toMatch(/role in \('owner', 'member', 'project_member'\)/);
  });

  it("keeps project access limited to explicit project membership or org-wide roles", () => {
    expect(migration).toContain("create or replace function public.is_project_member");
    expect(migration).toMatch(/from public\.project_members pm/);
    expect(migration).toMatch(/join public\.organization_members om/);
    expect(migration).toMatch(/om\.organization_id = p\.organization_id/);
    expect(migration).toMatch(/om\.role in \('owner', 'member'\)/);
  });

  it("limits org-wide project read access to owner and member roles", () => {
    expect(migration).toContain("create or replace function public.is_org_wide_member");
    expect(migration).toContain('create policy "projects org member read"');
    expect(migration).toMatch(/is_org_wide_member\(organization_id,\s*\(select auth\.uid\(\)\)\)/);
  });

  it("backfills existing project members into project-scoped org rows only when missing", () => {
    expect(migration).toMatch(/insert into public\.organization_members \(organization_id, user_id, role\)/);
    expect(migration).toMatch(/select distinct\s+p\.organization_id,\s+pm\.user_id,\s+'project_member'/);
    expect(migration).toMatch(/not exists \(/);
  });
});
