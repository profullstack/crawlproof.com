"use client";

import { useTransition } from "react";
import { startCheckout } from "@/app/actions/stripe";

export function UpgradeButton() {
  const [pending, start] = useTransition();
  return (
    <button
      className="btn btn-primary"
      disabled={pending}
      onClick={() => {
        start(async () => {
          const res = await startCheckout();
          if (res.ok) window.location.href = res.url;
        });
      }}
    >
      {pending ? "Loading…" : "Upgrade to Pro"}
    </button>
  );
}
