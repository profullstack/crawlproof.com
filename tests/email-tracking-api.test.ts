import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// A tiny stand-in for the Supabase query builder: from(table) filtered by the
// eq/in/gte calls the access module makes, over fixture rows.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
function query(table: string) {
  let rows = [...(tables[table] ?? [])];
  const builder = {
    select: () => builder,
    eq: (col: string, v: unknown) => ((rows = rows.filter((r) => r[col] === v)), builder),
    in: (col: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[col]))), builder),
    gte: (col: string, v: string) => ((rows = rows.filter((r) => String(r[col]) >= v)), builder),
    limit: () => builder,
    then: (resolve: (v: { data: Row[]; error: null }) => void) => resolve({ data: rows, error: null }),
  };
  return builder;
}

const mocks = vi.hoisted(() => ({ auth: vi.fn(), setEnabled: vi.fn(), rotate: vi.fn(), getOrCreate: vi.fn() }));
vi.mock("@/lib/sp/apiAuth", () => ({ authenticateBearer: mocks.auth }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: query }) }));
vi.mock("@/lib/emailTracking/store", () => ({
  getOrCreateForProject: mocks.getOrCreate,
  setEnabled: mocks.setEnabled,
  rotateSecret: mocks.rotate,
}));
vi.mock("@/lib/env", () => ({ env: { siteUrl: "https://crawlproof.com" } }));

import { GET as list } from "@/app/api/v1/email-tracking/route";
import { GET as one } from "@/app/api/v1/email-tracking/[project]/route";
import { POST as act } from "@/app/api/v1/email-tracking/[project]/[action]/route";
import { normalizeSiteRef, pickProject, siteOf } from "@/lib/emailTracking/access";

const row = (project_id: string, enabled = false) => ({
  project_id,
  tracking_id: `trk${project_id}`,
  secret: `secret-${project_id}`,
  previous_secret: null,
  secret_rotated_at: null,
  enabled,
  enabled_at: enabled ? "2026-09-24T00:00:00Z" : null,
});

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ ok: true, userId: "me" });
  mocks.getOrCreate.mockReset().mockImplementation(async (id: string) => row(id, id === "p-mosh"));
  mocks.setEnabled.mockReset().mockImplementation(async (id: string, enabled: boolean) => row(id, enabled));
  mocks.rotate.mockReset().mockImplementation(async (id: string) => ({ ...row(id), secret: "fresh" }));
  const recent = new Date(Date.now() - 60_000).toISOString();
  Object.assign(tables, {
    projects: [
      { id: "p-mosh", name: "moshcode.sh", url: "https://moshcode.sh/", owner_id: "me", organization_id: null },
      { id: "p-org", name: "profullstack.com", url: "https://www.profullstack.com/", owner_id: "someone", organization_id: "org1" },
      { id: "p-view", name: "viewed.dev", url: "https://viewed.dev", owner_id: "someone", organization_id: null },
      { id: "p-other", name: "not-mine.com", url: "https://not-mine.com", owner_id: "stranger", organization_id: null },
    ],
    project_members: [{ project_id: "p-view", user_id: "me", role: "viewer" }],
    organization_members: [{ organization_id: "org1", user_id: "me", role: "member" }],
    email_tracking_events: [
      { project_id: "p-mosh", type: "open", machine: false, at: recent },
      { project_id: "p-mosh", type: "open", machine: true, at: recent },
      { project_id: "p-mosh", type: "click", machine: false, at: recent },
      { project_id: "p-mosh", type: "unsubscribe", machine: false, at: recent },
      { project_id: "p-mosh", type: "open", machine: false, at: "2020-01-01T00:00:00Z" },
    ],
  });
});

const req = (path: string, init?: RequestInit) => new NextRequest(`https://crawlproof.com${path}`, init as never);
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

