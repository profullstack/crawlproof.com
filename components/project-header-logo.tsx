// Square logo for the project header — scraped favicon/og-image with a
// one-letter fallback. Mirrors the dashboard tile's ProjectLogo, sized
// up for the page header.
export function ProjectHeaderLogo({
  url,
  name,
}: {
  url: string | null;
  name: string;
}) {
  const letter = (name || "?").trim().charAt(0).toUpperCase();
  if (!url) {
    return (
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-card)] text-sm font-semibold text-[var(--color-muted)]"
        aria-hidden
      >
        {letter}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={`${name} logo`}
      width={40}
      height={40}
      loading="lazy"
      className="h-10 w-10 shrink-0 rounded-md border border-[var(--color-border)] bg-white object-contain p-1"
    />
  );
}
