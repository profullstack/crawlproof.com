import Link from "next/link";
import { LEAD_RUN_CREDITS, CREDIT_RACK_CENTS, dollars } from "@/lib/credits";
import { LEADS_PER_CHARGE } from "@/lib/outreach/billing";

export const metadata = {
  title: "Lead generation & cold outreach",
  description:
    "Point CrawlProof at a directory or a search, and it finds the companies, finds the people, finds the addresses, writes the email, and reads the replies — from your own mailbox, grounded in facts you supply. 3 credits a run.",
  alternates: { canonical: "/lead-generation" },
  openGraph: {
    title: "Lead generation & cold outreach · CrawlProof",
    description:
      "Find the companies, find the people, find the addresses, write the email — from your own mailbox, grounded in facts you supply. 3 credits a run.",
    url: "/lead-generation",
  },
};

/**
 * The sales page for project-level lead generation.
 *
 * Every claim here is one the pipeline actually makes good on — a lead-gen
 * page that oversells is the exact thing the drafting guard exists to stop the
 * product doing to other people's inboxes. Where a number has a known error
 * bar, the page says so rather than rounding it away: open tracking measures a
 * floor, not a count, and claiming otherwise would be the first dishonest
 * sentence on it.
 */

const LADDER = [
  {
    step: "1",
    title: "The site itself",
    body: "Contact and about pages, footers, mailto: links, and the obfuscated addresses that are written to defeat scrapers.",
  },
  {
    step: "2",
    title: "Team & leadership pages",
    body: "A named person outperforms a shared inbox, so /our-team, /leadership and /people are read before anything is paid for.",
  },
  {
    step: "3",
    title: "Linked PDFs",
    body: "Capability statements, media kits and data-sheets routinely carry an address the page linking to them never mentions.",
  },
  {
    step: "4",
    title: "Search",
    body: "Only now does a run spend on a search call — for the people it has a name for but no way to reach.",
  },
  {
    step: "5",
    title: "A role address, last",
    body: "When a company publishes nothing at all, a conventional address like press@ is tried — and marked as a guess, not passed off as found.",
  },
];

