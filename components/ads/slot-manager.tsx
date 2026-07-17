"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSlot, setSlotStatus, saveSlotPayout, requestPayout } from "@/app/actions/ads";
import { PUBLISHER_FORMAT_IDS, formatSpec, type AdFormatId } from "@/lib/ads/formats";

// The paste-once embed for a given size. data-format tells /ad.js which creative
// to request; the medium rectangle stays the default the auto-installer uses.
function embedFor(slotId: string, format: AdFormatId, origin: string): string {
  return `<div data-cp-ad data-slot="${slotId}" data-format="${format}"></div>\n<script src="${origin}/ad.js" async></script>`;
}

type Project = { id: string; name: string; url: string };
type Slot = {
  id: string;
  project_id: string;
  status: string;
  payout_address: string | null;
  payout_currency: string | null;
};
type Payout = {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  tx_hash: string | null;
  created_at: string;
};

// Minimal shape the CoinPay wallet extension is expected to inject on
// tronbrowser.dev. The provider is not shipped yet (extension Phase 3), so we
// feature-detect and no-op gracefully when it's absent.
type CoinPayProvider = {
  connect?: () => Promise<{ address?: string } | string>;
  getAddress?: () => Promise<string>;
};
declare global {
  interface Window {
    coinpay?: CoinPayProvider;
  }
}

function payoutStatusClass(status: string): string {
  if (status === "confirmed") return "text-[var(--color-accent)]";
  if (status === "failed") return "text-red-400";
  return "text-[var(--color-muted)]"; // requested / sent
}

const TX_EXPLORER: Record<string, string> = {
  usdc_pol: "https://polygonscan.com/tx/",
  usdt_pol: "https://polygonscan.com/tx/",
  pol: "https://polygonscan.com/tx/",
  usdc_eth: "https://etherscan.io/tx/",
  eth: "https://etherscan.io/tx/",
  usdc_sol: "https://solscan.io/tx/",
  sol: "https://solscan.io/tx/",
  btc: "https://mempool.space/tx/",
};

