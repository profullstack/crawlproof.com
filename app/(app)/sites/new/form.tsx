"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSite } from "@/app/actions/linkExchange";

export function NewSiteForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await createSite({
        domain,
        name: name.trim() || undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Land on the dashboard with the new site selected — site picker
      // is already updated to the new row by setCurrentSite() server-side.
      router.push("/dashboard");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Domain
        </label>
        <input
          className="input mt-1"
          type="text"
          required
          placeholder="example.com"
          autoFocus
          autoComplete="off"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Just the domain — no <code>https://</code>, no path.
        </p>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Display name (optional)
        </label>
        <input
          className="input mt-1"
          type="text"
          placeholder="Acme Marketing Site"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Shown in the site picker. Defaults to the domain if blank.
        </p>
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || !domain.trim()}
        >
          {pending ? "Adding…" : "Add site"}
        </button>
        <p className="text-xs text-[var(--color-muted)]">
          You can configure autoblog publishing later — it's never
          required.
        </p>
      </div>
    </form>
  );
}
