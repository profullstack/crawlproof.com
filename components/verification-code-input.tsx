"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitVerificationCode } from "@/app/actions/socialPosting";

// Shown on a browser post that's paused on an identity challenge
// (status 'awaiting_code'). The worker is holding the live session open and
// polling for the code; submitting it here lets the post finish.
export function VerificationCodeInput({
  postId,
  prompt,
}: {
  postId: string;
  prompt?: string | null;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <span className="text-[var(--color-muted)]">
        Code submitted — finishing the post…
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {prompt && (
        <span className="w-full text-[var(--color-warn)]">{prompt}</span>
      )}
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-0.5 tabular-nums"
      />
      <button
        type="button"
        disabled={pending || !code.trim()}
        onClick={() => {
          setErr(null);
          start(async () => {
            const r = await submitVerificationCode({ postId, code });
            if (!r.ok) {
              setErr(r.error);
              return;
            }
            setDone(true);
            router.refresh();
          });
        }}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 font-medium hover:bg-[var(--color-card)] disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Submit code"}
      </button>
      {err && (
        <span className="w-full text-red-600" title={err}>
          {err}
        </span>
      )}
    </span>
  );
}
