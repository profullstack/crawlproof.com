"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCampaignStatus } from "@/app/actions/ads";

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
