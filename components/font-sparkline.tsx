import { datatypeFont } from "@/lib/datatype-font";

export function FontSparkline({
  samples,
  width = 72,
}: {
  samples: number[];
  width?: number;
}) {
  if (samples.length < 2 || samples.every((value) => value === 0)) {
    return <span className="text-xs text-[var(--color-muted)]">No traffic</span>;
  }

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min;
  const normalized = samples.map((value) =>
    range === 0 ? 50 : Math.round(((value - min) / range) * 100),
  );
  const rising = samples[samples.length - 1] >= samples[0];

  return (
    <span
      className={`${datatypeFont.className} inline-block ${
        rising ? "text-[var(--color-pass)]" : "text-[var(--color-warn)]"
      }`}
      style={{
        minWidth: width,
        fontSize: "1.45em",
        lineHeight: 1,
        fontVariationSettings: "'wdth' 75, 'wght' 500",
        fontFeatureSettings: "'calt' 1, 'liga' 1, 'dlig' 1",
        WebkitFontFeatureSettings: "'calt' 1, 'liga' 1, 'dlig' 1",
      }}
      aria-hidden
    >
      {`{l:${normalized.join(",")}}`}
    </span>
  );
}
