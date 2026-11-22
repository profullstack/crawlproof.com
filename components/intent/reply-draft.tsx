"use client";

import { useState, useTransition } from "react";
import { draftReplyAction } from "@/app/actions/intent";

/** Draft a reply with AI, then copy it and post it yourself. */
export function ReplyDraft({ leadId, initial, url }: { leadId: string; initial: string | null; url: string }) {
  const [reply, setReply] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const draft = (regenerate: boolean) =>
    start(async () => {
      setError(null);
      const r = await draftReplyAction(leadId, regenerate);
      if (r.ok) setReply(r.reply);
      else setError(r.error);
    });

  return (
    <div className="mt-3">
      {reply ? (
        <>
          <textarea
            className="input min-h-28 w-full font-sans text-sm"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            aria-label="Reply draft"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(reply);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* ignore */
                }
              }}
            >
              {copied ? "Copied" : "Copy reply"}
            </button>
            <a className="btn" href={url} target="_blank" rel="noreferrer noopener">
              Open thread to post it ↗
            </a>
            <button type="button" className="btn" disabled={pending} onClick={() => draft(true)}>
              {pending ? "Drafting…" : "Redraft (1 cr)"}
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn" disabled={pending} onClick={() => draft(false)}>
          {pending ? "Drafting…" : "Draft a reply (1 cr)"}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
