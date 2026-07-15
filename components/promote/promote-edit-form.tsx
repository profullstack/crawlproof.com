"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePromoteList } from "@/app/actions/promote";
import { CADENCE_PRESETS } from "@/lib/promote/generatePitch";

type Account = { id: string; platform: string; handle: string };

type ListData = {
  id: string;
  name: string;
  cadence_seconds: number;
  post_mode: string;
  brand_voice: string;
  target_account_ids: string[] | null;
};

export function PromoteEditForm({
  list,
  accounts,
}: {
  list: ListData;
  accounts: Account[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const [name, setName] = useState(list.name);
  const [cadence, setCadence] = useState(list.cadence_seconds);
  const [postMode, setPostMode] = useState<"trickle" | "burst">(
    (list.post_mode as "trickle" | "burst") ?? "trickle",
  );
  const [brandVoice, setBrandVoice] = useState(list.brand_voice ?? "");
  const [useAllAccounts, setUseAllAccounts] = useState(!list.target_account_ids);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(
    list.target_account_ids ?? [],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);
    start(async () => {
      const result = await updatePromoteList({
        listId: list.id,
        name,
        cadenceSeconds: cadence,
        postMode,
        brandVoice,
        targetAccountIds: useAllAccounts ? null : selectedAccounts,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(true);
      router.refresh();
    });
  };

  const toggleAccount = (id: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-4">
      {error && (
        <div className="rounded border border-[var(--color-fail)] bg-[var(--color-fail)]/10 p-3 text-sm text-[var(--color-fail)]">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded border border-[var(--color-pass)] bg-[var(--color-pass)]/10 p-3 text-sm text-[var(--color-pass)]">
          Settings saved.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input mt-1 w-full"
          />
        </div>

        <div>
          <label htmlFor="cadence" className="block text-sm font-medium">
            Cadence
          </label>
          <select
            id="cadence"
            value={cadence}
            onChange={(e) => setCadence(Number(e.target.value))}
            className="input mt-1 w-full"
          >
            {CADENCE_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium">Post mode</label>
        <div className="mt-1 flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="editPostMode"
              value="trickle"
              checked={postMode === "trickle"}
              onChange={() => setPostMode("trickle")}
            />
            Trickle
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="editPostMode"
              value="burst"
              checked={postMode === "burst"}
              onChange={() => setPostMode("burst")}
            />
            Burst
          </label>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium">Accounts</label>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={useAllAccounts}
            onChange={(e) => setUseAllAccounts(e.target.checked)}
          />
          All connected (dynamic)
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
      </div>

      <div>
        <label htmlFor="brandVoice" className="block text-sm font-medium">
          Brand voice / instructions
        </label>
        <textarea
          id="brandVoice"
          value={brandVoice}
          onChange={(e) => setBrandVoice(e.target.value)}
          rows={3}
          className="input mt-1 w-full text-sm"
        />
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary text-sm">
        {pending ? "Saving..." : "Save settings"}
      </button>
    </form>
  );
}
