import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/lib/lx/currentSite";
import { updateKeywordPlan } from "./actions";

export const metadata = { title: "Autoblog · Plan" };

const ARTICLE_TYPES = [
  ["", "Auto"],
  ["guide", "Guide"],
  ["comparison", "Comparison"],
  ["listicle", "Listicle"],
  ["alternative", "Alternative"],
  ["faq", "FAQ"],
  ["tutorial", "Tutorial"],
  ["case-study", "Case study"],
  ["glossary", "Glossary"],
] as const;

type KeywordRow = {
  id: string;
  keyword: string;
  scheduled_for: string;
  status: string;
  search_volume: number | null;
  difficulty: number | null;
  article_type: string | null;
  custom_instructions: string | null;
  article_id: string | null;
  created_at: string;
};

function monthWindow(): { start: string; end: string } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function statusClass(status: string): string {
  if (status === "published") return "badge-pass";
  if (status === "failed") return "badge-fail";
  if (status === "generating") return "badge-warn";
  return "";
}

export default async function AutoblogPlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const project = await getProjectById(projectId, {
    siteColumns: "id, domain, status",
    projectColumns: "id, name, url",
  });
  if (!project) notFound();
  const site = project.lx_site as
    | { id: string; domain: string; status: string }
    | null;
  if (!site) redirect(`/dashboard/projects/${projectId}/autoblog/setup`);

  const { start, end } = monthWindow();
  const { data } = await supabase
    .from("lx_keyword")
    .select(
      "id, keyword, scheduled_for, status, search_volume, difficulty, article_type, custom_instructions, article_id, created_at",
    )
    .eq("site_id", site.id)
    .gte("scheduled_for", start)
    .lte("scheduled_for", end)
    .order("scheduled_for", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(90);
  const rows = (data ?? []) as KeywordRow[];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <Link
            href={`/dashboard/projects/${projectId}/autoblog`}
            className="text-sm text-[var(--color-muted)]"
          >
            ← Autoblog
          </Link>
          <h1 className="mt-2 text-3xl font-bold">Content plan</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {site.domain} · next 30 days of planned topics
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/dashboard/projects/${projectId}/autoblog`} className="btn">
            Dashboard
          </Link>
          <Link href={`/dashboard/projects/${projectId}/autoblog/history`} className="btn">
            Articles
          </Link>
        </div>
      </header>

      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">30-day queue</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Reschedule queued topics and add article-specific instructions
              before generation starts.
            </p>
          </div>
          <div className="text-sm text-[var(--color-muted)]">
            {start} to {end}
          </div>
        </div>
      </section>

      {rows.length === 0 ? (
        <section className="card p-5">
          <p className="text-sm text-[var(--color-muted)]">
            No planned topics in the next 30 days. Generate keywords from the
            Autoblog dashboard to seed the plan.
          </p>
        </section>
      ) : (
        <section className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-4">Topic</th>
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Metrics</th>
                <th className="py-2 pr-4">Instructions</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {rows.map((row) => {
                const editable =
                  row.status === "queued" || row.status === "failed";
                const action = updateKeywordPlan.bind(null, projectId, row.id);
                return (
                  <tr key={row.id} className="align-top">
                    <td className="py-3 pr-4">
                      <div className="font-medium">{row.keyword}</div>
                      {row.article_id && (
                        <Link
                          href={`/dashboard/projects/${projectId}/autoblog/articles/${row.article_id}`}
                          className="mt-1 inline-flex text-xs text-[var(--color-accent)] hover:underline"
                        >
                          Open article
                        </Link>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <form action={action} id={`plan-${row.id}`} />
                      <input
                        form={`plan-${row.id}`}
                        type="date"
                        name="scheduled_for"
                        defaultValue={row.scheduled_for}
                        disabled={!editable}
                        className="input min-w-36"
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <select
                        form={`plan-${row.id}`}
                        name="article_type"
                        defaultValue={row.article_type ?? ""}
                        disabled={!editable}
                        className="input min-w-36"
                      >
                        {ARTICLE_TYPES.map(([value, label]) => (
                          <option key={value || "auto"} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 pr-4 text-xs text-[var(--color-muted)]">
                      <div>Vol: {row.search_volume ?? "—"}</div>
                      <div>KD: {row.difficulty ?? "—"}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <textarea
                        form={`plan-${row.id}`}
                        name="custom_instructions"
                        defaultValue={row.custom_instructions ?? ""}
                        disabled={!editable}
                        rows={3}
                        className="input min-w-80 resize-y"
                        placeholder="Angle, examples, products, claims to include..."
                      />
                      {editable && (
                        <button
                          form={`plan-${row.id}`}
                          type="submit"
                          className="btn mt-2"
                        >
                          Save
                        </button>
                      )}
                    </td>
                    <td className="py-3">
                      <span className={`badge ${statusClass(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

