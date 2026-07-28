import { createReferralsClient } from "@profullstack/stack/referrals";
import { serviceClient } from "@/lib/supabase/service";

export const referralStore = createReferralsClient({
  getClient: () => serviceClient(),
});
