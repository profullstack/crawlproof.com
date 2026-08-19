"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateCampaign, updateCreatives, uploadAdAsset } from "@/app/actions/ads";
import { AD_FORMATS, paletteFor, type AdCreative, type AdFormatId } from "@/lib/ads/formats";
import { AdPreview } from "@/components/ads/ad-preview";
import { ColorField } from "@/components/ads/color-field";
import type { AdTheme } from "@/lib/ads/theme";

type Campaign = {
  id: string;
  name: string;
  destinationUrl: string;
  dailyBudgetCents: number;
  bidCredits: number;
  status: string;
};

export function EditCampaignForm({
  campaign,
  creatives: initial,
}: {
  campaign: Campaign;
  creatives: (AdCreative & { id: string })[];
}) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState(campaign.name);
  const [url, setUrl] = useState(campaign.destinationUrl);
  const [budget, setBudget] = useState(campaign.dailyBudgetCents / 100);
  const [bid, setBid] = useState((campaign.bidCredits * 5) / 100); // credits → $
  const [creatives, setCreatives] = useState(initial);
  const [active, setActive] = useState<AdFormatId>(initial[0]?.format ?? "banner_300x250");
  // Which polarity the previews show and the colour pickers edit. Publishers
  // get whichever one matches their page, so both are editable here.
  const [theme, setTheme] = useState<AdTheme>("dark");
  const [uploading, setUploading] = useState(false);

  const current = creatives.find((c) => c.format === active) ?? creatives[0];
  // What the pickers show: the stored trio for this theme, or the derived one
  // when the creative predates theme variants and has no light trio yet.
  const palette = current
    ? paletteFor(current, theme)
    : { bgColor: "#0b0d10", fgColor: "#e7e9ee", accentColor: "#6ee7b7" };

  function patchActive(patch: Partial<AdCreative>) {
    setCreatives((cs) => cs.map((c) => (c.format === active ? { ...c, ...patch } : c)));
  }
  function patchAll(patch: Partial<AdCreative>) {
    setCreatives((cs) => cs.map((c) => ({ ...c, ...patch })));
  }

  // Colours apply to every format at once (one brand, five sizes), and write to
  // whichever trio the theme switch has selected. Editing the light trio for
  // the first time seeds it from the derived palette, so a publisher never sees
  // two of three colours change.
  function patchPalette(key: "bg" | "fg" | "accent", v: string) {
    if (theme === "dark") {
      const field = key === "bg" ? "bgColor" : key === "fg" ? "fgColor" : "accentColor";
      return patchAll({ [field]: v } as Partial<AdCreative>);
    }
    setCreatives((cs) =>
      cs.map((c) => {
        const seed = paletteFor(c, "light");
        return {
          ...c,
          lightBgColor: key === "bg" ? v : (c.lightBgColor ?? seed.bgColor),
          lightFgColor: key === "fg" ? v : (c.lightFgColor ?? seed.fgColor),
          lightAccentColor: key === "accent" ? v : (c.lightAccentColor ?? seed.accentColor),
        };
      }),
    );
  }

  function onUpload(kind: "logoUrl" | "imageUrl") {
    return async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploading(true);
      const fd = new FormData();
      fd.set("file", file);
      const res = await uploadAdAsset(fd);
      setUploading(false);
      if (!res.ok) return setError(res.error);
      patchAll({ [kind]: res.url } as Partial<AdCreative>);
    };
  }

  function save() {
    setError(null);
    setSaved(false);
    startSave(async () => {
      const s = await updateCampaign({
        id: campaign.id,
        name,
        destinationUrl: url,
        dailyBudgetCents: Math.round(budget * 100),
        bidCredits: Math.max(1, Math.round((bid * 100) / 5)),
      });
      if (!s.ok) return setError(s.error);
      const c = await updateCreatives({
        campaignId: campaign.id,
        creatives: creatives.map((cr) => ({ ...cr })),
      });
      if (!c.ok) return setError(c.error);
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="mt-6 space-y-6">
      {error && <div className="card border-red-500/40 p-3 text-sm text-red-400">{error}</div>}
      {saved && <div className="card border-[var(--color-accent)]/40 p-3 text-sm text-[var(--color-accent)]">Saved.</div>}

      {/* Settings */}
      <div className="card space-y-4 p-5">
        <h2 className="font-semibold">Settings</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Name</span>
            <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Destination URL</span>
            <input className="input mt-1" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Daily budget ($)</span>
            <input
              className="input mt-1"
              type="number"
              min={1}
              step={1}
              value={budget}
              onChange={(e) => setBudget(Math.max(0, Number(e.target.value)))}
            />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Max bid / click ($)</span>
            <input
              className="input mt-1"
              type="number"
              min={0.05}
              step={0.05}
              value={bid}
              onChange={(e) => setBid(Math.max(0.05, Number(e.target.value)))}
            />
          </label>
        </div>
      </div>

      {/* Creative editor */}
      {current && (
        <div className="card space-y-4 p-5">
          <div className="flex flex-wrap items-start gap-4">
            {AD_FORMATS.map((f) => {
              const c = creatives.find((x) => x.format === f.id);
              if (!c) return null;
              return (
                <button
                  key={f.id}
                  onClick={() => setActive(f.id)}
                  className={`rounded-lg p-2 ${active === f.id ? "ring-2 ring-[var(--color-accent)]" : "opacity-80 hover:opacity-100"}`}
                  style={{ maxWidth: f.w > 360 ? 360 : f.w + 16 }}
                >
                  <div style={{ overflowX: "auto" }}>
                    <AdPreview creative={c} theme={theme} />
                  </div>
                </button>
              );
            })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Headline</span>
              <input className="input mt-1" value={current.headline} maxLength={80} onChange={(e) => patchActive({ headline: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">CTA</span>
              <input className="input mt-1" value={current.ctaText} maxLength={24} onChange={(e) => patchActive({ ctaText: e.target.value })} />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Body</span>
              <input className="input mt-1" value={current.body} maxLength={140} onChange={(e) => patchActive({ body: e.target.value })} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Theme</span>
            {(["dark", "light"] as AdTheme[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTheme(t)}
                className={`rounded-md px-3 py-1 text-sm capitalize ${
                  theme === t
                    ? "bg-[var(--color-accent)] text-black"
                    : "border border-[var(--color-border)] text-[var(--color-muted)]"
                }`}
              >
                {t}
              </button>
            ))}
            <span className="text-xs text-[var(--color-muted)]">
              Publishers are served whichever matches their page.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <ColorField label="Background" value={palette.bgColor} onChange={(v) => patchPalette("bg", v)} />
            <ColorField label="Text" value={palette.fgColor} onChange={(v) => patchPalette("fg", v)} alpha={false} />
            <ColorField label="Accent" value={palette.accentColor} onChange={(v) => patchPalette("accent", v)} />
            <label className="btn cursor-pointer text-sm">
              {uploading ? "Uploading…" : current.logoUrl ? "Replace logo" : "Upload logo"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={onUpload("logoUrl")} disabled={uploading} />
            </label>
            {current.logoUrl && (
              <button type="button" className="text-xs text-[var(--color-muted)] underline" onClick={() => patchAll({ logoUrl: null })}>
                Remove logo
              </button>
            )}
            <label className="btn cursor-pointer text-sm">
              {uploading ? "Uploading…" : current.imageUrl ? "Replace image" : "Upload image"}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onUpload("imageUrl")} disabled={uploading} />
            </label>
            {current.imageUrl && (
              <button type="button" className="text-xs text-[var(--color-muted)] underline" onClick={() => patchAll({ imageUrl: null })}>
                Remove image
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
