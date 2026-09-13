// GET /affiliate/u/:code/openprofile.md — an OpenProfile.md for one of our
// affiliates, so they can join other merchants' programs with a profile URL
// that answers. Public by nature (it is what a merchant reads); it carries
// only what the affiliate put on their membership.
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { linkForMembership, membershipByCode } from "@/lib/affiliate/memberships";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const m = await membershipByCode(code.toLowerCase());
  if (!m || m.status === "refused" || m.status === "ended") return new NextResponse("Not found", { status: 404 });
  const site = env.siteUrl.replace(/\/$/, "");
  const name = m.displayName ?? m.code;
  const lines = [
    `# ${name}`,
    "",
    `Kind: ${m.kind}`,
    `Handle: ${m.code}`,
    `Web: ${site}/affiliate/u/${m.code}`,
    ...(m.payAddress ? [`Pay: ${m.payAddress.includes(":") ? m.payAddress : `eip155:137:${m.payAddress}`}`] : []),
    "",
    `CrawlProof affiliate since ${m.createdAt.slice(0, 10)}.`,
    "",
    "## Accounts",
    "",
    `- ${linkForMembership(m)}`,
    ...(m.profileUrl ? [`- ${m.profileUrl}`] : []),
    "",
    "## Operator",
    "",
    `- ${site}/.well-known/openprofile.md`,
    "",
  ];
  return new NextResponse(lines.join("\n"), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