export default function LeadGenerationPage() {
  const runRack = LEAD_RUN_CREDITS * CREDIT_RACK_CENTS;

  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
      <section className="text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
          Project feature · Leads
        </p>
        <h1 className="text-4xl font-extrabold sm:text-5xl">
          The boring half of cold outreach, done for you
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-[var(--color-muted)]">
          Finding who to email is most of the work and none of the fun. Point a campaign at a
          directory or a search, and CrawlProof finds the companies, finds the people, finds the
          addresses, and drafts the email — from your mailbox, in your words, about your thing.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="btn btn-primary">
            Start a campaign
          </Link>
          <Link href="/pricing" className="btn">
            See pricing
          </Link>
        </div>
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          {LEAD_RUN_CREDITS} credits a run (~{dollars(runRack)}). A run that finds nothing to do
          costs nothing.
        </p>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">It reads the directory like a person would</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Most lead directories are a wall of JavaScript. Fetching the HTML gets you an empty shell,
          which is why so much of this work ends up being done by hand.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card
            title="Renders the page"
            body="A real browser loads the listing, so AJAX results exist by the time anything is read."
          />
          <Card
            title="Scrolls and clicks Next"
            body="Infinite-scroll lists are scrolled; paginated ones are stepped through, and stop the moment a page repeats itself."
          />
          <Card
            title="Follows through to detail pages"
            body="A listing row is rarely the whole record, so entries are opened for the details the index leaves out."
          />
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">Directories that name people, not companies</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Plenty of the best lists give you a name, a title and a location and withhold the email —
          that is the product they are selling. Those are read as people: name, role, employer,
          location and profile links are kept, and the address becomes something to go and find
          rather than a reason to discard the lead.
        </p>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">Five places to look, cheapest first</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          The order is deliberate. Everything free is exhausted before anything paid is tried, so a
          run only spends on the prospects that genuinely publish nothing.
        </p>
        <ol className="mt-6 space-y-3">
          {LADDER.map((l) => (
            <li
              key={l.step}
              className="flex gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg)] font-mono text-sm font-bold">
                {l.step}
              </span>
              <div>
                <h3 className="font-semibold">{l.title}</h3>
                <p className="mt-1 text-sm text-[var(--color-muted)]">{l.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">The email can only say what you said</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          A campaign carries three things: who is writing, the one small thing you are asking for,
          and a list of checkable facts. Every draft is written from those and then checked against
          them — a draft that states something outside the list is thrown away rather than sent.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card
            title="Grounded, not generated"
            body="An AI writing cold email will happily invent a credential, a client list or a statistic. This one is not allowed to: the guard is the feature."
          />
          <Card
            title="Written for the recipient"
            body="Each draft opens with something specific to that company, taken from their own site — not a mail-merge of their domain name."
          />
          <Card
            title="Describe the goal, get the fields"
            body="If writing an intro, an ask and a fact list sounds like homework, describe what you are trying to do and have the fields drafted from it."
          />
          <Card
            title="Follow-ups that stop"
            body="At most two follow-ups on a schedule, and a reply ends the sequence — detected from your mailbox, not waiting on you to log it. Nobody gets a fourth email."
          />
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">Sent from your mailbox</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Give it the address you already send from and its settings are discovered automatically —
          the same lookup your mail client does. Replies come back to you, because the mail came
          from you.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Card
            title="Auto-discovered"
            body="Server, ports and encryption are resolved from your domain. The password is encrypted at rest with a key that is never in the database."
          />
          <Card
            title="Verified before it is trusted"
            body="The connection is tested when you save it, so a typo surfaces then rather than as a campaign that quietly sends nothing."
          />
          <Card
            title="Dry-run first"
            body="Leave auto-send off and drafts pile up for you to read. Turning it on is a deliberate act."
          />
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">It will refuse to email some people</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Cold outreach earns its reputation one careless send at a time. Privacy, legal, abuse,
          opt-out and accessibility addresses are never contacted, whatever a page publishes. A
          postal address for the footer is required before live sending is possible at all, because
          CAN-SPAM requires one. Anyone who asks to be left alone is suppressed across every
          campaign you run, permanently.
        </p>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">It reads the answers too</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          The same mailbox connection that sends is checked for what comes back, so a lead that
          answers is marked as answered without anybody remembering to do it — and the follow-up
          sequence stops on its own.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card
            title="Out-of-office is not a reply"
            body="Auto-responders, bounces and mailing-list traffic are recorded and flagged rather than counted. Counting them would inflate the one number worth reporting."
          />
          <Card
            title="Answers from a colleague still count"
            body="Mail to info@ often gets answered by a named person. A reply from anyone at the company is matched back to the lead it belongs to."
          />
          <Card
            title="Opens, honestly"
            body="A per-email pixel, with loads from privacy proxies discarded rather than counted. It measures a floor: the real number is higher, never lower."
          />
          <Card
            title="Nothing is marked by hand"
            body="Sent, opened, replied and closed are recorded as they happen — so a reply rate of zero means nobody answered, not that nobody logged it."
          />
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">Your numbers, not somebody else&apos;s</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Sends, opens, replies and closes are counted at three levels: the whole project, each
          campaign, and each individual run. Rates stay hidden until there is enough volume to mean
          anything — one reply out of three sends is not a 33% reply rate, and showing it as one
          invites a decision the sample cannot support.
        </p>
      </section>

      <section className="mt-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-8">
        <h2 className="text-2xl font-bold">What it costs</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <div className="text-3xl font-extrabold">
              {LEAD_RUN_CREDITS} credits
              <span className="ml-2 text-base font-normal text-[var(--color-muted)]">
                per run (~{dollars(runRack)})
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              A campaign run is one pass of the whole funnel: discovery, contact lookup, drafting
              and sending. A run with nothing to do is not charged, so leaving a campaign switched
              on between batches is free.
            </p>
          </div>
          <div>
            <div className="text-3xl font-extrabold">
              {LEAD_RUN_CREDITS} credits
              <span className="ml-2 text-base font-normal text-[var(--color-muted)]">
                per {LEADS_PER_CHARGE} leads
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              For a one-off search of a directory, priced by how much you ask for. Find nothing and
              it is refunded.
            </p>
          </div>
        </div>
        <p className="mt-6 text-sm text-[var(--color-muted)]">
          Credits are the same ones scans and articles use — no separate plan, no subscription, and
          they do not expire. Volume packs bring a run down to about{" "}
          {dollars(Math.round(runRack / 2))}.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/signup" className="btn btn-primary">
            Get started
          </Link>
          <Link href="/pricing" className="btn">
            Credit packs
          </Link>
        </div>
      </section>

      <p className="mt-10 text-center text-xs text-[var(--color-muted)]">
        Lead generation runs on projects you own. You are responsible for the mail you send and for
        complying with the rules where your recipients are — CrawlProof enforces a suppression list
        and a footer address, not the law.
      </p>
    </main>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}
