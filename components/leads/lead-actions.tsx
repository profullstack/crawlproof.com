"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  draftLeadAction,
  researchLeadAction,
  sendLeadAction,
  suppressLeadAction,
} from "@/app/actions/leads";

type Draft = { subject: string; body: string; to: string | null };

/**
 * Per-lead controls: rescan/refresh contact, write a draft, send it.
 *
 * Send is two deliberate clicks — "Test (dry run)" proves the whole path
 * including suppression and the CAN-SPAM footer without mailing anyone, and
 * only then does "Send for real" appear. That mirrors the MCP tools, where
 * dry_run defaults true.
 */
export function LeadActions({
  projectId,
  host,
  hasContact,
  nextStep,
}: {
  projectId: string;
  host: string;
  hasContact: boolean;
  nextStep: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRunPassed, setDryRunPassed] = useState(false);

  const clear = () => {
    setNote(null);
    setError(null);
  };

  const research = () =>
    start(async () => {
      clear();
      const res = await researchLeadAction({ projectId, host });
      if (res.ok) {
        setNote(res.note);
        router.refresh();
      } else setError(res.error);
    });

  const write = () =>
    start(async () => {
      clear();
      setDryRunPassed(false);
      const res = await draftLeadAction({ projectId, host, step: nextStep });
      if (res.ok) setDraft({ subject: res.subject, body: res.body, to: res.to });
      else setError(res.error);
    });

  const send = (dryRun: boolean) =>
    start(async () => {
      if (!draft) return;
      clear();
      const res = await sendLeadAction({
        projectId,
        host,
        subject: draft.subject,
        body: draft.body,
        step: nextStep,
        dryRun,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(res.note);
      if (res.dryRun) setDryRunPassed(true);
      else {
        setDraft(null);
        setDryRunPassed(false);
        router.refresh();
      }
    });

  const suppress = () => {
    if (!confirm(`Never contact anyone at ${host} again? This cannot be undone here.`)) return;
    start(async () => {
      clear();
      const res = await suppressLeadAction({ projectId, value: host, scope: "domain" });
      if (res.ok) {
        setNote(res.note);
        router.refresh();
      } else setError(res.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button onClick={research} disabled={pending} className="btn text-sm">
          Rescan
        </button>
        <button onClick={write} disabled={pending || !hasContact} className="btn text-sm" title={hasContact ? "" : "No contact address found for this lead"}>
          {nextStep > 1 ? `Draft step ${nextStep}` : "Draft email"}
        </button>
        <button onClick={suppress} disabled={pending} className="btn text-sm">
          Never contact
        </button>
      </div>

      {note && <p className="text-xs text-[var(--color-muted)]">{note}</p>}
      {error && <p className="max-w-md text-right text-xs text-[var(--color-danger,#f87171)]">{error}</p>}

      {draft && (
        <div className="mt-1 w-full rounded-lg border border-[var(--color-border)] p-3 text-left">
          <p className="text-xs text-[var(--color-muted)]">To: {draft.to ?? "(no address)"}</p>
          <input
            className="input mt-2 w-full text-sm"
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            aria-label="Subject"
          />
          <textarea
            className="input mt-2 h-40 w-full font-mono text-xs"
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            aria-label="Body"
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Edited text is re-checked against the scan before it can be sent — a claim the report
            doesn&apos;t support is refused.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={() => send(true)} disabled={pending} className="btn text-sm">
              Test (dry run)
            </button>
            {dryRunPassed && (
              <button onClick={() => send(false)} disabled={pending} className="btn btn-primary text-sm">
                Send for real
              </button>
            )}
            <button onClick={() => setDraft(null)} disabled={pending} className="btn text-sm">
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
