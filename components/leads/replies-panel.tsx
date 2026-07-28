export type ReplyRow = {
  from_email: string;
  subject: string | null;
  snippet: string | null;
  received_at: string;
  auto_reply: boolean;
};

/**
 * What came back.
 *
 * The funnel above reports how many replied; this is the part that decides
 * what to do next, which is never a count. Auto-replies are shown rather than
 * hidden — an out-of-office is worth knowing about even though it is not an
 * answer — but they are visibly separated, because burying them in the same
 * list is how a reply rate ends up meaning nothing.
 */
export function RepliesPanel({ replies }: { replies: ReplyRow[] }) {
  if (!replies.length) return null;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Replies</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Read from your connected mailbox. Answer from your own mail client — this is a record,
          not an inbox.
        </p>
      </div>

      <ul className="mt-3 divide-y divide-[var(--color-border)]">
        {replies.map((r, i) => (
          <li key={`${r.received_at}-${i}`} className="py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {r.from_email}
              {r.auto_reply && <span className="badge badge-unknown">auto-reply</span>}
              <span className="font-mono text-xs font-normal text-[var(--color-muted)]">
                {r.received_at.slice(0, 16).replace("T", " ")}
              </span>
            </p>
            {r.subject && <p className="mt-1 text-sm">{r.subject}</p>}
            {r.snippet && (
              <p className="mt-1 text-xs text-[var(--color-muted)]">{r.snippet}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
