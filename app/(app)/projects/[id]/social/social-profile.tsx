"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveSocialProfile } from "@/app/actions/socialPosting";

export type SocialProfile = {
  brand_voice: string;
  tone: string;
  default_hashtags: string[];
  image_cadence: number;
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
            0 = never. 1 = every post. 3 = roughly 1 in 3. Tries the
            article's <code>og:image</code> first; only generates a fresh
            AI image when the page has none.
          </p>
        </div>
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
