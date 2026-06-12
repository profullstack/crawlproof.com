"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createProjectApiKey,
  revokeProjectApiKey,
} from "@/app/actions/audience";

type KeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type RepoRow = {
  installation_id: number;
  repo_owner: string;
  repo_name: string;
  default_branch: string | null;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AudienceKeysClient({
  projectId,
  keys,
}: {
  projectId: string;
  keys: KeyRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [justMinted, setJustMinted] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await createProjectApiKey({ projectId, name });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setJustMinted({ name, key: r.key });
      setName("");
      router.refresh();
    });
  }

  function revoke(keyId: string) {
    setError(null);
    start(async () => {
      const r = await revokeProjectApiKey({ projectId, keyId });
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Key name
          </label>
          <input
            className="input mt-1"
            type="text"
            placeholder="production backend"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || !name.trim()}
        >
          {pending ? "Minting…" : "Generate key"}
        </button>
      </form>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}

      {justMinted && (
        <div className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3">
          <p className="text-sm font-semibold">
            Copy “{justMinted.name}” now — it won&apos;t be shown again.
          </p>
          <code className="mt-2 block break-all rounded bg-[var(--color-bg)] p-2 text-xs">
            {justMinted.key}
          </code>
        </div>
      )}

      {keys.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No keys yet.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--color-border)] px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{key.name}</span>
                <code className="text-xs text-[var(--color-muted)]">{key.key_prefix}…</code>
                {key.revoked_at ? (
                  <span className="badge badge-fail">revoked</span>
                ) : (
                  <span className="text-xs text-[var(--color-muted)]">
                    last used {fmt(key.last_used_at)}
                  </span>
                )}
              </div>
              {!key.revoked_at && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={pending}
                  onClick={() => revoke(key.id)}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type PrResult = {
  status: "opened" | "noop";
  prUrl?: string;
  stackDetected?: string;
  filesChanged?: string[];
  detail?: string;
};

export function CreateAudiencePrClient({
  projectId,
  repos,
}: {
  projectId: string;
  repos: RepoRow[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [repoKey, setRepoKey] = useState(
    repos.length > 0 ? `${repos[0].repo_owner}/${repos[0].repo_name}` : "",
  );
  const [mode, setMode] = useState<"browser_and_server" | "browser_only" | "server_only">(
    "browser_and_server",
  );
  const [result, setResult] = useState<PrResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (repos.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        No GitHub repo connected to this project yet. Connect one on the{" "}
        <Link href={`/projects/${projectId}/repos`} className="underline">
          Repos tab
        </Link>{" "}
        first, then come back to create the install PR.
      </p>
    );
  }

  async function createPr() {
    const repo = repos.find((r) => `${r.repo_owner}/${r.repo_name}` === repoKey);
    if (!repo) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/github/create-audience-pr`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: repo.repo_owner,
            repo: repo.repo_name,
            installation_id: repo.installation_id,
            default_branch: repo.default_branch ?? undefined,
            install_mode: mode,
          }),
        },
      );
      const body = (await res.json()) as { data?: PrResult; error?: string };
      if (!res.ok || body.error) {
        setError(body.error ?? `Request failed (${res.status})`);
      } else {
        setResult(body.data ?? null);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Repository
          </label>
          <select
            className="input mt-1"
            value={repoKey}
            onChange={(e) => setRepoKey(e.target.value)}
          >
            {repos.map((repo) => (
              <option
                key={`${repo.repo_owner}/${repo.repo_name}`}
                value={`${repo.repo_owner}/${repo.repo_name}`}
              >
                {repo.repo_owner}/{repo.repo_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Install
          </label>
          <select
            className="input mt-1"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="browser_and_server">Browser + server</option>
            <option value="browser_only">Browser only</option>
            <option value="server_only">Server only</option>
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={createPr}
        >
          {pending ? "Opening PR…" : "Create PR"}
        </button>
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {result && (
        <div className="rounded border border-[var(--color-border)] p-3 text-sm">
          {result.status === "opened" ? (
            <p>
              ✅ PR opened{result.stackDetected ? ` (stack: ${result.stackDetected})` : ""}:{" "}
              <a href={result.prUrl} target="_blank" rel="noreferrer" className="underline">
                {result.prUrl}
              </a>
            </p>
          ) : (
            <p>{result.detail ?? "Nothing to change — already installed."}</p>
          )}
          {result.filesChanged && result.filesChanged.length > 0 && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Files: {result.filesChanged.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
