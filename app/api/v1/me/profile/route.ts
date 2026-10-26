import { createProfileHandlers } from "@profullstack/profile";
import { createClient } from "@/lib/supabase/server";
import { profileStore } from "@/lib/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET / PUT / PATCH /api/v1/me/profile — the signed-in user's profile fields.
const handlers = () =>
  createProfileHandlers({
    store: profileStore(),
    getUser: async () => {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
    },
  });

export const GET = (req: Request) => handlers().GET(req);
export const PUT = (req: Request) => handlers().PUT(req);
export const PATCH = (req: Request) => handlers().PATCH(req);
