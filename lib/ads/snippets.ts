// Install snippets — the copy-and-paste recipe for every unit, in every place
// a publisher might be installing it.
//
// This used to be two branches inside <SlotManager>: a `<script>` tag for the
// banners and a `curl` line for the terminal. That was enough while every unit
// was rendered by /ad.js or printed by a shell, because in both cases the
// publisher's stack did not matter — the browser or the terminal was the
// runtime.
//
// The feed unit broke that assumption. It is not embedded and not printed: it
// is *fetched at build time and spliced into a document the publisher's own
// code generates*, which means the snippet has to be written in whatever
// language builds that document. A Hugo site, an Eleventy build, a WordPress
// install, and a Go service all need the same three HTTP parameters and four
// completely different pieces of code.
//
// So snippets are data here rather than markup in a component, keyed by format
// and then by target. Adding a language is one array entry.
//
// Client-safe: no server-only imports, because the Monetize page renders these
// in the browser.

import {
  FEED_FORMAT_ID,
  TERMINAL_FORMAT_ID,
  type AdFormatId,
} from "./formats";

export type Snippet = {
  /** Stable key — also the button caption's identity across re-renders. */
  id: string;
  /** What the publisher recognises: "Node.js", "Hugo", "WordPress". */
  label: string;
  /** Language hint, for the code block. */
  lang: string;
  /** One line on the catch, when there is one. Rendered under the code. */
  note?: string;
  code: string;
};

/** The ad endpoint for a slot, with whatever parameters a recipe needs. */
export function feedAdUrl(
  origin: string,
  slotId: string,
  params: Record<string, string | number> = {},
): string {
  const qs = new URLSearchParams({ slot: slotId });
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return `${origin}/api/ads/feed?${qs.toString()}`;
}

// --------------------------------------------------------------- web formats

/**
 * Snippets for the units /ad.js renders: the three banners and the text link.
 *
 * The first is the canonical one — everything else is the same two attributes
 * expressed in a framework's own syntax, because a publisher on Astro should
 * not have to work out that `data-cp-ad` survives JSX.
 */
function webSnippets(slotId: string, format: AdFormatId, origin: string): Snippet[] {
  const div = `<div data-cp-ad data-slot="${slotId}" data-format="${format}"></div>`;
  const script = `<script src="${origin}/ad.js" async></script>`;
  const frame = `${origin}/api/ads/frame?slot=${slotId}&format=${format}`;

  return [
    {
      id: "html",
      label: "HTML",
      lang: "html",
      note: "Put the script tag once per page; the div goes wherever the unit belongs.",
      code: `${div}\n${script}`,
    },
    {
      id: "iframe",
      label: "iframe (no JS)",
      lang: "html",
      note: "No JavaScript at all — works on Tor hidden services and anywhere scripts are blocked.",
      code: [
        `<iframe src="${frame}"`,
        `        width="300" height="250" frameborder="0" scrolling="no"`,
        `        style="border:0;max-width:100%" loading="lazy"></iframe>`,
      ].join("\n"),
    },
    {
      id: "react",
      label: "React",
      lang: "jsx",
      note: "ad.js scans once on DOMContentLoaded, so load it in your app shell, not per component.",
      code: [
        "export function Ad({ format = '" + format + "' }) {",
        "  return <div data-cp-ad=\"\" data-slot=\"" + slotId + "\" data-format={format} />;",
        "}",
        "",
        "// Once, in your root layout / index.html:",
        "// " + script,
      ].join("\n"),
    },
    {
      id: "vue",
      label: "Vue",
      lang: "vue",
      code: [
        "<template>",
        `  <div data-cp-ad data-slot="${slotId}" :data-format="format" />`,
        "</template>",
        "",
        "<script setup>",
        `defineProps({ format: { type: String, default: '${format}' } })`,
        "</script>",
      ].join("\n"),
    },
    {
      id: "svelte",
      label: "Svelte",
      lang: "svelte",
      code: [
        "<script>",
        `  export let format = '${format}';`,
        "</script>",
        "",
        `<div data-cp-ad data-slot="${slotId}" data-format={format}></div>`,
      ].join("\n"),
    },
    {
      id: "astro",
      label: "Astro",
      lang: "astro",
      code: [
        "---",
        `const { format = '${format}' } = Astro.props;`,
        "---",
        `<div data-cp-ad data-slot="${slotId}" data-format={format}></div>`,
        `<script is:inline async src="${origin}/ad.js"></script>`,
      ].join("\n"),
    },
    {
      id: "hugo",
      label: "Hugo",
      lang: "html",
      note: "Save as layouts/partials/ad.html, then call it with {{ partial \"ad.html\" . }}.",
      code: [
        `<div data-cp-ad data-slot="${slotId}" data-format="${format}"></div>`,
        "{{ if not .Scratch.Get \"cp-ad-loaded\" }}",
        `  ${script}`,
        "  {{ .Scratch.Set \"cp-ad-loaded\" true }}",
        "{{ end }}",
      ].join("\n"),
    },
    {
      id: "wordpress",
      label: "WordPress",
      lang: "php",
      note: "Drop in your theme's functions.php; use [crawlproof_ad] in any post or widget.",
      code: [
        "<?php",
        "add_shortcode('crawlproof_ad', function ($atts) {",
        "    $a = shortcode_atts(['format' => '" + format + "'], $atts);",
        "    return sprintf(",
        "        '<div data-cp-ad data-slot=\"%s\" data-format=\"%s\"></div>',",
        "        esc_attr('" + slotId + "'),",
        "        esc_attr($a['format'])",
        "    );",
        "});",
        "",
        "add_action('wp_enqueue_scripts', function () {",
        "    wp_enqueue_script('crawlproof-ads', '" + origin + "/ad.js', [], null, true);",
        "});",
      ].join("\n"),
    },
  ];
}

