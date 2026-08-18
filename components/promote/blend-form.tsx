"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateBlend } from "@/app/actions/promote";

type Mix = { owned: number; partner: number; shared: number };

export function BlendForm({ listId, mix }: { listId: string; mix: Mix }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Mix>(mix);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const total = values.owned + values.partner + values.shared;
  // Weights are relative, so what the user cares about is the resulting share.
  const share = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    start(async () => {
      const result = await updateBlend({ listId, mix: values });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Content mix saved.");
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-[var(--color-muted)]">
        How the campaign splits its posts between your own content and everybody
        else&rsquo;s. Weights are relative — 70 and 30 gives the same result as 7 and 3.
      </p>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["owned", "Our content"],
            ["partner", "Partner"],
            ["shared", "Industry"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="block text-sm">
            <span className="font-semibold">{label}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={values[key]}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [key]: Number(e.target.value) || 0 }))
              }
              className="input mt-1 w-full text-sm"
            />
            <span className="text-xs text-[var(--color-muted)]">{share(values[key])}% of posts</span>
          </label>
        ))}
      </div>

      {total === 0 && (
        <p className="text-sm text-[var(--color-fail)]">
          Give at least one group a weight, or the campaign has nothing to post.
        </p>
      )}

      <button type="submit" disabled={pending || total === 0} className="btn text-sm">
        {pending ? "Saving..." : "Save mix"}
      </button>
    </form>
  );
}
