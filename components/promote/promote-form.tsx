"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createPromoteList } from "@/app/actions/promote";
import { CADENCE_PRESETS } from "@/lib/promote/generatePitch";

type Account = { id: string; platform: string; handle: string };

export function PromoteForm({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [links, setLinks] = useState("");
  const [cadence, setCadence] = useState(1800);
  const [postMode, setPostMode] = useState<"trickle" | "burst">("trickle");
  const [brandVoice, setBrandVoice] = useState("");
  const [useAllAccounts, setUseAllAccounts] = useState(true);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    start(async () => {
      const result = await createPromoteList({
        name,
        links,
        cadenceSeconds: cadence,
        postMode,
        brandVoice,
        targetAccountIds: useAllAccounts ? null : selectedAccounts,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/dashboard/promote/${result.listId}`);
    });
  };

  const toggleAccount = (id: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  // Estimate daily burn
  const linksCount = links
    .split(/[\n,\s]+/)
    .filter((s) => /^https?:\/\/.+/i.test(s.trim())).length;
  const postsPerDay = postMode === "trickle"
    ? Math.floor(86400 / cadence)
    : Math.floor(86400 / cadence) * (useAllAccounts ? accounts.length : selectedAccounts.length || accounts.length);

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-6">
      {error && (
        <div className="rounded border border-[var(--color-fail)] bg-[var(--color-fail)]/10 p-3 text-sm text-[var(--color-fail)]">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name <span className="text-[var(--color-muted)]">(optional)</span>
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Promote list"
          className="input mt-1 w-full"
        />
      </div>

      <div>
        <label htmlFor="links" className="block text-sm font-medium">
          Links to promote
        </label>
        <textarea
          id="links"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder={"https://example.com/page-1\nhttps://example.com/page-2\nhttps://example.com/page-3"}
          rows={8}
          className="input mt-1 w-full font-mono text-sm"
          required
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          One URL per line (comma or space separated also works). {linksCount > 0 && `${linksCount} link${linksCount !== 1 ? "s" : ""} detected.`}
        </p>
      </div>

      <div>
        <label htmlFor="cadence" className="block text-sm font-medium">
          Cadence
        </label>
        <select
          id="cadence"
          value={cadence}
          onChange={(e) => setCadence(Number(e.target.value))}
          className="input mt-1"
        >
          {CADENCE_PRESETS.map((p) => (
            <option key={p.seconds} value={p.seconds}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium">Post mode</label>
        <div className="mt-1 flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="postMode"
              value="trickle"
              checked={postMode === "trickle"}
              onChange={() => setPostMode("trickle")}
            />
            Trickle (1 post per tick, safest)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="postMode"
              value="burst"
              checked={postMode === "burst"}
              onChange={() => setPostMode("burst")}
            />
            Burst (all accounts per tick)
          </label>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium">Accounts / platforms</label>
        {accounts.length === 0 ? (
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            No connected accounts.{" "}
            <Link href="/dashboard/promote/accounts" className="text-[var(--color-accent)]">
              Connect one first
            </Link>
            .
          </p>
        ) : (
          <>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useAllAccounts}
                onChange={(e) => setUseAllAccounts(e.target.checked)}
              />
              All connected accounts (dynamic — new accounts auto-join)
            </label>
            {!useAllAccounts && (
              <div className="mt-2 space-y-1">
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedAccounts.includes(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    <span className="font-mono text-xs">{a.platform}</span> — {a.handle}
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div>
        <label htmlFor="brandVoice" className="block text-sm font-medium">
          Brand voice / instructions <span className="text-[var(--color-muted)]">(optional)</span>
        </label>
        <textarea
          id="brandVoice"
          value={brandVoice}
          onChange={(e) => setBrandVoice(e.target.value)}
          placeholder="e.g. We're a developer-first SaaS. Keep it casual, no corporate speak."
          rows={3}
          className="input mt-1 w-full text-sm"
        />
      </div>

      {postsPerDay > 0 && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
          Estimated burn: ~{postsPerDay} post{postsPerDay !== 1 ? "s" : ""}/day = ~{postsPerDay} credits/day at this cadence.
        </div>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Creating..." : "Create & start promoting"}
      </button>
    </form>
  );
}
