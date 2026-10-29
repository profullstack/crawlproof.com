import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { crawlproofFleetbarHandler } from "@/lib/fleetbar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The <fleet-bar> panel's API on crawlproof.com: the signed-in user's own Fleet
// project, through the same handler and partner API w3bs.org and threatcrush.com use.
const handler = crawlproofFleetbarHandler({
  getSessionUser: async () => {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    return error ? null : data.user;
  },
  service: serviceClient,
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
