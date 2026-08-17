"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

const MAX_FIX_PROMPT_LENGTH = 12_000;

interface Repo {
  full_name: string;
  installation_id: number;
}

interface ApplyFixButtonProps {
  projectId: string;
  auditId: string;
  findingKey: string;
  findingTitle: string;
  /** Every repo across the user's installations. */
  repos: Repo[];
  /** Subset already bound to the project. Pre-selected when present. */
  boundRepos: Repo[];
}

interface FixResult {
  status: "opened" | "noop";
  prUrl?: string;
  detail: string;
  changedPaths?: string[];
}

export function ApplyFixButton({
  projectId,
  auditId,
  findingKey,
  findingTitle,
  repos,
  boundRepos,
}: ApplyFixButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [fixPrompt, setFixPrompt] = useState("");
  const [selectedRepoName, setSelectedRepoName] = useState<string | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(boundRepos.length === 0);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);

  function closeStream() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    return () => closeStream();
  }, []);

  function closeModal() {
    closeStream();
    setOpen(false);
    setSubmitting(null);
  }

  function addStatus(message: string) {
    setStatusLog((prev) => [...prev, message].slice(-80));
  }

  const source = showAll ? repos : boundRepos;
  const selectedRepo = useMemo(() => {
    if (!selectedRepoName) return null;
    return repos.find((r) => r.full_name === selectedRepoName) ?? null;
  }, [repos, selectedRepoName]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((r) => r.full_name.toLowerCase().includes(needle));
  }, [q, source]);
  const promptTooLong = fixPrompt.length > MAX_FIX_PROMPT_LENGTH;

  useEffect(() => {
    if (!open || repos.length === 0) return;
    if (selectedRepo && source.some((r) => r.full_name === selectedRepo.full_name)) {
      return;
    }
    setSelectedRepoName((source[0] ?? repos[0])?.full_name ?? null);
  }, [open, repos, selectedRepo, source]);

  useEffect(() => {
    if (!open || !selectedRepo) return;
    const [owner, name] = selectedRepo.full_name.split("/");
    const controller = new AbortController();
    setPromptLoading(true);
    setPromptError(null);
    setFixPrompt("");

    const params = new URLSearchParams({
      owner,
      repo: name,
      installation_id: String(selectedRepo.installation_id),
      audit_id: auditId,
      finding_key: findingKey,
      preview_prompt: "1",
    });

    fetch(`/api/projects/${projectId}/github/apply-fix?${params.toString()}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json() as Promise<{ data?: { prompt?: string } }>;
      })
      .then((payload) => {
        setFixPrompt(payload.data?.prompt ?? "");
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setPromptError(e instanceof Error ? e.message : "Failed to load prompt");
      })
      .finally(() => {
        if (!controller.signal.aborted) setPromptLoading(false);
      });

    return () => controller.abort();
  }, [auditId, findingKey, open, projectId, selectedRepo]);

  function handleStreamEvent(eventName: string, rawData: string) {
    if (eventName === "status") {
      try {
        const data = JSON.parse(rawData) as { message?: string };
        if (data.message) addStatus(data.message);
      } catch {
        addStatus(rawData);
      }
      return;
    }
    if (eventName === "done") {
      closeStream();
      setSubmitting(null);
      try {
        setResult(JSON.parse(rawData) as FixResult);
        router.refresh();
      } catch {
        setError("Fix finished, but the response could not be read.");
      }
      return;
    }
    if (eventName === "failed") {
      closeStream();
      setSubmitting(null);
      try {
        const data = JSON.parse(rawData) as { message?: string };
        setError(data.message || "Failed to open fix PR");
      } catch {
        setError("Failed to open fix PR");
      }
    }
  }

  async function run() {
    if (!selectedRepo) {
      setError("Select a repository first.");
      return;
    }
    setError(null);
    setSubmitting(selectedRepo.full_name);
    setResult(null);
    setStatusLog([]);
    closeStream();
    const [owner, name] = selectedRepo.full_name.split("/");
    try {
      const controller = new AbortController();
      streamAbortRef.current = controller;
      const response = await fetch(`/api/projects/${projectId}/github/apply-fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          stream: true,
          owner,
          repo: name,
          installation_id: selectedRepo.installation_id,
          audit_id: auditId,
          finding_key: findingKey,
          prompt: fixPrompt.trim(),
        }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      if (!response.body) {
        throw new Error("Fix worker did not return a progress stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const eventBlock of events) {
          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("event: ")) eventName = line.slice(7);
            if (line.startsWith("data: ")) dataLines.push(line.slice(6));
          }
          handleStreamEvent(eventName, dataLines.join("\n"));
        }
      }
      if (buffer.trim()) {
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of buffer.split("\n")) {
          if (line.startsWith("event: ")) eventName = line.slice(7);
          if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        handleStreamEvent(eventName, dataLines.join("\n"));
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Network error");
      setSubmitting(null);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary text-xs"
        onClick={() => {
          setOpen(true);
          setResult(null);
          setError(null);
          setStatusLog([]);
        }}
      >
        Fix via PR
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 sm:items-center"
          onClick={closeModal}
        >
          <div
            className="max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">
                Fix via PR — <code className="font-mono text-sm">{findingKey}</code>
              </h2>
              <button
                type="button"
                onClick={closeModal}
                className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              {findingTitle}
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Costs <strong>20 credits (~$1)</strong>. Claude reads the relevant
              files, proposes a minimal patch, and opens a PR. We refund
              the credits if the run fails.
            </p>

            {repos.length === 0 ? (
              <p className="mt-4 text-sm">
                You haven&apos;t connected a GitHub installation yet.{" "}
                <a
                  href="/dashboard/settings/integrations/github"
                  className="underline"
                >
                  Connect on the GitHub settings page
                </a>
                .
              </p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <input
                    type="text"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={`Filter ${source.length} repo${source.length === 1 ? "" : "s"}…`}
                    className="w-full max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                  />
                  {boundRepos.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAll((v) => !v)}
                      className="text-xs text-[var(--color-muted)] underline hover:text-[var(--color-foreground)]"
                    >
                      {showAll
                        ? `Show ${boundRepos.length} bound repo${boundRepos.length === 1 ? "" : "s"}`
                        : `Browse all ${repos.length} repos`}
                    </button>
                  )}
                </div>
                <ul className="mt-3 max-h-64 overflow-y-auto divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                  {filtered.slice(0, 50).map((r) => (
                    <li
                      key={r.full_name}
                      className={`flex items-center justify-between gap-3 p-2 ${
                        selectedRepoName === r.full_name ? "bg-[var(--color-bg)]" : ""
                      }`}
                    >
                      <span className="truncate text-sm">{r.full_name}</span>
                      <button
                        type="button"
                        disabled={submitting !== null}
                        onClick={() => setSelectedRepoName(r.full_name)}
                        className="btn btn-secondary text-xs"
                      >
                        {selectedRepoName === r.full_name ? "Selected" : "Select"}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      className="block text-sm font-medium"
                      htmlFor={`fix-prompt-${findingKey}`}
                    >
                      PR prompt (optional)
                    </label>
                    <span className="text-xs text-[var(--color-muted)]">
                      {fixPrompt.length.toLocaleString()}/{MAX_FIX_PROMPT_LENGTH.toLocaleString()}
                    </span>
                  </div>
                  <textarea
                    id={`fix-prompt-${findingKey}`}
                    value={fixPrompt}
                    onChange={(e) => setFixPrompt(e.target.value)}
                    disabled={submitting !== null || promptLoading}
                    maxLength={MAX_FIX_PROMPT_LENGTH}
                    rows={16}
                    spellCheck={false}
                    placeholder="Example: use Profullstack.com and Profullstack, Inc. for all company references"
                    className="mt-2 max-h-[45vh] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs leading-relaxed"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-[var(--color-muted)]">
                      {promptLoading
                        ? "Loading the repo-specific prompt…"
                        : selectedRepo
                          ? `Selected repo: ${selectedRepo.full_name}`
                          : "Select a repo to load the prompt."}
                    </p>
                    <button
                      type="button"
                      disabled={
                        submitting !== null ||
                        promptLoading ||
                        !selectedRepo ||
                        promptTooLong
                      }
                      onClick={run}
                      className="btn btn-primary text-xs"
                    >
                      {submitting ? "Working…" : "Use 20 credits"}
                    </button>
                  </div>
                  {promptError && (
                    <p className="mt-2 text-xs text-red-700">{promptError}</p>
                  )}
                  {promptTooLong && (
                    <p className="mt-2 text-xs text-red-700">
                      Shorten the prompt before submitting.
                    </p>
                  )}
                </div>

                {(submitting || statusLog.length > 0) && (
                  <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium">Status log</span>
                      {submitting && (
                        <span className="text-[var(--color-muted)]">
                          Working…
                        </span>
                      )}
                    </div>
                    <div className="max-h-44 space-y-1 overflow-y-auto font-mono text-xs leading-relaxed text-[var(--color-muted)]">
                      {statusLog.length === 0 ? (
                        <div>Opening stream…</div>
                      ) : (
                        statusLog.map((line, i) => (
                          <div key={`${i}-${line}`}>
                            <span className="select-none text-[var(--color-muted)]/70">
                              {String(i + 1).padStart(2, "0")}{" "}
                            </span>
                            {line}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
                {result && (
                  <div className="mt-4 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                    <p className="font-medium">
                      {result.status === "opened" ? "PR opened" : "No changes proposed"}
                    </p>
                    <p className="mt-1 text-[var(--color-muted)]">
                      {result.detail}
                    </p>
                    {result.prUrl && (
                      <a
                        href={result.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block underline"
                      >
                        Open PR →
                      </a>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
