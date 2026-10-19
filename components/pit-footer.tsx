/**
 * The pit.world global footer, fetched server-side and cached for an hour.
 * Renders nothing on any failure so it can never break the page.
 */
const PIT_FOOTER_URL = "https://pit.world/snippets/footer.html?site=crawlproof.com";

export async function PitFooter() {
  try {
    const res = await fetch(PIT_FOOTER_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html.includes("data-pit-footer")) return null;
    // eslint-disable-next-line react/no-danger
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return null;
  }
}
