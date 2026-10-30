"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createAdExperiment,
  finishAdExperiment,
  pauseAdExperiment,
  resumeAdExperiment,
} from "@/app/actions/ads";
import { CREDIT_RACK_CENTS } from "@/lib/credits";
import { AD_TEST_VARIANT_CREDITS } from "@/lib/ads/pricing";

export type AdExperimentSummary = {
  id: string;
  name: string;
  status: "draft" | "running" | "paused" | "completed";
  instruction: string | null;
  variantCount: number;
  creditsCharged: number;
  winnerVariantId: string | null;
  variants: {
    id: string;
    label: string;
    isControl: boolean;
    headline: string;
    body: string;
    ctaText: string;
    impressions: number;
    clicks: number;
  }[];
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const ctr = (clicks: number, impressions: number) =>
  impressions ? `${((clicks / impressions) * 100).toFixed(2)}%` : "—";

export function AdExperimentPanel({
  campaignId,
  campaignStatus,
  creditsBalance,
  experiment,
}: {
  campaignId: string;
  campaignStatus: string;
  creditsBalance: number;
  experiment: AdExperimentSummary | null;
}) {
  const router = useRouter();
  const [variantCount, setVariantCount] = useState(2);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const creditsNeeded = (variantCount - 1) * AD_TEST_VARIANT_CREDITS;
  const dollarsNeeded = creditsNeeded * CREDIT_RACK_CENTS;
  const mayCreate = !experiment || experiment.status === "completed";

  function create() {
    setError(null);
    start(async () => {
      const result = await createAdExperiment({ campaignId, variantCount, instruction });
      if (!result.ok) {
        setError(
          `${result.error}${result.refundFailed ? " The automatic credit refund also failed; contact support." : ""}`,
        );
        return;
      }
      router.refresh();
    });
  }

  function runAction(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const campaignPaused = campaignStatus !== "active";

  return (
    <section className="card mt-8 space-y-4 p-5" aria-labelledby="ad-test-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)]">
            Paid feature
          </p>
          <h2 id="ad-test-heading" className="mt-1 text-xl font-bold">
            A/B/C/N creative testing
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted)]">
            Keep the current display ad as control, generate up to four AI alternatives, and
            compare click-through rates. Visitors stay in one variant; video pre-roll keeps its
            current creative during the test.
          </p>
        </div>
        {experiment && (
          <span className="badge capitalize">{experiment.status === "completed" ? "ended" : experiment.status}</span>
        )}
      </div>

      {campaignPaused && experiment?.status === "running" && (
        <p className="rounded-md border border-[var(--color-border)] p-3 text-sm text-[var(--color-muted)]">
          Testing is configured, but this campaign is paused. Activate the campaign to start
          delivering variants.
        </p>
      )}

      {experiment && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <tr>
                  <th className="py-2 pr-3">Variant</th>
                  <th className="py-2 pr-3 text-right">Impressions</th>
                  <th className="py-2 pr-3 text-right">Clicks</th>
                  <th className="py-2 pr-3 text-right">CTR</th>
                  <th className="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {experiment.variants.map((variant) => (
                  <tr key={variant.id} className="border-t border-[var(--color-border)]">
                    <td className="py-3 pr-3 font-medium">
                      {variant.label}
                      {variant.isControl && <span className="ml-2 text-xs text-[var(--color-muted)]">Control</span>}
                      {experiment.winnerVariantId === variant.id && (
                        <span className="ml-2 text-xs text-[var(--color-accent)]">Promoted</span>
                      )}
                      <p className="mt-1 max-w-sm text-xs font-semibold">{variant.headline}</p>
                      <p className="mt-0.5 max-w-sm text-xs font-normal text-[var(--color-muted)]">{variant.body}</p>
                      <p className="mt-0.5 text-xs font-normal text-[var(--color-accent)]">{variant.ctaText}</p>
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums">{variant.impressions.toLocaleString()}</td>
                    <td className="py-3 pr-3 text-right tabular-nums">{variant.clicks.toLocaleString()}</td>
                    <td className="py-3 pr-3 text-right tabular-nums">{ctr(variant.clicks, variant.impressions)}</td>
                    <td className="py-2 text-right">
                      {(experiment.status === "running" || experiment.status === "paused") && (
                        <button
                          className="btn text-xs"
                          disabled={pending}
                          onClick={() => {
                            if (!window.confirm(`End this test and promote ${variant.label} as the campaign's live creative?`)) return;
                            runAction(() => finishAdExperiment({ experimentId: experiment.id, winnerVariantId: variant.id }));
                          }}
                        >
                          Promote
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {experiment.status !== "completed" && (
            <div className="flex flex-wrap items-center gap-2">
              {experiment.status === "running" ? (
                <button
                  className="btn text-sm"
                  disabled={pending}
                  onClick={() => runAction(() => pauseAdExperiment({ experimentId: experiment.id }))}
                >
                  Pause test
                </button>
              ) : (
                <button
                  className="btn text-sm"
                  disabled={pending}
                  onClick={() => runAction(() => resumeAdExperiment({ experimentId: experiment.id }))}
                >
                  Resume test
                </button>
              )}
              <button
                className="btn text-sm"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm("End this test and keep the campaign's previous creative as the default?")) return;
                  runAction(() => finishAdExperiment({ experimentId: experiment.id }));
                }}
              >
                End without promoting
              </button>
              <span className="text-xs text-[var(--color-muted)]">
                Results are directional; compare impression counts before choosing a winner.
              </span>
            </div>
          )}
          {experiment.instruction && (
            <p className="text-xs text-[var(--color-muted)]">
              AI direction: {experiment.instruction}
            </p>
          )}
        </div>
      )}

      {mayCreate && (
        <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
          <div className="grid gap-3 sm:grid-cols-[150px_1fr]">
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Total variants</span>
              <select
                className="input mt-1"
                value={variantCount}
                onChange={(event) => setVariantCount(Number(event.target.value))}
              >
                {[2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>{count} variants</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">AI direction (optional)</span>
              <textarea
                className="input mt-1 min-h-20"
                maxLength={500}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Try a shorter headline, focus on the time saved, or test a more direct CTA."
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[var(--color-muted)]">
              {creditsNeeded} credits ({dollars(dollarsNeeded)} at rack) · {AD_TEST_VARIANT_CREDITS} credits per generated variant.
              <span className="ml-1">Available: {creditsBalance} credits.</span>
            </p>
            {creditsBalance < creditsNeeded ? (
              <Link className="btn btn-primary" href="/pricing">Add credits</Link>
            ) : (
              <button className="btn btn-primary" disabled={pending} onClick={create}>
                {pending ? "Generating variants…" : `Generate & launch · ${creditsNeeded} credits`}
              </button>
            )}
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            The existing creative is the free control. Generated alternatives are billed once;
            normal campaign click charges still apply. Eligible display traffic is split evenly.
          </p>
        </div>
      )}

      {error && <p role="alert" className="rounded-md border border-red-500/40 p-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
