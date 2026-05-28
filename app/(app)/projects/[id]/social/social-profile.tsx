"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveSocialProfile } from "@/app/actions/socialPosting";

export type SocialProfile = {
  brand_voice: string;
  tone: string;
  default_hashtags: string[];
  image_cadence: number;
  image_style: string;
  custom_instructions: string;
};

const TONES = [
  "casual",
  "professional",
  "witty",
  "authoritative",
  "friendly",
  "playful",
  "technical",
] as const;

const IMAGE_STYLES: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "editorial",
    label: "Editorial photo",
    hint: "Single focal photographic/illustrative subject, magazine-cover feel. Falls back to the article's og:image if one exists.",
  },
  {
    value: "infographic",
    label: "Infographic (split compare)",
    hint: "Two-panel before/after with a bold headline, iconography, on-image labels. Best for explainer-style posts.",
  },
  {
    value: "quote_card",
    label: "Quote card",
    hint: "Minimalist text card with the article headline as the centrepiece. Best for opinion / hot-take posts.",
  },
  {
    value: "diagram",
    label: "Labelled diagram",
    hint: "Clean architecture/flow diagram with labelled boxes and arrows. Best for technical or process posts.",
  },
  {
    value: "screenshot",
    label: "Product UI mockup",
    hint: "Fake-but-plausible SaaS dashboard screenshot. Best for product / feature launch posts.",
  },
];

export function SocialProfileForm({
  projectId,
  profile,
}: {
  projectId: string;
  profile: SocialProfile | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [brandVoice, setBrandVoice] = useState(profile?.brand_voice ?? "");
  const [tone, setTone] = useState(profile?.tone ?? "casual");
  const [hashtags, setHashtags] = useState(
    (profile?.default_hashtags ?? []).join(" "),
  );
  const [imageCadence, setImageCadence] = useState(profile?.image_cadence ?? 0);
  const [imageStyle, setImageStyle] = useState(profile?.image_style ?? "editorial");
  const [customInstructions, setCustomInstructions] = useState(
    profile?.custom_instructions ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await saveSocialProfile({
        projectId,
        brandVoice,
        tone,
        defaultHashtags: hashtags,
        imageCadence,
        imageStyle,
        customInstructions,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Saved.");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Brand voice
        </label>
        <textarea
          className="input mt-1 min-h-[5rem]"
          placeholder='e.g. "Senior infra engineer, dry sense of humor, hates marketing speak. Writes for technical readers who already know the basics."'
          value={brandVoice}
          onChange={(e) => setBrandVoice(e.target.value)}
          maxLength={2000}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Describe who's writing. The renderer uses this to keep every
          platform's post on-voice.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Tone
          </label>
          <select
            className="input mt-1"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
          >
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Image every N posts
          </label>
          <input
            className="input mt-1"
            type="number"
            min={0}
            max={50}
            step={1}
            value={imageCadence}
            onChange={(e) => setImageCadence(Number(e.target.value))}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            0 = never. 1 = every post. 3 = roughly 1 in 3.
          </p>
        </div>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Image style
        </label>
        <select
          className="input mt-1"
          value={imageStyle}
          onChange={(e) => setImageStyle(e.target.value)}
          disabled={imageCadence === 0}
        >
          {IMAGE_STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {IMAGE_STYLES.find((s) => s.value === imageStyle)?.hint}
        </p>
        {imageStyle === "editorial" && imageCadence > 0 && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Editorial is the only style that reuses an existing
            <code> og:image</code> when present — every other style always
            generates a fresh image so the chosen layout is preserved.
          </p>
        )}
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Default hashtags
        </label>
        <input
          className="input mt-1"
          placeholder="#devops #infra #postgres"
          value={hashtags}
          onChange={(e) => setHashtags(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          The renderer will weave these in on platforms where hashtags fit
          (Bluesky, X, LinkedIn, Mastodon, Threads). Up to 12.
        </p>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Custom instructions
        </label>
        <textarea
          className="input mt-1 min-h-[4rem]"
          placeholder='e.g. "Never mention competitors. Always end LinkedIn posts with a question."'
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          maxLength={2000}
        />
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}

      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving..." : "Save brand profile"}
        </button>
      </div>
    </form>
  );
}
