import { beforeEach, describe, expect, it, vi } from "vitest";

// A signup with the @profullstack/profile fields validates them before the
// user is created and stores them on public.profiles (keyed by id) after.
const mocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  getUser: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signUp: mocks.signUp, getUser: mocks.getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    auth: {},
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        mocks.upsert(table, row, opts);
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
    }),
  }),
}));

import { signUpWithPassword } from "@/app/actions/auth";

const newUser = { id: "11111111-1111-4111-8111-111111111111", email: "ada@acme.com", identities: [{}] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.signUp.mockResolvedValue({ data: { user: newUser, session: null }, error: null });
});

describe("signUpWithPassword profile fields", () => {
  it("stores the six fields on profiles after creating the user", async () => {
    const res = await signUpWithPassword({
      email: "Ada@Acme.com",
      password: "hunter22hunter",
      profile: {
        first_name: "Ada",
        last_name: "Lovelace",
        company_domain: "https://www.acme.com/about",
        job_title: "VP Engineering",
        linkedin_url: "in/ada-lovelace",
      },
    });
    expect(res).toEqual({ ok: true, needsConfirmation: true });
    const opts = mocks.signUp.mock.calls[0][0].options;
    expect(opts.data).toMatchObject({ full_name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace" });
    expect(mocks.upsert).toHaveBeenCalledWith(
      "profiles",
      expect.objectContaining({
        id: newUser.id,
        email: "ada@acme.com",
        first_name: "Ada",
        last_name: "Lovelace",
        company_domain: "acme.com",
        job_title: "VP Engineering",
        linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
      }),
      { onConflict: "id" },
    );
  });

  it("refuses a signup missing the required names before creating the user", async () => {
    const res = await signUpWithPassword({ email: "ada@acme.com", password: "hunter22hunter", profile: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(Object.keys(res.fieldErrors ?? {})).toEqual(expect.arrayContaining(["first_name", "last_name"]));
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not write a profile for an address that is already registered", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: { ...newUser, identities: [] }, session: null }, error: null });
    const res = await signUpWithPassword({
      email: "ada@acme.com",
      password: "hunter22hunter",
      profile: { first_name: "Ada", last_name: "Lovelace" },
    });
    expect(res.ok).toBe(true);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("/api/v1/me/profile", () => {
  it("is 401 JSON when signed out", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const { GET } = await import("@/app/api/v1/me/profile/route");
    const r = await GET(new Request("https://crawlproof.com/api/v1/me/profile"));
    expect(r.status).toBe(401);
    expect(await r.json()).toHaveProperty("error");
  });
});
