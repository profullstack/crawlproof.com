"use client";

import { parseColor, toHex } from "@/lib/ads/theme";

// A colour picker with an alpha channel.
//
// `<input type="color">` is RGB-only in every browser — it silently drops the
// alpha of a #rrggbbaa value and hands back 6 digits. So the swatch edits the
// hue and a companion slider edits opacity, and the two are recombined into an
// 8-digit hex. Fully opaque colours stay 6-digit, so nothing that never touches
// the slider changes shape in the database.

const OPAQUE = 1;

function withAlpha(hex: string, alpha: number): string {
  const c = parseColor(hex);
  if (!c) return hex;
  return toHex({ ...c, a: alpha });
}

function alphaOf(hex: string): number {
  return parseColor(hex)?.a ?? OPAQUE;
}

/** The 6-digit form, which is all `<input type="color">` will accept. */
function rgbOf(hex: string): string {
  const c = parseColor(hex);
  return c ? toHex({ ...c, a: OPAQUE }) : "#000000";
}

export function ColorField({
  label,
  value,
  onChange,
  alpha = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Hide the opacity slider where a translucent value would make no sense. */
  alpha?: boolean;
}) {
  const a = alphaOf(value);

  return (
    <label className="flex items-start gap-2">
      <span
        className="relative mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded border border-[var(--color-border)]"
        // A checkerboard behind the swatch, so a translucent colour reads as
        // translucent rather than as a slightly different flat colour.
        style={{
          backgroundImage:
            "linear-gradient(45deg,#8884 25%,transparent 25%,transparent 75%,#8884 75%),linear-gradient(45deg,#8884 25%,transparent 25%,transparent 75%,#8884 75%)",
          backgroundSize: "8px 8px",
          backgroundPosition: "0 0, 4px 4px",
        }}
      >
        <span className="absolute inset-0" style={{ background: value }} />
        <input
          type="color"
          value={rgbOf(value)}
          onChange={(e) => onChange(withAlpha(e.target.value, a))}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={label}
        />
      </span>
      <span className="text-xs text-[var(--color-muted)]">
        {label}
        <br />
        <span className="font-mono">{value}</span>
        {alpha && (
          <>
            <br />
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(a * 100)}
              onChange={(e) => onChange(withAlpha(value, Number(e.target.value) / 100))}
              className="mt-1 w-24 cursor-pointer align-middle"
              aria-label={`${label} opacity`}
            />
            <span className="ml-1 align-middle font-mono">{Math.round(a * 100)}%</span>
          </>
        )}
      </span>
    </label>
  );
}
