"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { previewAds, saveCampaign, uploadAdAsset } from "@/app/actions/ads";
import { AD_FORMATS, type AdCreative, type AdFormatId } from "@/lib/ads/creative";
import type { SiteBrand } from "@/lib/ads/brand";
import { AdPreview } from "@/components/ads/ad-preview";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function NewAdForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [budget, setBudget] = useState(5); // dollars/day
  const [name, setName] = useState("");
  const [brand, setBrand] = useState<SiteBrand | null>(null);
  const [creatives, setCreatives] = useState<AdCreative[]>([]);
  const [active, setActive] = useState<AdFormatId>("banner_300x250");
  const [provider, setProvider] = useState<string | null>(null);

  const [generating, startGenerate] = useTransition();
  const [saving, startSave] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = creatives.find((c) => c.format === active) ?? creatives[0];

  function generate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startGenerate(async () => {
      const res = await previewAds({ url });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setBrand(res.brand);
      setCreatives(res.creatives);
      setProvider(res.provider);
      if (!name) setName(res.suggestedName);
    });
  }

  // copy edits touch only the active format; colours/assets are shared brand-level
  function patchActive(patch: Partial<AdCreative>) {
    setCreatives((cs) => cs.map((c) => (c.format === active ? { ...c, ...patch } : c)));
  }
  function patchAll(patch: Partial<AdCreative>) {
    setCreatives((cs) => cs.map((c) => ({ ...c, ...patch })));
  }

  function onUpload(kind: "logoUrl" | "imageUrl") {
    return async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError(null);
      setUploading(true);
      const fd = new FormData();
      fd.set("file", file);
      const res = await uploadAdAsset(fd);
      setUploading(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      patchAll({ [kind]: res.url } as Partial<AdCreative>);
    };
  }

  function save() {
    setError(null);
    startSave(async () => {
      const res = await saveCampaign({
        name,
        url,
        dailyBudgetCents: Math.round(budget * 100),
        brand,
        creatives,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/ads?created=${res.refSlug}`);
    });
  }

  const hasAds = creatives.length > 0 && !!current;

  return (
    <div className="mt-6 space-y-6">
      {/* Step 1 — URL + budget */}
      <form onSubmit={generate} className="card space-y-3 p-5">
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Landing page URL
          </label>
          <input
            className="input mt-1"
            type="url"
            placeholder="https://yourproduct.com"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            We read this page and auto-design on-brand ads. You can edit everything after.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="w-40">
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Daily budget
            </label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[var(--color-muted)]">$</span>
              <input
                className="input"
                type="number"
                min={1}
                step={1}
                value={budget}
                onChange={(e) => setBudget(Math.max(0, Number(e.target.value)))}
              />
              <span className="text-sm text-[var(--color-muted)]">/day</span>
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={generating}>
            {generating ? "Designing ads…" : hasAds ? "Regenerate" : "Generate ads"}
          </button>
        </div>
      </form>

      {error && (
        <div className="card border-red-500/40 p-3 text-sm text-red-400">{error}</div>
      )}

      {hasAds && (
        <>
          {/* Preview gallery — all formats */}
          <div className="card space-y-4 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Preview</h2>
              {provider && (
                <span className="text-xs text-[var(--color-muted)]">
                  Generated with {provider}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-start gap-6">
              {AD_FORMATS.map((f) => {
                const c = creatives.find((x) => x.format === f.id);
                if (!c) return null;
                return (
                  <button
                    key={f.id}
                    onClick={() => setActive(f.id)}
                    className={`space-y-1 rounded-lg p-2 text-left transition ${
                      active === f.id ? "ring-2 ring-[var(--color-accent)]" : "opacity-80 hover:opacity-100"
                    }`}
                    style={{ maxWidth: f.w > 360 ? 360 : f.w + 16 }}
                  >
                    <div style={{ overflowX: "auto" }}>
                      <AdPreview creative={c} />
                    </div>
                    <div className="text-xs text-[var(--color-muted)]">
                      {f.label} · {f.w}×{f.h}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Editor for the active format */}
          <div className="card space-y-4 p-5">
            <h2 className="font-semibold">
              Edit — {AD_FORMATS.find((f) => f.id === active)?.label}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  Headline
                </span>
                <input
                  className="input mt-1"
                  value={current.headline}
                  maxLength={80}
                  onChange={(e) => patchActive({ headline: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  CTA button
                </span>
                <input
                  className="input mt-1"
                  value={current.ctaText}
                  maxLength={24}
                  onChange={(e) => patchActive({ ctaText: e.target.value })}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  Body
                </span>
                <input
                  className="input mt-1"
                  value={current.body}
                  maxLength={140}
                  onChange={(e) => patchActive({ body: e.target.value })}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-5">
              <ColorField label="Background" value={current.bgColor} onChange={(v) => patchAll({ bgColor: v })} />
              <ColorField label="Text" value={current.fgColor} onChange={(v) => patchAll({ fgColor: v })} />
              <ColorField label="Accent" value={current.accentColor} onChange={(v) => patchAll({ accentColor: v })} />
              <span className="text-xs text-[var(--color-muted)]">Colours apply to all formats</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="btn cursor-pointer text-sm">
                {uploading ? "Uploading…" : current.logoUrl ? "Replace logo" : "Upload logo"}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={onUpload("logoUrl")}
                  disabled={uploading}
                />
              </label>
              {current.logoUrl && (
                <button className="text-xs text-[var(--color-muted)] underline" onClick={() => patchAll({ logoUrl: null })}>
                  Remove logo
                </button>
              )}
            </div>
          </div>

          {/* Save */}
          <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
            <label className="block flex-1">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Campaign name
              </span>
              <input
                className="input mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My campaign"
              />
            </label>
            <div className="text-right">
              <div className="text-sm text-[var(--color-muted)]">
                Budget {dollars(Math.round(budget * 100))}/day
              </div>
              <button className="btn btn-primary mt-2" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save campaign"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-8 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
        aria-label={label}
      />
      <span className="text-xs text-[var(--color-muted)]">
        {label}
        <br />
        <span className="font-mono">{value}</span>
      </span>
    </label>
  );
}
