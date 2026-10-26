"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const COOKIE = "cp_invite";

/** Keeps the code in a cookie through signup, or accepts it for a signed-in account. */
export function InviteLanding({ code, signedIn }: { code: string; signedIn: boolean }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${COOKIE}=${encodeURIComponent(code)}; Max-Age=${60 * 60 * 24 * 30}; path=/; SameSite=Lax${secure}`;
  }, [code]);

  async function accept() {
    setBusy(true);
    try {
      const res = await fetch("/api/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setMsg({ ok: res.ok, text: body.message ?? body.error ?? "Done." });
    } catch {
      setMsg({ ok: false, text: "Network error. Try again." });
    } finally {
      setBusy(false);
      document.cookie = `${COOKIE}=; Max-Age=0; path=/; SameSite=Lax`;
    }
  }

  if (signedIn) {
    return (
      <div className="space-y-3">
        <button type="button" className="btn btn-primary w-full" onClick={accept} disabled={busy || msg?.ok}>
          {busy ? "Accepting..." : "Accept invite"}
        </button>
        {msg && (
          <p role="status" className={`text-sm ${msg.ok ? "text-[var(--color-pass)]" : "text-[var(--color-fail)]"}`}>
            {msg.text}
          </p>
        )}
        <Link href="/dashboard/invites" className="block text-sm underline">
          Go to your invites
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Link href={`/signup?invite=${encodeURIComponent(code)}`} className="btn btn-primary block w-full">
        Create your account
      </Link>
      <p className="text-sm text-[var(--color-muted)]">
        Already have an account?{" "}
        <Link href={`/login?redirect=${encodeURIComponent(`/i/${code}`)}`} className="underline">
          Sign in
        </Link>{" "}
        to accept it.
      </p>
    </div>
  );
}
