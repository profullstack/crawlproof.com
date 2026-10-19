import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// A stable link for other apps (CoinPay's "Connect CrawlProof"). Tokens are
// per account, but the page lives under a project, so land on the first one.
export default async function ApiTokensShortcut() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/dashboard/api-tokens");

  const { data } = await supabase
    .from("projects")
    .select("id")
    .eq("owner_id", user.id)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) redirect("/dashboard");
  redirect(`/dashboard/projects/${data.id}/social/api-tokens#coinpay`);
}
