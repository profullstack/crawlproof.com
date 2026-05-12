export function ScoreBadge({
  score,
  status,
}: {
  score: number | null;
  status: string;
}) {
  if (status !== "complete" || score === null) {
    return <span className="badge badge-unknown">{status}</span>;
  }
  const cls = score >= 80 ? "badge-pass" : score >= 50 ? "badge-warn" : "badge-fail";
  return <span className={`badge ${cls}`}>{score} / 100</span>;
}
