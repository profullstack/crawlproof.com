"use client";

import { useState, useTransition } from "react";
import { submitSurveyResponse } from "@/app/actions/surveys";

export function SurveyResponseForm({ token, answerType }: { token: string; answerType: string }) {
  const [pending, start] = useTransition();
  const [rating, setRating] = useState(0);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    start(async () => {
      const result = await submitSurveyResponse({ token, rating, answer });
      if (!result.ok) { setError(result.error); return; }
      setSubmitted(true);
    });
  }

  if (submitted) return <p role="status" className="rounded border border-[var(--color-border)] p-4 text-sm">Thanks for sharing your feedback.</p>;

  return <form onSubmit={submit} className="space-y-5">
    {answerType === "rating" ? (
      <fieldset>
        <legend className="mb-2 text-sm text-[var(--color-muted)]">Choose a rating from 1 (low) to 5 (high)</legend>
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" aria-pressed={rating === value} onClick={() => setRating(value)} className={`h-12 w-12 rounded border font-semibold ${rating === value ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white" : "border-[var(--color-border)]"}`}>{value}</button>)}
        </div>
      </fieldset>
    ) : (
      <label className="block text-sm font-medium">Your response
        <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={4000} rows={5} className="input mt-1 w-full" required />
      </label>
    )}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <button className="btn btn-primary w-full" disabled={pending}>{pending ? "Submitting…" : "Submit response"}</button>
  </form>;
}
