import { createClient } from "@/lib/supabase/server";
import { PromoteForm } from "@/components/promote/promote-form";

export const metadata = { title: "New promote list" };

export default async function NewPromotePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let accounts: Array<{ id: string; platform: string; handle: string }> = [];
  if (user) {
    const { data } = await supabase
      .from("sp_account")
      .select("id, platform, handle")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("platform");
    accounts = (data ?? []) as typeof accounts;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-bold">New promote list</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Paste links and we'll write unique marketing pitches for each, dripped across your connected social accounts.
      </p>

      <PromoteForm accounts={accounts} />
    </div>
  );
}
