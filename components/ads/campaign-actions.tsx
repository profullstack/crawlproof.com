"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { regenerateCampaign, setCampaignStatus } from "@/app/actions/ads";

// Re-run the AI pipeline for this campaign (fresh copy, colours, and hero
// image). Confirms first since it overwrites any manual edits.
export function RegenerateButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function regen() {
    if (!window.confirm("Regenerate this campaign's ads? This refreshes the copy, colours, and image, and overwrites manual edits.")) {
      return;
    }
    start(async () => {
      const res = await regenerateCampaign({ id });
      if (!res.ok) {
        alert(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <button className="btn text-sm" onClick={regen} disabled={pending}>
      {pending ? "Regenerating…" : "Regenerate"}
    </button>
  );
}

export function CampaignActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const live = status === "active";
  const next = live ? "paused" : "active";

  function toggle() {
    start(async () => {
      const res = await setCampaignStatus({ id, status: next as "active" | "paused" });
      if (!res.ok) {
        alert(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <button
      className={live ? "btn text-sm" : "btn btn-primary text-sm"}
      onClick={toggle}
      disabled={pending}
    >
      {pending ? "…" : live ? "Pause" : "Activate"}
    </button>
  );
}
