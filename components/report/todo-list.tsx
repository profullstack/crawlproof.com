import type { TodoItem } from "@/lib/audit/recommendations";

/**
 * The audit as a checklist: one imperative step per fix, naming the exact
 * URL, header or tag, highest score impact first. Built from the findings by
 * buildTodoList, so it reads the same for old audits as for new ones.
 */
export function TodoList({ items, score }: { items: TodoItem[]; score?: number | null }) {
  const total = Math.round(items.reduce((sum, t) => sum + t.points, 0));
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--color-muted)]">
        {items.length} step{items.length === 1 ? "" : "s"}, highest impact first.
        {score != null && total > 0
          ? ` Doing all of them is worth about ${Math.min(total, 100 - score)} points on the ${score}/100 score.`
          : ""}
      </p>
      <ol className="space-y-2">
        {items.map((t, i) => (
          <li key={`${t.check_key}-${i}`} className="card p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 font-mono text-sm text-[var(--color-muted)]">{i + 1}.</span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold break-words">{t.step}</div>
                {t.value && (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] p-2 font-mono text-xs">
                    {t.value}
                  </pre>
                )}
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  <span className={t.status === "fail" ? "text-[var(--color-fail)]" : "text-[var(--color-warn)]"}>
                    Found:
                  </span>{" "}
                  {t.why}. {firstParagraph(t.how)}
                </p>
              </div>
              <span className="badge whitespace-nowrap text-xs" title="Score points this step is worth">
                +{t.points} pts
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function firstParagraph(how: string): string {
  return how.split(/\n\n/)[0]!.replace(/`/g, "");
}
