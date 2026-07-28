"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteSeedCredentialAction,
  saveSeedCredentialAction,
} from "@/app/actions/seedCredentials";
import type { StoredSeedCredential } from "@/lib/outreach/seedCredentials";

/**
 * Seed directories that need a sign-in.
 *
 * The panel leads with what is actually blocked. A campaign parked on a gated
 * directory isn't failing, it is waiting on something only the user can
 * supply, so the hosts it is waiting for are named and each one carries the
 * form that unblocks it.
 */
export function SeedLogins({
  projectId,
  waitingHosts,
  credentials,
}: {
  projectId: string;
  /** Seed URLs campaigns are parked on, with no stored credential. */
  waitingHosts: string[];
  credentials: StoredSeedCredential[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = (targetHost?: string) =>
    start(async () => {
      setNote(null);
      setError(null);
      const res = await saveSeedCredentialAction({
        projectId,
        host: targetHost ?? host,
        username,
        password,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(res.note);
      setHost("");
      setUsername("");
      setPassword("");
      setOpen(false);
      router.refresh();
    });

  const remove = (h: string) =>
    start(async () => {
      setError(null);
      const res = await deleteSeedCredentialAction({ projectId, host: h });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });

  const hasAnything = waitingHosts.length > 0 || credentials.length > 0 || open;
  if (!hasAnything) {
    return (
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Seed logins</h2>
            <p className="text-sm text-[var(--color-muted)]">
              Some directories only show their listings to a signed-in visitor. Store a login and
              campaigns can seed from those too.
            </p>
          </div>
          <button onClick={() => setOpen(true)} className="btn text-sm">
            Add a login
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Seed logins</h2>
        {!open && (
          <button onClick={() => setOpen(true)} className="btn text-sm">
            Add a login
          </button>
        )}
      </div>

      {waitingHosts.length > 0 && (
        <div className="mt-3 rounded border border-[var(--color-warn,#facc15)] p-3">
          <p className="text-sm">
            <strong>Waiting for sign-in.</strong> A campaign is parked on{" "}
            {waitingHosts.length === 1 ? "a directory that requires" : "directories that require"} a
            login:
          </p>
          <ul className="mt-2 space-y-2">
            {waitingHosts.map((h) => (
              <li key={h} className="text-sm">
                <code className="break-all text-xs">{h}</code>
                <button
                  onClick={() => {
                    setHost(h);
                    setOpen(true);
                  }}
                  className="ml-2 text-xs underline"
                >
                  Add a login for this
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <div className="mt-3 grid gap-3 border-t border-[var(--color-border)] pt-3 sm:grid-cols-2">
          <label className="text-sm sm:col-span-2">
            Site
            <input
              className="input mt-1 w-full"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="directory.example.com — or paste the seed URL"
            />
          </label>
          <label className="text-sm">
            Username or email
            <input
              className="input mt-1 w-full"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="text-sm">
            Password
            <input
              type="password"
              className="input mt-1 w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
            Encrypted with AES-256-GCM before storing; the key lives in the application
            environment, not the database. Sign-in is attempted on the next campaign tick and the
            result is shown here — a site that asks for a verification code can&apos;t be signed
            into from a server, and will say so.
          </p>
          <div className="sm:col-span-2">
            <button
              onClick={() => save()}
              disabled={pending || !host.trim() || !username.trim() || !password}
              className="btn btn-primary"
            >
              {pending ? "Saving…" : "Save login"}
            </button>
            <button onClick={() => setOpen(false)} className="btn ml-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {credentials.length > 0 && (
        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {credentials.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="font-medium">{c.host}</p>
                <p className="text-xs text-[var(--color-muted)]">
                  {c.username}
                  {c.verifiedAt ? ` · signed in ${c.verifiedAt.slice(0, 10)}` : " · not tried yet"}
                </p>
                {c.lastError && (
                  <p className="mt-1 text-xs text-[var(--color-danger,#f87171)]">{c.lastError}</p>
                )}
              </div>
              <button
                onClick={() => remove(c.host)}
                disabled={pending}
                className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {note && <p className="mt-3 text-sm">{note}</p>}
      {error && <p className="mt-3 text-sm text-[var(--color-danger,#f87171)]">{error}</p>}
    </section>
  );
}
