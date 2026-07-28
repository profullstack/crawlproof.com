"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  importPostalAddressAction,
  savePostalAddressAction,
} from "@/app/actions/leads";
import type { AddressSettings } from "@/lib/outreach/postalAddress";

const SOURCE_LABEL: Record<string, string> = {
  project: "this project",
  organization: "your organization",
  account: "your account",
  env: "the server environment",
  none: "nowhere",
};

/**
 * The CAN-SPAM footer address, and the thing that gates live sending.
 *
 * Three levels — project, org, account — resolved most-specific-first. The
 * account one is the "set it once" default; the import buttons copy it down
 * so a new project is one click from being able to send, rather than a
 * retyped address per client.
 */
export function SenderAddress({
  projectId,
  settings,
}: {
  projectId: string;
  settings: AddressSettings;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(!settings.address);
  const [projectValue, setProjectValue] = useState(settings.levels.project ?? "");
  const [accountValue, setAccountValue] = useState(settings.levels.account ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: true; note: string } | { ok: false; error: string }>) =>
    start(async () => {
      setNote(null);
      setError(null);
      const res = await fn();
      if (res.ok) {
        setNote(res.note);
        router.refresh();
      } else setError(res.error);
    });

  const importFromAccount = () =>
    start(async () => {
      setNote(null);
      setError(null);
      const res = await importPostalAddressAction({ projectId, from: "account" });
      if (res.ok) {
        setProjectValue(res.address);
        setNote(res.note);
        router.refresh();
      } else setError(res.error);
    });

  return (
    <section className={`card p-4 ${settings.address ? "" : "border-[var(--color-warn,#facc15)]"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Sender address</h2>
          {settings.address ? (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Live sending is on. Footer address comes from{" "}
              <strong>{SOURCE_LABEL[settings.source]}</strong>: {settings.address}
            </p>
          ) : (
            <p className="mt-1 text-sm">
              <strong>Live sending is off.</strong> Cold email legally needs a physical postal
              address in the footer (CAN-SPAM). Add one below — dry runs work without it.
            </p>
          )}
        </div>
        <button onClick={() => setOpen(!open)} className="btn text-sm">
          {open ? "Close" : settings.address ? "Change" : "Add address"}
        </button>
      </div>

      {note && <p className="mt-3 text-sm">{note}</p>}
      {error && <p className="mt-3 text-sm text-[var(--color-danger,#f87171)]">{error}</p>}

      {open && (
        <div className="mt-4 grid gap-4 border-t border-[var(--color-border)] pt-4">
          <div>
            <label className="text-sm font-medium" htmlFor="account-address">
              Your account address
            </label>
            <p className="text-xs text-[var(--color-muted)]">
              Set this once. Every project can pull it in with one click.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                id="account-address"
                className="input min-w-[18rem] flex-1"
                value={accountValue}
                onChange={(e) => setAccountValue(e.target.value)}
                placeholder="Profullstack, Inc., 123 Main St, Austin TX 78701"
              />
              <button
                onClick={() =>
                  run(async () =>
                    savePostalAddressAction({ projectId, scope: "account", address: accountValue }),
                  )
                }
                disabled={pending}
                className="btn"
              >
                Save to account
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium" htmlFor="project-address">
              This project&apos;s address <span className="font-normal text-[var(--color-muted)]">(optional)</span>
            </label>
            <p className="text-xs text-[var(--color-muted)]">
              Overrides the account address — use it when you send on a client&apos;s behalf.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                id="project-address"
                className="input min-w-[18rem] flex-1"
                value={projectValue}
                onChange={(e) => setProjectValue(e.target.value)}
                placeholder="Leave empty to use the account address"
              />
              <button
                onClick={importFromAccount}
                disabled={pending || !settings.levels.account}
                className="btn"
                title={
                  settings.levels.account
                    ? "Copy your account address into this project"
                    : "Save an account address first"
                }
              >
                Import from account
              </button>
              <button
                onClick={() =>
                  run(async () =>
                    savePostalAddressAction({ projectId, scope: "project", address: projectValue }),
                  )
                }
                disabled={pending}
                className="btn btn-primary"
              >
                Save
              </button>
            </div>
          </div>

          {settings.hasOrg && (
            <p className="text-xs text-[var(--color-muted)]">
              Org-wide address:{" "}
              {settings.levels.organization ?? "not set"} — sits between your account and this
              project. Only the org owner can change it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
