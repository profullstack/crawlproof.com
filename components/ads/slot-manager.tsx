"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSlot, setSlotStatus, saveSlotPayout } from "@/app/actions/ads";

type Project = { id: string; name: string; url: string };
type Slot = {
  id: string;
  project_id: string;
  status: string;
  payout_address: string | null;
  payout_currency: string | null;
};

export function SlotManager({
  project,
  slot,
  origin,
}: {
  project: Project;
  slot: Slot | null;
  origin: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [addr, setAddr] = useState(slot?.payout_address ?? "");
  const [currency, setCurrency] = useState(slot?.payout_currency ?? "usdc_pol");
  const [copied, setCopied] = useState(false);

  const embed =
    slot &&
    `<div data-cp-ad data-slot="${slot.id}" data-format="banner_300x250"></div>\n<script src="${origin}/ad.js" async></script>`;

  function enable() {
    start(async () => {
      const res = await createSlot({ projectId: project.id });
      if (!res.ok) return alert(res.error);
      router.refresh();
    });
  }
  function toggle(next: "active" | "paused") {
    if (!slot) return;
    start(async () => {
      const res = await setSlotStatus({ id: slot.id, status: next });
      if (!res.ok) return alert(res.error);
      router.refresh();
    });
  }
  function savePayout() {
    if (!slot) return;
    start(async () => {
      const res = await saveSlotPayout({ id: slot.id, payoutAddress: addr, payoutCurrency: currency });
      if (!res.ok) return alert(res.error);
      router.refresh();
    });
  }
  function copy() {
    if (!embed) return;
    navigator.clipboard?.writeText(embed).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <li className="card space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{project.name}</div>
          <div className="truncate text-sm text-[var(--color-muted)]">{project.url}</div>
        </div>
        {!slot ? (
          <button className="btn btn-primary text-sm" onClick={enable} disabled={pending}>
            {pending ? "…" : "Enable ads"}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="badge whitespace-nowrap">{slot.status}</span>
            {slot.status === "active" ? (
              <button className="btn text-sm" onClick={() => toggle("paused")} disabled={pending}>
                Pause
              </button>
            ) : (
              <button className="btn btn-primary text-sm" onClick={() => toggle("active")} disabled={pending}>
                Activate
              </button>
            )}
          </div>
        )}
      </div>

      {slot && (
        <>
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Embed — paste on your page
            </div>
            <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-black/30 p-3 text-xs">
              {embed}
            </pre>
            <button className="btn mt-2 text-xs" onClick={copy}>
              {copied ? "Copied!" : "Copy embed"}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="block flex-1">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Payout wallet address
              </span>
              <input
                className="input mt-1 font-mono text-sm"
                placeholder="0x… / T… / bc1…"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
              />
            </label>
            <label className="block w-40">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Currency
              </span>
              <input
                className="input mt-1 font-mono text-sm"
                placeholder="usdc_pol"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              />
            </label>
            <button className="btn text-sm" onClick={savePayout} disabled={pending}>
              Save wallet
            </button>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            Earnings settle to this address via CoinPay. On tronbrowser.dev with the CoinPay
            wallet extension you&apos;ll be able to connect it in one click (coming soon).
          </p>
        </>
      )}
    </li>
  );
}
