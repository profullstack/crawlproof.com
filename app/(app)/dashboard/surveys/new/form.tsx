"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSurvey } from "@/app/actions/surveys";

export type SurveyProjectOption = { id: string; name: string; url: string; organization_id: string };

export function NewSurveyForm({ projects }: { projects: SurveyProjectOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [answerType, setAnswerType] = useState<"rating" | "text">("rating");
  const [aSubject, setASubject] = useState("One quick question about your experience");
  const [aMessage, setAMessage] = useState("Would you share quick feedback about your experience?");
  const [bSubject, setBSubject] = useState("Help us improve");
  const [bMessage, setBMessage] = useState("Could you spare a minute to answer one question?");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const project = projects.find((item) => item.id === projectId);
    if (!project) { setError("Choose a site."); return; }
    startTransition(async () => {
      const result = await createSurvey({
        organizationId: project.organization_id,
        projectId,
        title,
        question,
        answerType,
        variants: [
          { subject: aSubject, message: aMessage },
          { subject: bSubject, message: bMessage },
        ],
      });
      if (!result.ok) { setError(result.error); return; }
      router.push(`/dashboard/surveys/${result.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="card space-y-4 p-5">
        <h2 className="text-lg font-semibold">Survey</h2>
        <label className="block text-sm font-medium">Site
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="input mt-1 block w-full">
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.url}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={100} className="input mt-1 block w-full" placeholder="Post-purchase feedback" />
        </label>
        <label className="block text-sm font-medium">Question
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} required maxLength={500} rows={3} className="input mt-1 block w-full" placeholder="How easy was it to get started?" />
        </label>
        <label className="block text-sm font-medium">Answer format
          <select value={answerType} onChange={(event) => setAnswerType(event.target.value as "rating" | "text")} className="input mt-1 block w-full sm:w-64">
            <option value="rating">Rating from 1 to 5</option>
            <option value="text">Written response</option>
          </select>
        </label>
      </section>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="text-lg font-semibold">Invitation A/B test</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">Each recipient is assigned one version consistently. The survey question stays the same in both groups.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <VariantFields label="Variant A" subject={aSubject} message={aMessage} onSubject={setASubject} onMessage={setAMessage} />
          <VariantFields label="Variant B" subject={bSubject} message={bMessage} onSubject={setBSubject} onMessage={setBMessage} />
        </div>
      </section>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button disabled={pending} className="btn btn-primary">{pending ? "Creating…" : "Create survey"}</button>
    </form>
  );
}

function VariantFields({ label, subject, message, onSubject, onMessage }: {
  label: string;
  subject: string;
  message: string;
  onSubject: (value: string) => void;
  onMessage: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-3 rounded border border-[var(--color-border)] p-4">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <label className="block text-xs font-medium">Email subject
        <input value={subject} onChange={(event) => onSubject(event.target.value)} maxLength={120} className="input mt-1 block w-full" />
      </label>
      <label className="block text-xs font-medium">Invitation message
        <textarea value={message} onChange={(event) => onMessage(event.target.value)} required maxLength={240} rows={3} className="input mt-1 block w-full" />
      </label>
    </fieldset>
  );
}
