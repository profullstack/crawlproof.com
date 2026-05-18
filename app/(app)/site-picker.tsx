"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchSite } from "@/app/actions/currentSite";
import type { SiteSummary } from "@/lib/lx/currentSite";

// The agency-tier site picker. Renders as a small dropdown in the nav.
// Single-site users still see it (showing their one site), so the
// "+ New site" path is discoverable from day one. ≥2 sites flips it
// into a proper picker.
export function SitePicker({
  sites,
  currentId,
}: {
  sites: SiteSummary[];
  currentId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);

  const current = sites.find((s) => s.id === currentId) ?? sites[0];

  if (sites.length === 0) {
    return (
      <a
        href="/sites/new"
        className="text-xs uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-fg)]"
      >
        + Add site
      </a>
    );
  }

  const display = current?.name || current?.domain || "Site";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-[14rem] items-center gap-1.5 truncate rounded border border-[var(--color-border)] px-2 py-1 text-xs"
        title={current?.domain}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
        <span className="truncate">{display}</span>
        <span className="text-[var(--color-muted)]">▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 w-64 rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {sites.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                start(async () => {
                  await switchSite(s.id);
                  router.refresh();
                });
              }}
              className={
                "block w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-border)]/30 " +
                (s.id === current?.id ? "text-[var(--color-accent)]" : "")
              }
            >
              <div className="flex items-center gap-1.5 truncate">
                <span className="truncate">{s.name || s.domain}</span>
                {s.hasAutoblog && (
                  <span className="shrink-0 rounded bg-[var(--color-accent)]/15 px-1 py-0.5 text-[9px] uppercase tracking-wider text-[var(--color-accent)]">
                    autoblog
                  </span>
                )}
              </div>
              {s.name && s.name !== s.domain && (
                <div className="truncate text-[10px] text-[var(--color-muted)]">{s.domain}</div>
              )}
            </button>
          ))}
          <div className="my-1 border-t border-[var(--color-border)]/50" />
          <a
            href="/sites/new"
            className="block px-3 py-2 text-xs text-[var(--color-muted)] hover:bg-[var(--color-border)]/30 hover:text-[var(--color-fg)]"
            onClick={() => setOpen(false)}
          >
            + New site
          </a>
        </div>
      )}
    </div>
  );
}
