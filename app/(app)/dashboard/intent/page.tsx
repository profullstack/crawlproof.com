import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listLeads, listWatches } from "@/lib/intent/store";
import {
  CADENCE_LABELS,
  INTENT_SWEEP_CREDITS,
  REPLY_DRAFT_CREDITS,
  TIER_HINTS,
  TIER_LABELS,
  isCadence,
  sourceLabel,
  type LeadTier,
} from "@/lib/intent/tiers";
import { INTENT_SOURCES } from "@/lib/outreach/intentSources";
import { trialStatus } from "@/lib/trial";
import { ReplyDraft } from "@/components/intent/reply-draft";
import {
  createWatchAction,
  deleteWatchAction,
  runWatchAction,
  setLeadStatusAction,
  toggleWatchAction,
  updateWatchAction,
} from "@/app/actions/intent";

export const metadata = { title: "Buyer intent" };
export const dynamic = "force-dynamic";

const TIER_BADGE: Record<LeadTier, string> = {
  hot: "badge badge-fail",
  engage: "badge badge-warn",
  monitor: "badge badge-unknown",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function IntentPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase
    .from("profiles")
    .select("trial_credits, trial_ends_at, credits_balance")
    .eq("id", user.id)
    .maybeSingle();
  const trial = trialStatus(profile);

  const watches = await listWatches(user.id);
  const selectedId = one(sp.watch);
  const selected = watches.find((w) => w.id === selectedId) ?? null;
  const tierParam = one(sp.tier);
  const tier = tierParam === "hot" || tierParam === "engage" || tierParam === "monitor" ? tierParam : null;
  const status = one(sp.status);
  const leads = watches.length ? await listLeads(user.id, { watchId: selected?.id, tier, status, limit: 150 }) : [];
  const notice = one(sp.notice);
  const error = one(sp.error);

  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | null> = { watch: selected?.id ?? null, tier, status, ...patch };
    for (const [k, v] of Object.entries(base)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/dashboard/intent?${s}` : "/dashboard/intent";
  };
  const csvHref = `/api/intent/v1/leads?format=csv${selected ? `&watch=${selected.id}` : ""}${tier ? `&tier=${tier}` : ""}`;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold">Buyer intent</h1>
          <p className="mt-1 max-w-2xl text-[var(--color-muted)]">
            People asking for what you sell on Reddit, Hacker News, Stack Exchange, X, LinkedIn, review sites and more,
            ranked by buying intent. Draft a reply, then post it yourself. No social logins, nothing posted for you.
          </p>
        </div>
        {trial.active && (
          <span className="badge badge-warn" title="Spent before your own credits">
            Free trial: {trial.daysLeft} days, {trial.creditsLeft} credits left
          </span>
        )}
      </div>

      {notice && <p className="card mt-6 p-3 text-sm text-[var(--color-pass)]">{notice}</p>}
      {error && <p className="card mt-6 p-3 text-sm text-[var(--color-fail)]">{error}</p>}

      <div className="mt-8 grid gap-6 lg:grid-cols-[18rem_1fr]">
        <aside className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">Watches</h2>
          <Link href="/dashboard/intent" className={`card block p-3 text-sm ${!selected ? "ring-2 ring-[var(--color-accent)]" : ""}`}>
            All leads
          </Link>
          {watches.map((w) => (
            <Link
              key={w.id}
              href={`/dashboard/intent?watch=${w.id}`}
              className={`card block p-3 text-sm ${selected?.id === w.id ? "ring-2 ring-[var(--color-accent)]" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <strong>{w.name}</strong>
                {!w.active && <span className="badge">paused</span>}
              </div>
              <div className="mt-1 text-xs text-[var(--color-muted)]">
                {isCadence(w.cadence) ? CADENCE_LABELS[w.cadence] : w.cadence}
                {w.last_run_at ? ` · ran ${ago(w.last_run_at)}` : ""}
              </div>
              {w.last_error && <div className="mt-1 text-xs text-[var(--color-fail)]">{w.last_error}</div>}
            </Link>
          ))}
          <a href="#new-watch" className="btn w-full">
            + New watch
          </a>
        </aside>

        <section>
          {selected && (
            <div className="card mb-6 flex flex-wrap items-center gap-2 p-4 text-sm">
              <span className="mr-auto">
                Tracking <strong>{[...selected.keywords, ...selected.competitors].join(", ") || "nothing yet"}</strong>
              </span>
              <form action={runWatchAction}>
                <input type="hidden" name="id" value={selected.id} />
                <button className="btn btn-primary">Sweep now ({INTENT_SWEEP_CREDITS} cr)</button>
              </form>
              <form action={toggleWatchAction}>
                <input type="hidden" name="id" value={selected.id} />
                <input type="hidden" name="active" value={selected.active ? "false" : "true"} />
                <button className="btn">{selected.active ? "Pause" : "Resume"}</button>
              </form>
              <a href="#edit-watch" className="btn">
                Settings
              </a>
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <Link href={qs({ tier: null })} className={`badge ${!tier ? "badge-pass" : ""}`}>
              All tiers
            </Link>
            {(["hot", "engage", "monitor"] as const).map((t) => (
              <Link key={t} href={qs({ tier: t })} className={tier === t ? TIER_BADGE[t] : "badge"}>
                {TIER_LABELS[t]}
              </Link>
            ))}
            <span className="mx-2 text-[var(--color-muted)]">|</span>
            <Link href={qs({ status: null })} className={`badge ${!status ? "badge-pass" : ""}`}>
              Open
            </Link>
            <Link href={qs({ status: "replied" })} className={`badge ${status === "replied" ? "badge-pass" : ""}`}>
              Replied
            </Link>
            <Link href={qs({ status: "dismissed" })} className={`badge ${status === "dismissed" ? "badge-pass" : ""}`}>
              Dismissed
            </Link>
            {leads.length > 0 && (
              <a href={csvHref} className="btn ml-auto">
                Export CSV
              </a>
            )}
          </div>

          {watches.length === 0 ? (
            <div className="card p-8 text-center">
              <h2 className="text-xl font-bold">Start with one watch</h2>
              <p className="mx-auto mt-2 max-w-lg text-sm text-[var(--color-muted)]">
                Name your product, add the phrases a buyer would use and the competitors they would compare you with. The first
                sweep runs as soon as you save.
              </p>
            </div>
          ) : leads.length === 0 ? (
            <div className="card p-8 text-center text-sm text-[var(--color-muted)]">
              No leads here yet. Sweeps run on each watch&apos;s schedule; widen the keywords or lower the minimum score if this
              stays empty.
            </div>
          ) : (
            <ul className="space-y-3">
              {leads.map((l) => (
                <li key={l.id} className="card p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                    <span className={TIER_BADGE[l.tier]} title={TIER_HINTS[l.tier]}>
                      {TIER_LABELS[l.tier]} · {l.score}
                    </span>
                    <span>{sourceLabel(l.source)}</span>
                    {l.posted_at && <span>· posted {ago(l.posted_at)}</span>}
                    {l.competitor && <span className="badge">mentions {l.competitor}</span>}
                    {l.decision_maker && <span className="badge badge-pass">decision maker</span>}
                    {l.status !== "new" && <span className="badge">{l.status}</span>}
                  </div>
                  <a href={l.url} target="_blank" rel="noreferrer noopener" className="mt-2 block font-semibold hover:underline">
                    {l.title || l.url}
                  </a>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">{l.snippet}</p>
                  {l.reasons.length > 0 && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">Why: {l.reasons.slice(0, 3).join("; ")}</p>
                  )}
                  <ReplyDraft leadId={l.id} initial={l.reply_draft} url={l.url} />
                  <div className="mt-2 flex gap-2 text-xs">
                    {l.status !== "replied" && (
                      <form action={setLeadStatusAction}>
                        <input type="hidden" name="id" value={l.id} />
                        <input type="hidden" name="status" value="replied" />
                        <button className="underline">Mark replied</button>
                      </form>
                    )}
                    {l.status !== "dismissed" && (
                      <form action={setLeadStatusAction}>
                        <input type="hidden" name="id" value={l.id} />
                        <input type="hidden" name="status" value="dismissed" />
                        <button className="underline">Dismiss</button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <WatchForm
        id="new-watch"
        title="New watch"
        action={createWatchAction}
        submit="Create watch and run the first sweep"
      />
      {selected && (
        <>
          <WatchForm id="edit-watch" title={`Settings: ${selected.name}`} action={updateWatchAction} submit="Save" watch={selected} />
          {selected.webhook_secret && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Webhook signing secret: <code className="font-mono">{selected.webhook_secret}</code>. Each delivery carries{" "}
              <code className="font-mono">x-crawlproof-signature: sha256=&lt;HMAC of the raw body&gt;</code>.
            </p>
          )}
          <form action={deleteWatchAction} className="mt-4">
            <input type="hidden" name="id" value={selected.id} />
            <button className="text-sm text-[var(--color-fail)] underline">Delete this watch and its leads</button>
          </form>
        </>
      )}

      <p className="mt-10 text-xs text-[var(--color-muted)]">
        A sweep costs {INTENT_SWEEP_CREDITS} credits, a reply draft {REPLY_DRAFT_CREDITS}. During your free trial they come out of
        your trial credits first. Also available over the API (<code className="font-mono">/api/intent/v1</code>), the CLI (
        <code className="font-mono">crawlproof intent</code>) and MCP.
      </p>
    </div>
  );
}

type WatchLike = {
  id: string;
  name: string;
  sells: string | null;
  keywords: string[];
  competitors: string[];
  negative_keywords: string[];
  sources: string[];
  cadence: string;
  min_score: number;
  slack_webhook_url: string | null;
  discord_webhook_url: string | null;
  webhook_url: string | null;
  email_digest: boolean;
};

function WatchForm({
  id,
  title,
  action,
  submit,
  watch,
}: {
  id: string;
  title: string;
  action: (fd: FormData) => Promise<void>;
  submit: string;
  watch?: WatchLike;
}) {
  const on = (s: string) =>
    watch?.sources.length ? watch.sources.includes(s) : s === "github" || INTENT_SOURCES.find((x) => x.id === s)?.defaultOn;
  return (
    <form id={id} action={action} className="card mt-10 grid gap-4 p-6 sm:grid-cols-2">
      <h2 className="text-xl font-bold sm:col-span-2">{title}</h2>
      {watch && <input type="hidden" name="id" value={watch.id} />}
      <label className="text-sm">
        Product or brand name
        <input name="name" required className="input mt-1" defaultValue={watch?.name} placeholder="Acme Analytics" />
      </label>
      <label className="text-sm">
        How often
        <select name="cadence" className="input mt-1" defaultValue={watch?.cadence ?? "daily"}>
          {Object.entries(CADENCE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v} ({INTENT_SWEEP_CREDITS} cr a sweep)
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm sm:col-span-2">
        What you sell, in a sentence (lets the model catch buyers who never use your keywords)
        <textarea name="sells" className="input mt-1 min-h-16" defaultValue={watch?.sells ?? ""} placeholder="Privacy-first web analytics for small SaaS teams that ties revenue to traffic sources." />
      </label>
      <label className="text-sm">
        Keywords and phrases, comma separated
        <input name="keywords" className="input mt-1" defaultValue={watch?.keywords.join(", ")} placeholder="analytics tool, google analytics alternative" />
      </label>
      <label className="text-sm">
        Competitors to track
        <input name="competitors" className="input mt-1" defaultValue={watch?.competitors.join(", ")} placeholder="Mixpanel, Amplitude" />
      </label>
      <label className="text-sm">
        Exclude posts containing
        <input name="negative_keywords" className="input mt-1" defaultValue={watch?.negative_keywords.join(", ")} placeholder="hiring, tutorial" />
      </label>
      <label className="text-sm">
        Minimum intent score (0 to 100)
        <input name="min_score" type="number" min={0} max={100} className="input mt-1" defaultValue={watch?.min_score ?? 25} />
      </label>
      <fieldset className="text-sm sm:col-span-2">
        <legend>Communities</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {[...INTENT_SOURCES, { id: "github", label: "GitHub issues", defaultOn: true }].map((s) => (
            <label key={s.id} className="flex items-center gap-1">
              <input type="checkbox" name="sources" value={s.id} defaultChecked={on(s.id)} /> {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="text-sm">
        Slack incoming webhook (optional)
        <input name="slack_webhook_url" className="input mt-1" defaultValue={watch?.slack_webhook_url ?? ""} placeholder="https://hooks.slack.com/services/…" />
      </label>
      <label className="text-sm">
        Discord webhook (optional)
        <input name="discord_webhook_url" className="input mt-1" defaultValue={watch?.discord_webhook_url ?? ""} placeholder="https://discord.com/api/webhooks/…" />
      </label>
      <label className="text-sm">
        Your own webhook, HMAC signed (Zapier, Make, n8n, HubSpot, Sheets…)
        <input name="webhook_url" className="input mt-1" defaultValue={watch?.webhook_url ?? ""} placeholder="https://hooks.zapier.com/…" />
      </label>
      <label className="flex items-center gap-2 self-end text-sm">
        <input type="checkbox" name="email_digest" defaultChecked={watch ? watch.email_digest : true} /> Email me a digest of new leads
      </label>
      <div className="sm:col-span-2">
        <button className="btn btn-primary">{submit}</button>
      </div>
    </form>
  );
}
