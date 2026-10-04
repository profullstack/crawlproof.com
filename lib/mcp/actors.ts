// Declared actors for the CrawlProof MCP server (lib/tracker/actors.ts): an
// agent can register itself, mint the token it sends as Crawlproof-Actor, and
// see its own footprint. Scoped to the authenticated user like every module.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { createActor, listActors, mintToken } from "@/lib/tracker/actorStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUserId(extra: any): string {
  const info = extra?.authInfo;
  const uid = info?.extra?.userId ?? info?.clientId;
  if (!uid || typeof uid !== "string") throw new Error("Unauthenticated.");
  return uid;
}
function textResult(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const HOW_TO =
  "Send the token with visits as the `Crawlproof-Actor` request header (Playwright extraHTTPHeaders), " +
  "a `?crp_actor=<token>` link, or `crawlproof('actor', '<token>')`. It is shown once.";

export function registerActorTools(server: McpServer): void {
  server.registerTool(
    "list_actors",
    {
      description:
        "The caller's declared actors (people and agents that say who they are to sites running the CrawlProof tracker), with tokens and last-30-day use.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const res = await listActors(serviceClient(), getUserId(extra));
      if (!res.ok) return textResult(`Error: ${res.error}`);
      if (!res.value.length) return textResult("No actors yet.");
      return textResult(
        res.value
          .map((a) => {
            const u = a.last30;
            const flags = u.contradictions ? `, ${u.contradictions} contradicted by bot detection` : "";
            return `- ${a.kind} ${a.email}${a.name ? ` (${a.name})` : ""} ${a.email_verified ? "verified" : "unverified"}, ${a.visibility} (id: ${a.id})\n  30d: ${u.pageviews} pv, ${u.events} ev on ${u.sites} sites${flags}; ${a.tokens.length} live token(s)`;
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "add_actor",
    {
      description:
        "Register a declared actor (self-reported, opt-in) and mint its first token. An agent is believed; a human never overrides bot detection.",
      inputSchema: {
        email: z.string().describe("The actor's email. Verified automatically if it is the caller's login, else a verification email is sent."),
        kind: z.enum(["human", "agent"]),
        name: z.string().optional(),
        operator: z.string().optional().describe("For an agent: the email or id of the caller's human actor who runs it."),
        public: z.boolean().optional().describe("Show the name to other site owners (default private)."),
      },
    },
    async (args, extra) => {
      const res = await createActor(serviceClient(), getUserId(extra), {
        email: args.email,
        kind: args.kind,
        name: args.name,
        operator: args.operator,
        visibility: args.public ? "public" : "private",
        tokenLabel: "mcp",
      });
      if (!res.ok) return textResult(`Error: ${res.error}`);
      const v = res.value;
      return textResult(
        `Added ${v.actor.kind} ${v.actor.email} (id: ${v.actor.id}); verification: ${v.verification}.\nToken: ${v.token}\n${HOW_TO}`,
      );
    },
  );

  server.registerTool(
    "mint_actor_token",
    {
      description: "Mint another token for one of the caller's actors, e.g. one per agent run or browser.",
      inputSchema: {
        actor_id: z.string(),
        label: z.string().optional(),
      },
    },
    async (args, extra) => {
      const res = await mintToken(serviceClient(), getUserId(extra), args.actor_id, args.label ?? "mcp");
      if (!res.ok) return textResult(`Error: ${res.error}`);
      return textResult(`Token: ${res.value.token}\n${HOW_TO}`);
    },
  );
}