export function SlotManager({
  project,
  slot,
  origin,
  availableCents = 0,
  coins,
  payouts = [],
  stats = null,
}: {
  project: Project;
  slot: Slot | null;
  origin: string;
  availableCents?: number;
  coins: { code: string; label: string }[];
  payouts?: Payout[];
  stats?: { impressions: number; clicks: number; earnedCents: number } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [addr, setAddr] = useState(slot?.payout_address ?? "");
  const [currency, setCurrency] = useState(slot?.payout_currency ?? "usdc_pol");
  const [copied, setCopied] = useState(false);
  // Which size's embed is currently revealed, and whether the code block is open.
  const [fmt, setFmt] = useState<AdFormatId>(PUBLISHER_FORMAT_IDS[0]);
  const [showCode, setShowCode] = useState(true);
  const [prBusy, setPrBusy] = useState(false);
  const [prMsg, setPrMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [repoChoices, setRepoChoices] = useState<
    { owner: string; repo: string; installation_id: number }[] | null
  >(null);

  const embed = slot ? embedFor(slot.id, fmt, origin) : null;

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

  // One-click connect via the CoinPay wallet extension (tronbrowser.dev). The
  // provider isn't shipped yet, so this feature-detects and guides the user
  // otherwise — and lights up automatically once window.coinpay exists.
  async function connectWallet() {
    const provider = typeof window !== "undefined" ? window.coinpay : undefined;
    if (!provider) {
      alert("Open this page in tronbrowser.dev with the CoinPay wallet extension to connect in one click. Meanwhile, paste your address below.");
      return;
    }
    try {
      let address: string | undefined;
      if (provider.connect) {
        const r = await provider.connect();
        address = typeof r === "string" ? r : r?.address;
      } else if (provider.getAddress) {
        address = await provider.getAddress();
      }
      if (address) setAddr(address);
      else alert("Wallet did not return an address.");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not connect wallet.");
    }
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
          {stats && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-[var(--color-muted)]">Impressions: </span>
                <span className="font-mono font-semibold">{stats.impressions.toLocaleString()}</span>
              </span>
              <span>
                <span className="text-[var(--color-muted)]">Clicks: </span>
                <span className="font-mono font-semibold">{stats.clicks.toLocaleString()}</span>
              </span>
              <span>
                <span className="text-[var(--color-muted)]">CTR: </span>
                <span className="font-mono font-semibold">
                  {stats.impressions ? `${((stats.clicks / stats.impressions) * 100).toFixed(1)}%` : "—"}
                </span>
              </span>
              <span>
                <span className="text-[var(--color-muted)]">Earned: </span>
                <span className="font-mono font-semibold">${(stats.earnedCents / 100).toFixed(2)}</span>
              </span>
            </div>
          )}
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Embed — pick a size, paste on your page
            </div>
            {/* One button per available size. Clicking reveals that size's code;
                clicking the open size again collapses it. */}
            <div className="mt-2 flex flex-wrap gap-2">
              {PUBLISHER_FORMAT_IDS.map((id) => {
                const spec = formatSpec(id);
                const open = id === fmt && showCode;
                return (
                  <button
                    key={id}
                    className={`btn text-xs ${open ? "btn-primary" : ""}`}
                    aria-expanded={open}
                    onClick={() => {
                      if (id === fmt) {
                        setShowCode((s) => !s);
                      } else {
                        setFmt(id);
                        setShowCode(true);
                      }
                    }}
                  >
                    {spec.label} · {spec.w}×{spec.h}
                  </button>
                );
              })}
            </div>
            {showCode && embed && (
              <>
                <pre className="mt-2 overflow-x-auto rounded border border-[var(--color-border)] bg-black/30 p-3 text-xs">
                  {embed}
                </pre>
                <div className="mt-2">
                  <button className="btn text-xs" onClick={copy}>
                    {copied ? "Copied!" : "Copy embed"}
                  </button>
                </div>
              </>
            )}

            {/* Auto-install drops a unit for every size before </body> — we
                can't safely guess where each belongs, so the publisher keeps
                or moves whichever they want. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
              <button className="btn text-xs" onClick={() => submitPr()} disabled={prBusy}>
                {prBusy ? "Opening PR…" : "Submit PR to install all sizes"}
              </button>
              <span className="text-xs text-[var(--color-muted)]">
                Adds every size above <code>&lt;/body&gt;</code>; keep the ones you want.
              </span>
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
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  Payout wallet address
                </span>
                <button type="button" className="text-xs text-[var(--color-accent)]" onClick={connectWallet}>
                  Connect wallet
                </button>
              </div>
              <input
                className="input mt-1 font-mono text-sm"
                placeholder="0x… / T… / bc1…"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
              />
            </label>
            <label className="block w-52">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Payout coin
              </span>
              <select
                className="input mt-1 text-sm"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {/* keep an existing/legacy value selectable even if not in the list */}
                {currency && !coins.some((c) => c.code === currency) && (
                  <option value={currency}>{currency}</option>
                )}
                {coins.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
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

          {payouts.length > 0 && (
            <div className="text-xs">
              <div className="mb-1 uppercase tracking-wider text-[var(--color-muted)]">
                Payout history
              </div>
              <ul className="space-y-1">
                {payouts.map((p) => {
                  const explorer = p.tx_hash ? TX_EXPLORER[p.currency] : undefined;
                  return (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono">
                        ${(p.amount_cents / 100).toFixed(2)} {p.currency.toUpperCase()}
                      </span>
                      <span className="text-[var(--color-muted)]">
                        {new Date(p.created_at).toLocaleDateString()}
                      </span>
                      <span className={payoutStatusClass(p.status)}>{p.status}</span>
                      {explorer && p.tx_hash ? (
                        <a
                          href={`${explorer}${p.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          tx ↗
                        </a>
                      ) : (
                        <span />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="text-xs text-[var(--color-muted)]">
            Earnings settle to this address via CoinPay. Open in tronbrowser.dev with the
            CoinPay wallet extension to connect your wallet in one click.
          </p>
        </>
      )}
    </li>
  );
}
