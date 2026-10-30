"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { WalletProfile } from "@/lib/coinpay-wallets";
import { selectGlobalCoinpayWallet } from "@/app/actions/coinpayWallets";
export function GlobalWalletCard({ profile, connectUrl }: { profile: WalletProfile; connectUrl: string }) {
  const [busy, start] = useTransition();const [message, setMessage] = useState<string | null>(null);const router=useRouter();
  return <section className="card mt-6 p-4">
    <h2 className="font-semibold">Global CoinPay payout wallets</h2>
    <p className="mt-1 text-sm text-[var(--color-muted)]">Connect once. All your current and future sites use the same global payout wallet. No addresses to paste.</p>
    {profile.connected && profile.wallets.length > 0 ? <>
      <label className="mt-3 block text-sm">Default wallet for all sites
        <select className="input mt-1 w-full" value={profile.selected?.id ?? ""} disabled={busy} onChange={(e) => { const id=e.target.value;start(async()=>{try{const r=await selectGlobalCoinpayWallet(id);setMessage(r.ok?"Global wallet saved for all sites.":r.error ?? "Could not save.");if(r.ok)router.refresh();}catch{setMessage("Could not save. Try again.");}}); }}>
          {profile.wallets.map((w)=><option key={w.id} value={w.id}>{w.currency.toUpperCase()} · {w.label ? `${w.label} · ` : ""}{w.address}</option>)}
        </select>
      </label>
      <p className="mt-2 break-all font-mono text-xs">{profile.selected?.address}</p>
      <p className="mt-2 text-xs text-[var(--color-muted)]">Synced {profile.syncedAt ? new Date(profile.syncedAt).toLocaleString() : "from CoinPay"}. Refresh after changing wallets in CoinPay; the update applies to every site.</p>
    </> : <p className="mt-3 text-sm">{profile.connected ? "CoinPay has no active account-level wallets. Add one in CoinPay, then refresh." : "Connect your CoinPay account to import its global receive wallets."}</p>}
    <a className="btn btn-primary mt-3 inline-block text-sm" href={connectUrl}>{profile.connected ? "Refresh from CoinPay" : "Connect CoinPay wallets"}</a>
    <a className="ml-3 text-sm underline" href="https://coinpayportal.com/settings/wallets" target="_blank" rel="noreferrer">Manage global wallets</a>
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
  </section>;
}
