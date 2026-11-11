"use client";

import { useState } from "react";

export type Grant = {
  id: string;
  client_name: string;
  client_uri: string | null;
  created_at: string;
  last_used_at: string | null;
};

/** Apps signed in to the MCP server over OAuth (ChatGPT, claude.ai, Claude Code), with Disconnect. */
export function ConnectedApps({ grants: initial }: { grants: Grant[] }) {
  const [grants, setGrants] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function disconnect(id: string) {
    setError(null);
    const res = await fetch(`/api/oauth/grants?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setGrants((g) => g.filter((x) => x.id !== id));
    else setError("Could not disconnect that app. Try again.");
  }

  if (grants.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">No apps connected yet.</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
        {grants.map((g) => (
          <li key={g.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium">{g.client_name}</div>
              <div className="text-xs text-[var(--color-muted)]">
                Connected {new Date(g.created_at).toLocaleDateString()}
                {g.last_used_at ? ` · last used ${new Date(g.last_used_at).toLocaleString()}` : ""}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => disconnect(g.id)}>
              Disconnect
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
