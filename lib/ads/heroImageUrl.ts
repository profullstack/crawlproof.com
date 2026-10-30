/**
 * AI-generated hero renditions and their original PNG share a UUID in the
 * public ad-assets bucket. Keep the original available as an advertiser download.
 */
export function originalHeroPngDownloadUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== "https:") return null;
    const match = url.pathname.match(
      /^\/storage\/v1\/object\/public\/ad-assets\/heroes\/([0-9a-f-]+)\.webp$/i,
    );
    if (!match) return null;
    url.pathname = `/storage/v1/object/public/ad-assets/heroes/${match[1]}.png`;
    url.search = "";
    url.searchParams.set("download", "hero.png");
    return url.toString();
  } catch {
    return null;
  }
}
