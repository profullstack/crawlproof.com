"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  runCampaignAction,
  saveCampaignAction,
  toggleCampaignAction,
} from "@/app/actions/leads";

export type CampaignRun = {
  ran_at: string;
  summary: string;
  ok: boolean;
  errors: string[];
};

export type CampaignSummary = {
  name: string;
  active: boolean;
  auto_send: boolean;
  daily_send_limit: number;
  max_score: number;
  queries: string[];
  seed_urls: string[];
  last_run_at: string | null;
  last_run_note: string | null;
  pitch_mode: "audit" | "custom";
  pitch_intro: string | null;
  pitch_ask: string | null;
  pitch_facts: string[];
  scan_prospects: boolean;
  auth_required_hosts: string[];
  runs: CampaignRun[];
};

/**
 * Campaigns are the autopilot: the cron tick finds leads, scans them,
 * researches contacts and writes drafts on its own. Sending is the one thing
 * it will not do until auto-send is switched on deliberately — a new campaign
 * logs every message as a dry run so you can read a few first.
 */
export function CampaignPanel({
  projectId,
  campaigns,
  canSendLive,
}: {
  projectId: string;
  campaigns: CampaignSummary[];
  canSendLive: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Which button is in flight, so only that one shows a spinner instead of
  // every button in the panel going quiet at once.
  const [busy, setBusy] = useState<string | null>(null);
  // Result of the last action per campaign, shown next to that campaign
  // rather than in one shared line at the top of the panel.
  const [rowNote, setRowNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState<string | null>(null);
  const [open, setOpen] = useState(campaigns.length === 0);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [queries, setQueries] = useState("");
  const [seedUrls, setSeedUrls] = useState("");
  const [maxScore, setMaxScore] = useState(70);
  const [dailyLimit, setDailyLimit] = useState(10);
  const [angle, setAngle] = useState("");
  const [pitchMode, setPitchMode] = useState<"audit" | "custom">("audit");
  const [pitchIntro, setPitchIntro] = useState("");
  const [pitchAsk, setPitchAsk] = useState("");
  const [pitchFacts, setPitchFacts] = useState("");
  const [scanProspects, setScanProspects] = useState(true);
  const [senderName, setSenderName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  const act = (fn: () => Promise<{ ok: true; note: string } | { ok: false; error: string }>) =>
    start(async () => {
      setNote(null);
      setError(null);
      const res = await fn();
      if (res.ok) {
        setNote(res.note);
        router.refresh();
      } else setError(res.error);
    });

  // Runs one campaign-row action: marks that button busy, then reports the
  // outcome inline next to the campaign it belongs to.
  const rowAct = (
    key: string,
    campaignName: string,
    fn: () => Promise<{ ok: true; note?: string } | { ok: false; error: string }>,
  ) =>
    start(async () => {
      setBusy(key);
      setRowNote((prev) => ({ ...prev, [campaignName]: undefined as never }));
      const res = await fn();
      setRowNote((prev) => ({
        ...prev,
        [campaignName]: res.ok
          ? { ok: true, text: res.note ?? "Done." }
          : { ok: false, text: res.error },
      }));
      setBusy(null);
      if (res.ok) router.refresh();
    });

  // Load an existing campaign into the form so it can be changed. Saving
  // upserts on (project, name), so keeping the name edits in place.
  const startEdit = (c: CampaignSummary) => {
    setEditing(c.name);
    setName(c.name);
    setQueries(c.queries.join("\n"));
    setSeedUrls(c.seed_urls.join("\n"));
    setMaxScore(c.max_score);
    setDailyLimit(c.daily_send_limit);
    setPitchMode(c.pitch_mode);
    setPitchIntro(c.pitch_intro ?? "");
    setPitchAsk(c.pitch_ask ?? "");
    setPitchFacts((c.pitch_facts ?? []).join("\n"));
    setScanProspects(c.scan_prospects);
    setOpen(true);
  };

  const save = () =>
    act(async () =>
      saveCampaignAction({
        projectId,
        name,
        queries,
        seedUrls,
        maxScore,
        dailySendLimit: dailyLimit,
        autoSend: false,
        active: true,
        angle,
        senderName,
        replyTo,
        pitchMode,
        pitchIntro,
        pitchAsk,
        pitchFacts,
        scanProspects,
      }),
    );

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Campaigns</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Runs every 15 minutes: finds leads, scans them, writes drafts. Only sends when you turn
            auto-send on.
          </p>
        </div>
        <button
          onClick={() => {
            if (open) setEditing(null);
            setOpen(!open);
          }}
          className="btn text-sm"
        >
          {open ? "Close" : "New campaign"}
        </button>
      </div>

      {note && <p className="mt-3 text-sm">{note}</p>}
      {error && <p className="mt-3 text-sm text-[var(--color-danger,#f87171)]">{error}</p>}

      {campaigns.length > 0 && (
        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {campaigns.map((c) => (
            <li key={c.name} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {c.name}{" "}
                  <span className={`badge ${c.active ? "badge-pass" : "badge-unknown"}`}>
                    {c.active ? "active" : "paused"}
                  </span>{" "}
                  <span className={`badge ${c.auto_send ? "badge-warn" : "badge-unknown"}`}>
                    {c.auto_send ? "auto-send ON" : "drafts only"}
                  </span>
                </p>
                <p className="mt-1 truncate text-xs text-[var(--color-muted)]">
                  {[...c.queries, ...c.seed_urls].join(" · ") || "no sources"} — pitches ≤{c.max_score}
                  /100, max {c.daily_send_limit}/day
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {c.last_run_at
                    ? `Last tick ${c.last_run_at.slice(0, 16).replace("T", " ")}: ${c.last_run_note ?? ""}`
                    : "Never run"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() =>
                    rowAct(`run:${c.name}`, c.name, () =>
                      runCampaignAction({ projectId, name: c.name }),
                    )
                  }
                  disabled={pending}
                  className="btn text-sm"
                >
                  {busy === `run:${c.name}` ? "Running…" : "Run now"}
                </button>
                <button onClick={() => startEdit(c)} disabled={pending} className="btn text-sm">
                  Edit
                </button>
                <button
                  onClick={() =>
                    rowAct(`active:${c.name}`, c.name, () =>
                      toggleCampaignAction({ projectId, name: c.name, field: "active", value: !c.active }),
                    )
                  }
                  disabled={pending}
                  className="btn text-sm"
                >
                  {busy === `active:${c.name}`
                    ? "Saving…"
                    : c.active
                      ? "Pause"
                      : "Resume"}
                </button>
                <button
                  onClick={() => {
                    if (
                      !c.auto_send &&
                      !confirm(
                        `Turn on auto-send for "${c.name}"? It will email real people on every tick, up to ${c.daily_send_limit} a day.`,
                      )
                    ) {
                      return;
                    }
                    rowAct(`send:${c.name}`, c.name, () =>
                      toggleCampaignAction({ projectId, name: c.name, field: "auto_send", value: !c.auto_send }),
                    );
                  }}
                  disabled={pending || (!c.auto_send && !canSendLive)}
                  className="btn text-sm"
                  title={canSendLive ? "" : "OUTREACH_POSTAL_ADDRESS must be set before live sending"}
                >
                  {busy === `send:${c.name}`
                    ? "Saving…"
                    : c.auto_send
                      ? "Stop sending"
                      : "Enable sending"}
                </button>
                {c.runs.length > 0 && (
                  <button
                    onClick={() => setShowHistory(showHistory === c.name ? null : c.name)}
                    className="btn text-sm"
                  >
                    {showHistory === c.name ? "Hide history" : "History"}
                  </button>
                )}
              </div>

              {rowNote[c.name] && (
                <p
                  className={`w-full text-sm ${
                    rowNote[c.name].ok ? "" : "text-[var(--color-danger,#f87171)]"
                  }`}
                >
                  {rowNote[c.name].text}
                </p>
              )}

              {c.auth_required_hosts.length > 0 && (
                <p className="w-full text-xs">
                  <span className="badge badge-warn">waiting_for_auth</span>{" "}
                  <span className="text-[var(--color-muted)]">
                    needs a sign-in for {c.auth_required_hosts.length} seed — add one under Seed
                    logins below.
                  </span>
                </p>
              )}

              {showHistory === c.name && (
                <div className="w-full rounded border border-[var(--color-border)] p-3">
                  <p className="text-xs font-medium">Recent ticks</p>
                  <ul className="mt-2 space-y-2">
                    {c.runs.map((r) => (
                      <li key={r.ran_at} className="text-xs">
                        <span className={r.ok ? "" : "text-[var(--color-danger,#f87171)]"}>
                          {r.ok ? "✓" : "✕"} {r.ran_at.slice(0, 16).replace("T", " ")}
                        </span>{" "}
                        <span className="text-[var(--color-muted)]">{r.summary}</span>
                        {r.errors.length > 0 && (
                          <ul className="ml-4 mt-1 list-disc text-[var(--color-muted)]">
                            {r.errors.slice(0, 5).map((e, i) => (
                              <li key={i} className="break-all">
                                {e}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-4 grid gap-3 border-t border-[var(--color-border)] pt-4 sm:grid-cols-2">
          <label className="text-sm">
            Name
            <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Miami dentists" />
          </label>
          <label className="text-sm">
            Sign-off name
            <input className="input mt-1 w-full" value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Anthony" />
          </label>
          <label className="text-sm sm:col-span-2">
            Search queries — one per line
            <textarea
              className="input mt-1 h-20 w-full font-mono text-xs"
              value={queries}
              onChange={(e) => setQueries(e.target.value)}
              placeholder={"dentists in Miami\northodontist Fort Lauderdale"}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Directory pages — one per line
            <textarea
              className="input mt-1 h-16 w-full font-mono text-xs"
              value={seedUrls}
              onChange={(e) => setSeedUrls(e.target.value)}
              placeholder="https://example.com/best-dentists-miami"
            />
          </label>
          <label className="text-sm">
            Only pitch sites scoring ≤
            <input
              type="number"
              className="input mt-1 w-full"
              value={maxScore}
              min={10}
              max={95}
              onChange={(e) => setMaxScore(Number(e.target.value))}
            />
          </label>
          <label className="text-sm">
            Max sends per day
            <input
              type="number"
              className="input mt-1 w-full"
              value={dailyLimit}
              min={1}
              max={100}
              onChange={(e) => setDailyLimit(Number(e.target.value))}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            What is this campaign pitching?
            <select
              className="input mt-1 w-full"
              value={pitchMode}
              onChange={(e) => {
                const next = e.target.value as "audit" | "custom";
                setPitchMode(next);
                // Scanning is the audit pitch's evidence step. A custom pitch
                // has no reason to scan the people it writes to.
                setScanProspects(next === "audit");
              }}
            >
              <option value="audit">A CrawlProof scan of their site</option>
              <option value="custom">Something else — I&apos;ll describe it</option>
            </select>
          </label>

          {pitchMode === "custom" && (
            <>
              <label className="text-sm sm:col-span-2">
                Who is writing, and why
                <textarea
                  className="input mt-1 w-full"
                  rows={2}
                  value={pitchIntro}
                  onChange={(e) => setPitchIntro(e.target.value)}
                  placeholder="Anthony, a freelance 3D modeller looking for contract work with game studios"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                Facts drafts may state — one per line
                <textarea
                  className="input mt-1 w-full font-mono text-xs"
                  rows={4}
                  value={pitchFacts}
                  onChange={(e) => setPitchFacts(e.target.value)}
                  placeholder={"9 years of experience in hard-surface modelling\nPortfolio at https://example.com/work\nAvailable from March"}
                />
                <span className="mt-1 block text-xs text-[var(--color-muted)]">
                  Drafts are checked against this list and rejected if they state anything else.
                  Numbers and links that don&apos;t appear here are treated as invented.
                </span>
              </label>
              <label className="text-sm sm:col-span-2">
                The one ask
                <input
                  className="input mt-1 w-full"
                  value={pitchAsk}
                  onChange={(e) => setPitchAsk(e.target.value)}
                  placeholder="take a look at my portfolio"
                />
              </label>
            </>
          )}

          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={scanProspects}
              onChange={(e) => setScanProspects(e.target.checked)}
              disabled={pitchMode === "audit"}
            />
            <span>
              Scan each discovered lead
              <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                {pitchMode === "audit"
                  ? "Required for the audit pitch — the email is built from what the scan finds."
                  : "Off by default: this campaign isn't pitching an audit, so there's nothing to scan for."}
              </span>
            </span>
          </label>

          <label className="text-sm sm:col-span-2">
            Angle (optional)
            <input
              className="input mt-1 w-full"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              placeholder="lead with the booking flow, they take appointments online"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Reply-To
            <input className="input mt-1 w-full" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="you@yourdomain.com" />
          </label>
          <div className="sm:col-span-2">
            <button onClick={save} disabled={pending || !name.trim()} className="btn btn-primary">
              {pending ? "Saving…" : editing ? `Save changes to "${editing}"` : "Create campaign"}
            </button>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Starts in drafts-only mode. Read a few of what it writes, then enable sending.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
