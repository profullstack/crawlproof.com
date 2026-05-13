"use client";

import { useState } from "react";
import { BuyCreditsModal } from "@/components/billing/buy-credits-modal";
import { findPack } from "@/lib/credits";

export function BuyCreditsButton({ packId }: { packId: string }) {
  const [open, setOpen] = useState(false);
  const pack = findPack(packId);
  if (!pack) return null;
  return (
    <>
      <button
        className="btn btn-primary mt-4 w-full"
        onClick={() => setOpen(true)}
      >
        Buy with crypto
      </button>
      <BuyCreditsModal
        open={open}
        onClose={() => setOpen(false)}
        packId={pack.id}
        packLabel={pack.label}
        amountUsd={pack.amountCents / 100}
        credits={pack.credits}
      />
    </>
  );
}
