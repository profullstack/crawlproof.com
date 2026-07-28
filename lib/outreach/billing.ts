// Charging for lead generation.
//
// The price existed as a constant for a while before anything read it, which
// meant every campaign tick and every one-shot search ran on the house — and
// the expensive part is not the AI, it is the search calls behind contact
// lookup. This is the meter.
//
// Two rules shape it:
//
// A tick is billed only when it is about to do billable work. The cron fires
// every fifteen minutes whether or not a campaign has anything to do, so
// charging per tick would cost 288 credits a day to keep an idle campaign
// switched on. The gate below is therefore lazy: nothing is charged until a
// stage actually reaches for search or a model.
//
// And a tick is billed once, not per stage. Discovery, research and drafting
// inside one run are one unit of work from the user's side, and metering them
// separately would make the cost of leaving a campaign on unpredictable.

import { LEAD_RUN_CREDITS } from "@/lib/credits";

export { manualRunPrice, LEADS_PER_CHARGE, CONTACT_SEARCHES_PER_CHARGE } from "@/lib/credits";
import { consumeCredit, refundCredit } from "@/lib/rateLimit";

export type RunBilling = {
  /**
   * Charge for this run if it has not been charged yet.
   *
   * Returns false when the balance will not cover it, which callers treat as
   * "stop here" rather than "carry on unbilled".
   */
  authorize: () => Promise<boolean>;
  /** True once the run has been paid for. */
  charged: () => boolean;
  /** True when a charge was attempted and the balance would not cover it. */
  declined: () => boolean;
  /** Hand the money back — for a run that turned out to do nothing. */
  refund: () => Promise<void>;
};

/**
 * A single charge, taken at most once, on first use.
 *
 * Deliberately not an up-front charge on the whole tick: what a tick will do
 * is not knowable before it looks, and a prospect whose scan has not landed
 * costs nothing to skip.
 */
export function leadRunBilling(ownerId: string, credits = LEAD_RUN_CREDITS): RunBilling {
  let state: "unbilled" | "billed" | "declined" = "unbilled";

  return {
    async authorize() {
      if (state === "billed") return true;
      // One decline ends the run. Retrying per stage would hammer the balance
      // check for a campaign that has simply run out.
      if (state === "declined") return false;
      const res = await consumeCredit(ownerId, credits);
      state = res.ok ? "billed" : "declined";
      return res.ok;
    },
    charged: () => state === "billed",
    declined: () => state === "declined",
    async refund() {
      if (state !== "billed") return;
      await refundCredit(ownerId, credits);
      state = "unbilled";
    },
  };
}

/** What the run history says when a campaign cannot pay for a tick. */
export function outOfCreditsNote(credits = LEAD_RUN_CREDITS): string {
  return `out of credits — a run costs ${credits} credit${credits === 1 ? "" : "s"}; top up in Billing to resume`;
}
