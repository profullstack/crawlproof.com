"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSlot, setSlotStatus, saveSlotPayout, requestPayout } from "@/app/actions/ads";

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
  availableCents = 0,
}: {
  project: Project;
  slot: Slot | null;
  origin: string;
  availableCents?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [addr, setAddr] = useState(slot?.payout_address ?? "");
  const [currency, setCurrency] = useState(slot?.payout_currency ?? "usdc_pol");
  const [copied, setCopied] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  const [prMsg, setPrMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [repoChoices, setRepoChoices] = useState<
    { owner: string; repo: string; installation_id: number }[] | null
  >(null);

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
  function withdraw() {
    if (!slot) return;
    start(async () => {
      const res = await requestPayout({ slotId: slot.id });
      if (!res.ok) return alert(res.error);
      alert(`Withdrawal requested: $${(res.amountCents / 100).toFixed(2)}. It will settle to your wallet via CoinPay.`);
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

  async function submitPr(pick?: { owner: string; repo: string; installation_id: number }) {
    if (!slot) return;
    setPrBusy(true);
    setPrMsg(null);
    try {
      const res = await fetch(`/api/ads/slots/${slot.id}/install-embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pick ?? {}),
      });
      const json = await res.json();
      if (!res.ok) {
        setPrMsg({ ok: false, text: json.error ?? "Could not open PR." });
        return;
      }
      if (json.data?.needsRepo) {
        setRepoChoices(json.data.repos);
        return;
      }
      setRepoChoices(null);
      const r = json.data;
      setPrMsg({ ok: true, text: r.detail, url: r.prUrl });
    } catch (e) {
      setPrMsg({ ok: false, text: e instanceof Error ? e.message : "Network error." });
    } finally {
      setPrBusy(false);
    }
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
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button className="btn text-xs" onClick={copy}>
                {copied ? "Copied!" : "Copy embed"}
              </button>
              <button className="btn text-xs" onClick={() => submitPr()} disabled={prBusy}>
                {prBusy ? "Opening PR…" : "Submit PR to install"}
              </button>
            </div>

            {repoChoices && (
              <div className="mt-2 rounded border border-[var(--color-border)] p-2 text-xs">
                <div className="mb-1 text-[var(--color-muted)]">Choose a repo:</div>
                <div className="flex flex-wrap gap-2">
                  {repoChoices.map((r) => (
                    <button
                      key={`${r.owner}/${r.repo}`}
                      className="btn text-xs"
                      disabled={prBusy}
                      onClick={() => submitPr(r)}
                    >
                      {r.owner}/{r.repo}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {prMsg && (
              <p className={`mt-2 text-xs ${prMsg.ok ? "text-[var(--color-accent)]" : "text-red-400"}`}>
                {prMsg.text}{" "}
                {prMsg.url && (
                  <a href={prMsg.url} target="_blank" rel="noreferrer" className="underline">
                    View PR ↗
                  </a>
                )}
              </p>
            )}
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
            <div className="text-sm">
              <span className="text-[var(--color-muted)]">Available to withdraw: </span>
              <span className="font-mono font-semibold">${(availableCents / 100).toFixed(2)}</span>
            </div>
            <button className="btn text-sm" onClick={withdraw} disabled={pending || availableCents <= 0}>
              Withdraw
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
