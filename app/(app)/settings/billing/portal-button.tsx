"use client";

import { useTransition } from "react";
import { openPortal } from "@/app/actions/stripe";

export function PortalButton() {
  const [pending, start] = useTransition();
  return (
    <button
      className="btn"
      disabled={pending}
      onClick={() => {
        start(async () => {
          const res = await openPortal();
          if (res.ok) window.location.href = res.url;
        });
      }}
    >
      {pending ? "Loading…" : "Manage in Stripe"}
    </button>
  );
}
