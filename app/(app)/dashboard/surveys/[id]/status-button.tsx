"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteSurvey, setSurveyStatus } from "@/app/actions/surveys";

export function SurveyStatusButton({ surveyId, status }: { surveyId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const next = status === "live" ? "paused" : "live";
  return <div className="flex flex-wrap items-center justify-end gap-2 text-right">
    <button className="btn" disabled={pending} onClick={() => startTransition(async () => {
      setError("");
      const result = await setSurveyStatus({ surveyId, status: next });
      if (!result.ok) { setError(result.error); return; }
      router.refresh();
    })}>{pending ? "Saving…" : next === "paused" ? "Pause survey" : "Resume survey"}</button>
    <button className="btn" disabled={pending} onClick={() => {
      if (!window.confirm("Delete this survey, its invitations and all responses? This cannot be undone.")) return;
      startTransition(async () => {
        setError("");
        const result = await deleteSurvey({ surveyId });
        if (!result.ok) { setError(result.error); return; }
        router.push("/dashboard/surveys");
        router.refresh();
      });
    }}>Delete</button>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
  </div>;
}