// ------------------------------------------------------------ terminal format

function terminalSnippets(slotId: string, origin: string): Snippet[] {
  const url = `${origin}/api/ads/motd?slot=${slotId}&cols=72`;

  return [
    {
      id: "curl",
      label: "curl",
      lang: "bash",
      note: "Add &color=1 for ANSI, &cols=44..120 for width, &src=<tag> to tell surfaces apart.",
      code: [
        "# Plain ASCII over HTTP. No JavaScript, no HTML, no iframe.",
        `curl -fsS --max-time 3 "${url}"`,
      ].join("\n"),
    },
    {
      id: "visitor",
      label: "Repeat visitors",
      lang: "bash",
      note: "Use an opaque random value — never a hostname, username, or IP.",
      code: [
        "# A terminal has no cookies and no localStorage, so unlike the web tag we",
        "# cannot mint a visitor id for you: without one, every fetch looks like a",
        "# brand new person. Generate one stable random id per machine at install",
        "# time and pass it on every request.",
        "id=$(cat /etc/crawlproof-visitor 2>/dev/null) || {",
        "  id=$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \\n')",
        "  printf '%s' \"$id\" >/etc/crawlproof-visitor",
        "}",
        `curl -fsS --max-time 3 "${url}&v=$id"`,
      ].join("\n"),
    },
    {
      id: "shellrc",
      label: "Shell profile",
      lang: "bash",
      note: "--max-time keeps a slow network from delaying every new shell you open.",
      code: [
        "# ~/.zshrc, ~/.bashrc, or /etc/profile.d/crawlproof.sh",
        `curl -fsS --max-time 2 "${url}" 2>/dev/null || true`,
      ].join("\n"),
    },
    {
      id: "motd",
      label: "MOTD (Ubuntu)",
      lang: "bash",
      note: "Save as /etc/update-motd.d/99-crawlproof and chmod +x. Runs at login.",
      code: [
        "#!/bin/sh",
        `curl -fsS --max-time 2 "${url}&src=motd" 2>/dev/null || true`,
      ].join("\n"),
    },
    {
      id: "sshd",
      label: "SSH banner",
      lang: "bash",
      note: "sshd reads Banner from a file, so refresh it on a timer rather than per login.",
      code: [
        "# Refresh the banner file from cron, then point sshd at it:",
        `*/30 * * * * curl -fsS --max-time 3 "${url}&src=ssh" > /etc/ssh/banner.txt`,
        "",
        "# /etc/ssh/sshd_config",
        "Banner /etc/ssh/banner.txt",
      ].join("\n"),
    },
    {
      id: "node-cli",
      label: "Node.js CLI",
      lang: "javascript",
      note: "Never let the ad block your CLI: fail open, always.",
      code: [
        "async function printAd() {",
        "  try {",
        "    const ctl = AbortSignal.timeout(1500);",
        `    const res = await fetch('${url}&src=cli', { signal: ctl });`,
        "    if (res.ok) console.log(await res.text());",
        "  } catch {",
        "    // no network, slow network, bad day — print nothing and carry on",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      id: "python-cli",
      label: "Python CLI",
      lang: "python",
      code: [
        "import urllib.request",
        "",
        "def print_ad():",
        "    try:",
        `        with urllib.request.urlopen('${url}&src=cli', timeout=1.5) as r:`,
        "            print(r.read().decode('utf-8'))",
        "    except Exception:",
        "        pass  # an ad is never worth failing a command over",
      ].join("\n"),
    },
    {
      id: "template",
      label: "Template token",
      lang: "text",
      code: [
        "# Rendering a banner template server-side? Leave a token where the ad goes",
        "#   {{ads}}   {{ads:64}}   {{ads:terminal:64}}",
        "# and swap it for the fetched text before you send the response.",
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------- feed format

/**
 * Snippets for the feed unit.
 *
 * The recurring shape, in every language: fetch, with a short timeout, inside a
 * try/catch that yields nothing on failure, and splice the result into the feed
 * you were already building. The failure branch is not boilerplate — a feed
 * build that throws because an ad server was slow takes the publisher's whole
 * deploy down, which is a far worse outcome than an unsold slot. Every recipe
 * below therefore fails open, and says so.
 */
function feedSnippets(slotId: string, origin: string): Snippet[] {
  const rssUrl = feedAdUrl(origin, slotId, { as: "rss" });
  const atomUrl = feedAdUrl(origin, slotId, { as: "atom" });
  const jsonUrl = feedAdUrl(origin, slotId, { as: "json" });
  const fieldsUrl = feedAdUrl(origin, slotId, { as: "fields" });
  const mdUrl = feedAdUrl(origin, slotId, { as: "markdown" });
  const htmlUrl = feedAdUrl(origin, slotId, { as: "html" });

  return [
    {
      id: "curl-feed",
      label: "curl",
      lang: "bash",
      // No &v= here on purpose: the caller of this endpoint is a build, not a
      // reader, so a visitor id would identify the publisher's CI box rather
      // than a person and would make every impression look like one visitor.
      note: "as=rss|atom|json|html|markdown|text|fields · style=text|card|terminal · guid=daily|weekly|fill|static · n=1..5",
      code: [
        "# One RSS <item>, ready to paste inside your <channel>:",
        `curl -fsS "${rssUrl}"`,
        "",
        "# Three of them, for a long feed:",
        `curl -fsS "${rssUrl}&n=3"`,
        "",
        "# The raw fields, if you render your own items:",
        `curl -fsS "${fieldsUrl}"`,
      ].join("\n"),
    },
    {
      id: "node-rss",
      label: "Node.js",
      lang: "javascript",
      note: "Splices one ad after every 10th item. Returns the feed unchanged if the fetch fails.",
      code: [
        "const AD_EVERY = 10;",
        "",
        "async function fetchAds(n) {",
        "  try {",
        `    const res = await fetch('${rssUrl}&n=' + n, {`,
        "      signal: AbortSignal.timeout(2000),",
        "    });",
        "    if (!res.ok) return [];",
        "    const xml = await res.text();",
        "    // The endpoint returns n items concatenated; split them back apart.",
        "    return xml.match(/<item>[\\s\\S]*?<\\/item>/g) ?? [];",
        "  } catch {",
        "    return []; // never fail a build over an ad",
        "  }",
        "}",
        "",
        "// itemsXml is your array of rendered <item> strings.",
        "async function withAds(itemsXml) {",
        "  const wanted = Math.floor(itemsXml.length / AD_EVERY);",
        "  if (wanted < 1) return itemsXml; // too short to carry one",
        "",
        "  const ads = await fetchAds(Math.min(wanted, 5));",
        "  const out = [];",
        "  let next = 0;",
        "  for (let i = 0; i < itemsXml.length; i++) {",
        "    out.push(itemsXml[i]);",
        "    if ((i + 1) % AD_EVERY === 0 && next < ads.length) out.push(ads[next++]);",
        "  }",
        "  return out;",
        "}",
      ].join("\n"),
    },
    {
      id: "node-feed-pkg",
      label: "Node — feed pkg",
      lang: "javascript",
      note: "For the `feed` npm package, which builds the item for you — so take as=fields, not as=rss.",
      code: [
        "import { Feed } from 'feed';",
        "",
        "async function addSponsor(feed) {",
        "  try {",
        `    const res = await fetch('${fieldsUrl}', { signal: AbortSignal.timeout(2000) });`,
        "    if (!res.ok) return;",
        "    const { items } = await res.json();",
        "    for (const ad of items) {",
        "      feed.addItem({",
        "        title: ad.title,",
        "        id: ad.guid,",
        "        link: ad.url,",
        "        description: ad.body,",
        "        content: ad.html,",
        "        date: new Date(ad.publishedAt),",
        "        category: [{ name: ad.label }],",
        "      });",
        "    }",
        "  } catch {",
        "    // unsold is fine; broken is not",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      id: "next-route",
      label: "Next.js",
      lang: "javascript",
      note: "app/feed.xml/route.js. force-dynamic, or Next caches one advertiser's ad forever.",
      code: [
        "export const dynamic = 'force-dynamic';",
        "",
        "export async function GET() {",
        "  const items = await renderItems(); // your <item> strings",
        "",
        "  let ads = [];",
        "  try {",
        `    const res = await fetch('${rssUrl}&n=3', {`,
        "      signal: AbortSignal.timeout(2000),",
        "      cache: 'no-store',",
        "    });",
        "    if (res.ok) ads = (await res.text()).match(/<item>[\\s\\S]*?<\\/item>/g) ?? [];",
        "  } catch {}",
        "",
        "  const body = interleave(items, ads, 10).join('\\n');",
        "  return new Response(rssShell(body), {",
        "    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },",
        "  });",
        "}",
      ].join("\n"),
    },
    {
      id: "express",
      label: "Express",
      lang: "javascript",
      code: [
        "app.get('/feed.xml', async (req, res) => {",
        "  const items = await renderItems();",
        "",
        "  let ad = '';",
        "  try {",
        `    const r = await fetch('${rssUrl}', { signal: AbortSignal.timeout(2000) });`,
        "    if (r.ok) ad = await r.text();",
        "  } catch {}",
        "",
        "  items.splice(10, 0, ad); // after the 10th post",
        "  res.type('application/rss+xml').send(rssShell(items.join('\\n')));",
        "});",
      ].join("\n"),
    },
    {
      id: "hono",
      label: "Hono / Deno / Bun",
      lang: "javascript",
      code: [
        "app.get('/feed.xml', async (c) => {",
        "  let ad = '';",
        "  try {",
        `    const r = await fetch('${rssUrl}', { signal: AbortSignal.timeout(2000) });`,
        "    if (r.ok) ad = await r.text();",
        "  } catch {}",
        "",
        "  const items = await renderItems();",
        "  items.splice(10, 0, ad);",
        "  return c.body(rssShell(items.join('\\n')), 200, {",
        "    'content-type': 'application/rss+xml; charset=utf-8',",
        "  });",
        "});",
      ].join("\n"),
    },
    {
      id: "eleventy",
      label: "Eleventy (11ty)",
      lang: "javascript",
      note: "Fetched once per build in .eleventy.js, then read as a global in your feed template.",
      code: [
        "// .eleventy.js",
        "module.exports = function (cfg) {",
        "  cfg.addGlobalData('sponsor', async () => {",
        "    try {",
        `      const r = await fetch('${fieldsUrl}', { signal: AbortSignal.timeout(2000) });`,
        "      if (!r.ok) return null;",
        "      return (await r.json()).items[0] ?? null;",
        "    } catch {",
        "      return null;",
        "    }",
        "  });",
        "};",
        "",
        "<!-- feed.njk, inside your <channel> -->",
        "{% if sponsor %}",
        "<item>",
        "  <title>{{ sponsor.title }}</title>",
        "  <link>{{ sponsor.url }}</link>",
        "  <guid isPermaLink=\"false\">{{ sponsor.guid }}</guid>",
        "  <category>{{ sponsor.label }}</category>",
        "  <description>{{ sponsor.html }}</description>",
        "</item>",
        "{% endif %}",
      ].join("\n"),
    },
    {
      id: "hugo",
      label: "Hugo",
      lang: "html",
      note: "getJSON caches for the whole build, so one fetch covers every feed Hugo renders.",
      code: [
        "{{/* layouts/_default/rss.xml — inside <channel>, after the range */}}",
        `{{ $ad := getJSON "${fieldsUrl}" }}`,
        "{{ with (index $ad.items 0) }}",
        "<item>",
        "  <title>{{ .title }}</title>",
        "  <link>{{ .url }}</link>",
        "  <guid isPermaLink=\"false\">{{ .guid }}</guid>",
        "  <pubDate>{{ .publishedAt }}</pubDate>",
        "  <category>{{ .label }}</category>",
        "  <description>{{ .html }}</description>",
        "</item>",
        "{{ end }}",
      ].join("\n"),
    },
    {
      id: "jekyll",
      label: "Jekyll",
      lang: "ruby",
      note: "Liquid cannot make HTTP calls, so the fetch is a generator plugin; the template reads site.data.",
      code: [
        "# _plugins/crawlproof.rb",
        "require 'net/http'",
        "require 'json'",
        "",
        "Jekyll::Hooks.register :site, :after_init do |site|",
        "  begin",
        `    uri = URI('${fieldsUrl}')`,
        "    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 2, read_timeout: 2) do |http|",
        "      http.get(uri.request_uri)",
        "    end",
        "    site.config['sponsor'] = JSON.parse(res.body)['items'].first if res.is_a?(Net::HTTPSuccess)",
        "  rescue StandardError",
        "    site.config['sponsor'] = nil",
        "  end",
        "end",
      ].join("\n"),
    },
    {
      id: "astro-rss",
      label: "Astro (@astrojs/rss)",
      lang: "javascript",
      note: "@astrojs/rss builds the item, so take as=fields and hand it customData for the disclosure.",
      code: [
        "import rss from '@astrojs/rss';",
        "",
        "export async function GET(context) {",
        "  const posts = await getPosts();",
        "",
        "  let ad = null;",
        "  try {",
        `    const r = await fetch('${fieldsUrl}', { signal: AbortSignal.timeout(2000) });`,
        "    if (r.ok) ad = (await r.json()).items[0];",
        "  } catch {}",
        "",
        "  const items = posts.map(toRssItem);",
        "  if (ad) {",
        "    items.splice(10, 0, {",
        "      title: ad.title,",
        "      link: ad.url,",
        "      pubDate: new Date(ad.publishedAt),",
        "      content: ad.html,",
        "      customData: '<category>' + ad.label + '</category>',",
        "    });",
        "  }",
        "",
        "  return rss({ title: 'My blog', description: '…', site: context.site, items });",
        "}",
      ].join("\n"),
    },
    {
      id: "wordpress-feed",
      label: "WordPress",
      lang: "php",
      note: "rss2_item fires inside each <item>, so this appends the ad to the 10th post's own item.",
      code: [
        "<?php",
        "add_action('rss2_item', function () {",
        "    static $n = 0;",
        "    if (++$n !== 10) return;",
        "",
        `    $res = wp_remote_get('${rssUrl}', ['timeout' => 2]);`,
        "    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {",
        "        return; // unsold, unreachable, whatever — the feed is unaffected",
        "    }",
        "    // Closes this <item> and opens the next, so the ad is a sibling.",
        "    echo '</item>' . wp_remote_retrieve_body($res) . '<item>';",
        "});",
      ].join("\n"),
    },
    {
      id: "php",
      label: "PHP",
      lang: "php",
      code: [
        "<?php",
        "function crawlproof_ad(): string {",
        "    $ctx = stream_context_create(['http' => ['timeout' => 2, 'ignore_errors' => true]]);",
        `    $body = @file_get_contents('${rssUrl}', false, $ctx);`,
        "    return $body === false ? '' : $body;",
        "}",
        "",
        "// Inside your <channel>, after the tenth item:",
        "echo crawlproof_ad();",
      ].join("\n"),
    },
    {
      id: "python-feedgen",
      label: "Python (feedgen)",
      lang: "python",
      code: [
        "import requests",
        "from feedgen.feed import FeedGenerator",
        "",
        "def add_sponsor(fg: FeedGenerator) -> None:",
        "    try:",
        `        r = requests.get('${fieldsUrl}', timeout=2)`,
        "        r.raise_for_status()",
        "        ad = r.json()['items'][0]",
        "    except Exception:",
        "        return  # an unsold slot must never break the feed",
        "",
        "    e = fg.add_entry()",
        "    e.id(ad['guid'])",
        "    e.title(ad['title'])",
        "    e.link(href=ad['url'])",
        "    e.description(ad['html'])",
        "    e.category(term=ad['label'])",
        "    e.pubDate(ad['publishedAt'])",
      ].join("\n"),
    },
    {
      id: "django",
      label: "Django",
      lang: "python",
      note: "Django's syndication framework builds items from objects, so wrap the ad in one.",
      code: [
        "import requests",
        "from django.contrib.syndication.views import Feed",
        "",
        "class PostFeed(Feed):",
        "    def items(self):",
        "        posts = list(Post.objects.order_by('-published')[:50])",
        "        ad = self._sponsor()",
        "        if ad and len(posts) > 10:",
        "            posts.insert(10, ad)",
        "        return posts",
        "",
        "    def _sponsor(self):",
        "        try:",
        `            r = requests.get('${fieldsUrl}', timeout=2)`,
        "            r.raise_for_status()",
        "            return SponsorItem(r.json()['items'][0])",
        "        except Exception:",
        "            return None",
      ].join("\n"),
    },
    {
      id: "ruby",
      label: "Ruby",
      lang: "ruby",
      code: [
        "require 'net/http'",
        "require 'json'",
        "",
        "def crawlproof_ad",
        `  uri = URI('${fieldsUrl}')`,
        "  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 2, read_timeout: 2) do |http|",
        "    http.get(uri.request_uri)",
        "  end",
        "  res.is_a?(Net::HTTPSuccess) ? JSON.parse(res.body)['items'].first : nil",
        "rescue StandardError",
        "  nil",
        "end",
      ].join("\n"),
    },
    {
      id: "go",
      label: "Go",
      lang: "go",
      code: [
        "func crawlproofAd(ctx context.Context) string {",
        "    ctx, cancel := context.WithTimeout(ctx, 2*time.Second)",
        "    defer cancel()",
        "",
        `    req, err := http.NewRequestWithContext(ctx, "GET", "${rssUrl}", nil)`,
        "    if err != nil {",
        `        return ""`,
        "    }",
        "    res, err := http.DefaultClient.Do(req)",
        "    if err != nil {",
        `        return "" // unsold beats a failed build`,
        "    }",
        "    defer res.Body.Close()",
        "    if res.StatusCode != http.StatusOK {",
        `        return ""`,
        "    }",
        "    b, _ := io.ReadAll(res.Body)",
        "    return string(b)",
        "}",
      ].join("\n"),
    },
    {
      id: "worker",
      label: "Cloudflare Worker",
      lang: "javascript",
      note: "Monetise a feed you do not generate: fetch the origin's, inject, serve.",
      code: [
        "export default {",
        "  async fetch(request) {",
        "    const upstream = await fetch('https://example.com/feed.xml');",
        "    let xml = await upstream.text();",
        "",
        "    try {",
        `      const r = await fetch('${rssUrl}&src=worker');`,
        "      if (r.ok) {",
        "        const ad = await r.text();",
        "        // After the 10th </item>, or at the end of the channel if shorter.",
        "        let n = 0;",
        "        xml = xml.replace(/<\\/item>/g, (m) => (++n === 10 ? m + ad : m));",
        "      }",
        "    } catch {}",
        "",
        "    return new Response(xml, {",
        "      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },",
        "    });",
        "  },",
        "};",
      ].join("\n"),
    },
    {
      id: "jsonfeed",
      label: "JSON Feed",
      lang: "javascript",
      note: "as=json returns an array of JSON Feed 1.1 items — splice it straight into feed.items.",
      code: [
        "const feed = { version: 'https://jsonfeed.org/version/1.1', title: 'My blog', items };",
        "",
        "try {",
        `  const r = await fetch('${jsonUrl}&n=3', { signal: AbortSignal.timeout(2000) });`,
        "  if (r.ok) {",
        "    const ads = await r.json();",
        "    ads.forEach((ad, i) => feed.items.splice(10 * (i + 1) + i, 0, ad));",
        "  }",
        "} catch {}",
      ].join("\n"),
    },
    {
      id: "atom",
      label: "Atom",
      lang: "bash",
      note: "as=atom returns an <entry> using core Atom elements only — no namespace to declare.",
      code: [
        "# Paste inside your <feed>, between entries:",
        `curl -fsS "${atomUrl}"`,
      ].join("\n"),
    },
    {
      id: "markdown",
      label: "Markdown",
      lang: "bash",
      note: "For newsletters, digests, and static-site builds that template in Markdown.",
      code: [
        `curl -fsS "${mdUrl}"`,
        "",
        "# style=card for a headline, body and its own call-to-action line:",
        `curl -fsS "${mdUrl}&style=card"`,
      ].join("\n"),
    },
    {
      id: "html-body",
      label: "HTML body",
      lang: "bash",
      note: "Just the body — for when your generator already owns the item envelope.",
      code: [
        `curl -fsS "${htmlUrl}"`,
        "",
        "# style=terminal renders the ASCII box in a <pre>, for developer feeds:",
        `curl -fsS "${htmlUrl}&style=terminal"`,
      ].join("\n"),
    },
  ];
}

/**
 * Every snippet for a format.
 *
 * The first entry is the one shown by default, so each list leads with the
 * recipe most publishers of that unit actually want.
 */
export function snippetsFor(format: AdFormatId, slotId: string, origin: string): Snippet[] {
  if (format === TERMINAL_FORMAT_ID) return terminalSnippets(slotId, origin);
  if (format === FEED_FORMAT_ID) return feedSnippets(slotId, origin);
  return webSnippets(slotId, format, origin);
}

/** One line under the format buttons explaining what this unit *is*. */
export function formatBlurb(format: AdFormatId): string {
  if (format === TERMINAL_FORMAT_ID) {
    return "Fetched as plain text and printed by a shell — MOTDs, SSH banners, CLI tools.";
  }
  if (format === FEED_FORMAT_ID) {
    return "Fetched at build time and spliced into a feed you generate — RSS, Atom, JSON Feed, newsletters.";
  }
  return "Rendered in the browser by ad.js inside an isolated iframe.";
}
