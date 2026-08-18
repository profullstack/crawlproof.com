"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeLink, toggleLink } from "@/app/actions/promote";

type LinkRow = {
  id: string;
  url: string;
  title: string | null;
  angle: string | null;
  enabled: boolean;
  times_promoted: number;
  last_promoted_at: string | null;
  created_at: string;
  ownership?: string | null;
  source_name?: string | null;
};

export function LinkList({ links }: { links: LinkRow[] }) {
  if (links.length === 0) {
    return <p className="mt-2 text-sm text-[var(--color-muted)]">No links yet.</p>;
  }

  return (
    <ul className="mt-2 space-y-1">
      {links.map((link) => (
        <LinkItem key={link.id} link={link} />
      ))}
    </ul>
  );
}

function LinkItem({ link }: { link: LinkRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const handleToggle = () =>
    start(async () => {
      await toggleLink(link.id, !link.enabled);
      router.refresh();
    });

  const handleRemove = () => {
    if (!confirm("Remove this link?")) return;
    start(async () => {
      await removeLink(link.id);
      router.refresh();
    });
  };

  return (
    <li className={`card flex items-center justify-between gap-3 p-3 text-sm ${!link.enabled ? "opacity-50" : ""}`}>
      <div className="min-w-0 flex-1">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-xs hover:text-[var(--color-accent)]"
        >
          {link.url}
        </a>
        {link.title && (
          <div className="truncate text-[var(--color-muted)]">{link.title}</div>
        )}
        {/* Where this link came from: a link imported from somebody else's feed
            reads very differently from one the user pasted. */}
        {link.ownership && link.ownership !== "owned" && (
          <div className="truncate text-xs text-[var(--color-muted)]">
            {link.ownership === "shared" ? "Industry" : "Partner"} content
            {link.source_name ? ` · ${link.source_name}` : ""}
          </div>
        )}
        {link.angle && (
          <div className="truncate text-xs text-[var(--color-muted)]">
            Angle: {link.angle}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-[var(--color-muted)]">
          {link.times_promoted}x
        </span>
        <button
          onClick={handleToggle}
          disabled={pending}
          className="btn text-xs"
          title={link.enabled ? "Disable" : "Enable"}
        >
          {link.enabled ? "Disable" : "Enable"}
        </button>
        <button
          onClick={handleRemove}
          disabled={pending}
          className="btn text-xs text-[var(--color-fail)]"
        >
          Remove
        </button>
      </div>
    </li>
  );
}
