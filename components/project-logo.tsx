"use client";

import { useRef, useState } from "react";
import { refetchProjectLogo } from "@/app/actions/createProject";

// Project tile logo. Shows the discovered logo; on a broken image it falls back
// to a letter avatar immediately AND fires a one-shot re-discovery so a stale /
// 404'ing logo_url self-heals on the next render.
export function ProjectLogo({
  url,
  name,
  projectId,
}: {
  url: string | null;
  name: string;
  projectId?: string;
}) {
  const letter = (name || "?").trim().charAt(0).toUpperCase();
  const [broken, setBroken] = useState(false);
  const refetched = useRef(false);

  if (!url || broken) {
    return (
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-card)] text-sm font-semibold text-[var(--color-muted)]"
        aria-hidden
      >
        {letter}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      onError={() => {
        setBroken(true);
        // Re-discover once; the server clears/updates logo_url so the next load
        // shows a working logo (or a clean letter avatar).
        if (projectId && !refetched.current) {
          refetched.current = true;
          void refetchProjectLogo(projectId);
        }
      }}
      className="h-10 w-10 shrink-0 rounded-md border border-[var(--color-border)] bg-white object-contain p-1"
    />
  );
}
