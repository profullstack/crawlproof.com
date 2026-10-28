"use client";

// All passphrase work happens here, in the browser (WebCrypto). The server
// receives the seal (ciphertext + salt + public key) and, to unlock, the data
// key. The passphrase and recovery key never leave this page.

import { useCallback, useEffect, useState } from "react";
import {
  bytesToBase64,
  createSeal,
  rewrapSeal,
  unlockSeal,
  unlockSealWithRecovery,
  wipe,
  MIN_PASSPHRASE_LENGTH,
  type SealRecord,
} from "@/lib/sealed/crypto";

type Status = {
  user_id: string;
  has_seal: boolean;
  seal: SealRecord | null;
  unlocked: boolean;
  expires_at: string | null;
  state: "setup_required" | "locked" | "unlocked";
  waiting: { queued_posts: number; locked_feeds: number };
  operator?: { name: string; sealed: boolean; unlocked: boolean; envFallback: boolean }[];
};

const TTLS: [string, number][] = [
  ["1 hour", 3600],
  ["8 hours", 8 * 3600],
  ["1 day", 86400],
  ["7 days (max)", 7 * 86400],
];

export function KeysPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [ttl, setTtl] = useState(8 * 3600);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [shownRecovery, setShownRecovery] = useState<string | null>(null);
  const [newPass, setNewPass] = useState("");
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/keys", { cache: "no-store" });
    if (r.ok) {
      const s = (await r.json()) as Status;
      setStatus(s);
      if (s.operator) setTtl((t) => (t === 8 * 3600 ? 7 * 86400 : t));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(path: string, body: unknown) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  }

  async function setup() {
    if (!status) return;
    if (pass.length < MIN_PASSPHRASE_LENGTH) return setMsg(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    if (pass !== pass2) return setMsg("The two passphrases differ.");
    setBusy(true);
    setMsg("Deriving your key (this takes a few seconds)...");
    try {
      const created = await createSeal(pass, status.user_id);
      const dek = bytesToBase64(created.dek);
      wipe(created.dek);
      const res = await post("/api/keys/setup", { seal: created.seal, dek, ttl_seconds: ttl, reset: status.has_seal });
      setShownRecovery(created.recoveryKey);
      setMsg(`Set up and unlocked. Migrated ${res.migration?.migrated ?? 0} stored secret(s) to your key.`);
      setPass("");
      setPass2("");
      setResetting(false);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (!status?.seal) return;
    setBusy(true);
    setMsg("Unlocking...");
    try {
      const dekBytes = useRecovery
        ? await unlockSealWithRecovery(status.seal, recovery, status.user_id)
        : await unlockSeal(status.seal, pass, status.user_id);
      const dek = bytesToBase64(dekBytes);
      wipe(dekBytes);
      const res = await post("/api/keys/unlock", { dek, ttl_seconds: ttl });
      setMsg(res.worker_unlocked ? "Unlocked. Waiting work resumes within a minute." : "Unlocked here, but the background worker did not confirm. Try again shortly.");
      setPass("");
      setRecovery("");
      await load();
    } catch (e) {
      setMsg((e as Error).name === "WrongPassphraseError" ? "Wrong passphrase." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    try {
      await post("/api/keys/lock", {});
      setMsg("Locked. Scheduled work waits until you unlock again.");
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changePassphrase() {
    if (!status?.seal) return;
    if (newPass.length < MIN_PASSPHRASE_LENGTH) return setMsg(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    setBusy(true);
    try {
      const dekBytes = await unlockSeal(status.seal, pass, status.user_id);
      const seal = await rewrapSeal(dekBytes, status.seal, newPass, status.user_id);
      const dek = bytesToBase64(dekBytes);
      wipe(dekBytes);
      await post("/api/keys/passphrase", { dek, seal });
      setMsg("Passphrase changed.");
      setPass("");
      setNewPass("");
      await load();
    } catch (e) {
      setMsg((e as Error).name === "WrongPassphraseError" ? "Current passphrase is wrong." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importOperator() {
    setBusy(true);
    try {
      const r = await post("/api/keys/operator", {});
      setMsg(`Sealed operator keys: ${r.imported.join(", ") || "none"}${r.missing.length ? ` (not in env: ${r.missing.join(", ")})` : ""}. Remove them from app.env next.`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div className="card p-5 text-sm">Loading...</div>;

  const ttlPicker = (
    <label className="block text-sm">
      Stay unlocked for{" "}
      <select className="input ml-2" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
        {TTLS.map(([label, s]) => (
          <option key={s} value={s}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm">
          Status:{" "}
          <strong>
            {status.state === "setup_required" ? "no passphrase yet (posting is paused)" : status.state === "unlocked" ? `unlocked until ${new Date(status.expires_at!).toLocaleString()}` : "locked (posting is paused)"}
          </strong>
        </p>
        {(status.waiting.queued_posts > 0 || status.waiting.locked_feeds > 0) && status.state !== "unlocked" && (
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Waiting: {status.waiting.queued_posts} queued post(s), {status.waiting.locked_feeds} feed(s).
          </p>
        )}
      </div>

      {shownRecovery && (
        <div className="card border-amber-500 p-5 text-sm">
          <h2 className="font-semibold">Your recovery key (shown once)</h2>
          <p className="mt-1">Store it somewhere safe. It is the only way back in if you forget your passphrase.</p>
          <code className="mt-2 block break-all font-mono">{shownRecovery}</code>
          <button className="btn mt-3" onClick={() => setShownRecovery(null)}>
            I saved it
          </button>
        </div>
      )}

      {(status.state === "setup_required" || resetting) && (
        <div className="card space-y-3 p-5">
          <h2 className="font-semibold">{resetting ? "Start over with a new passphrase" : "Set a key passphrase"}</h2>
          {resetting && (
            <p className="text-sm text-amber-500">
              Everything sealed under your old passphrase stays unreadable. Reconnect your accounts and re-enter your
              mailbox passwords afterwards.
            </p>
          )}
          <p className="text-sm text-[var(--color-muted)]">
            If you lose both this passphrase and the recovery key, your stored tokens are gone for good and you will
            need to reconnect your accounts. We cannot reset it for you.
          </p>
          <input className="input w-full" type="password" autoComplete="new-password" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
          <input className="input w-full" type="password" autoComplete="new-password" placeholder="Repeat passphrase" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          {ttlPicker}
          <button className="btn btn-primary" disabled={busy} onClick={setup}>
            Set passphrase and unlock
          </button>
        </div>
      )}

      {status.state === "locked" && !resetting && (
        <div className="card space-y-3 p-5">
          <h2 className="font-semibold">Unlock</h2>
          {useRecovery ? (
            <input className="input w-full font-mono" placeholder="Recovery key" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
          ) : (
            <input className="input w-full" type="password" autoComplete="current-password" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
          )}
          {ttlPicker}
          <div className="flex gap-3">
            <button className="btn btn-primary" disabled={busy} onClick={unlock}>
              Unlock
            </button>
            <button className="btn" onClick={() => setUseRecovery(!useRecovery)}>
              {useRecovery ? "Use passphrase" : "Use recovery key"}
            </button>
          </div>
          <button className="text-xs underline" onClick={() => setResetting(true)}>
            Lost both the passphrase and the recovery key?
          </button>
        </div>
      )}

      {status.state === "unlocked" && (
        <div className="card space-y-3 p-5">
          <button className="btn" disabled={busy} onClick={lock}>
            Lock now
          </button>
          <details>
            <summary className="cursor-pointer text-sm">Change passphrase</summary>
            <div className="mt-3 space-y-2">
              <input className="input w-full" type="password" placeholder="Current passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
              <input className="input w-full" type="password" autoComplete="new-password" placeholder="New passphrase" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
              <button className="btn" disabled={busy} onClick={changePassphrase}>
                Change
              </button>
            </div>
          </details>
        </div>
      )}

      {status.operator && (
        <div className="card space-y-2 p-5 text-sm">
          <h2 className="font-semibold">Operator keys (admin)</h2>
          <ul>
            {status.operator.map((o) => (
              <li key={o.name}>
                {o.name}: {o.sealed ? (o.unlocked ? "sealed, unlocked" : "sealed, LOCKED (job paused)") : o.envFallback ? "still read from env (seal it)" : "not configured"}
              </li>
            ))}
          </ul>
          {status.operator.some((o) => !o.sealed && o.envFallback) && status.state === "unlocked" && (
            <button className="btn" disabled={busy} onClick={importOperator}>
              Seal env operator keys under my key
            </button>
          )}
        </div>
      )}

      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