describe("email tracking over the API", () => {
  it("lists every reachable project with its role and a day of human events, and no secrets", async () => {
    const r = await list(req("/api/v1/email-tracking"));
    expect(r.status).toBe(200);
    const { projects } = await r.json();
    expect(projects.map((p: { site: string; role: string }) => [p.site, p.role])).toEqual([
      ["moshcode.sh", "owner"],
      ["profullstack.com", "member"],
      ["viewed.dev", "viewer"],
    ]);
    const mosh = projects[0];
    expect(mosh).toMatchObject({
      tracking_id: "trkp-mosh",
      enabled: true,
      tracking_url: "https://crawlproof.com/t/trkp-mosh",
      events_url: "https://crawlproof.com/api/v1/tracking/trkp-mosh/events",
      events_24h: { open: 1, click: 1, unsubscribe: 1 },
    });
    expect(JSON.stringify(projects)).not.toContain("secret-");
  });

  it("finds one project by hostname or URL, and hands out the secret only when asked, never to a viewer", async () => {
    const plain = await (await one(req("/api/v1/email-tracking/moshcode.sh"), ctx({ project: "moshcode.sh" }))).json();
    expect(plain.secret).toBeUndefined();
    const withSecret = await one(req("/api/v1/email-tracking/x?secret=1"), ctx({ project: encodeURIComponent("https://www.profullstack.com/blog") }));
    expect((await withSecret.json()).secret).toBe("secret-p-org");
    expect((await one(req("/api/v1/email-tracking/viewed.dev?secret=1"), ctx({ project: "viewed.dev" }))).status).toBe(403);
    expect((await one(req("/api/v1/email-tracking/not-mine.com"), ctx({ project: "not-mine.com" }))).status).toBe(404);
  });

  it("enables, disables and rotates for owners and members, refuses viewers and unknown actions", async () => {
    const on = await act(req("/api/v1/email-tracking/p-org/enable", { method: "POST" }), ctx({ project: "p-org", action: "enable" }));
    expect(on.status).toBe(200);
    expect(mocks.setEnabled).toHaveBeenCalledWith("p-org", true);
    expect((await on.json()).secret).toBeUndefined();

    await act(req("/x", { method: "POST" }), ctx({ project: "moshcode.sh", action: "disable" }));
    expect(mocks.setEnabled).toHaveBeenLastCalledWith("p-mosh", false);

    const rotated = await act(req("/x", { method: "POST" }), ctx({ project: "moshcode.sh", action: "rotate" }));
    expect((await rotated.json()).secret).toBe("fresh");

    expect((await act(req("/x", { method: "POST" }), ctx({ project: "viewed.dev", action: "enable" }))).status).toBe(403);
    expect((await act(req("/x", { method: "POST" }), ctx({ project: "p-mosh", action: "delete" }))).status).toBe(404);
    expect(mocks.setEnabled).toHaveBeenCalledTimes(2);
  });

  it("refuses without a token before touching anything", async () => {
    mocks.auth.mockResolvedValue({ ok: false, status: 401, error: "Missing bearer token." });
    expect((await list(req("/api/v1/email-tracking"))).status).toBe(401);
    expect((await act(req("/x", { method: "POST" }), ctx({ project: "p-mosh", action: "enable" }))).status).toBe(401);
    expect(mocks.getOrCreate).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });
});

describe("site references", () => {
  it("normalises what people type", () => {
    expect(normalizeSiteRef("https://www.MoshCode.sh/x?y")).toBe("moshcode.sh");
    expect(normalizeSiteRef("moshcode.sh")).toBe("moshcode.sh");
    expect(siteOf({ name: "No URL", url: null })).toBe("no url");
  });
  it("refuses an ambiguous name", () => {
    const projects = [
      { id: "a", name: "same", url: "https://same.dev", role: "owner" as const },
      { id: "b", name: "same", url: "https://same.dev", role: "owner" as const },
    ];
    expect(pickProject(projects, "same.dev")).toBeNull();
    expect(pickProject(projects, "a")?.id).toBe("a");
  });
});
