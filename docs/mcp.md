# CrawlProof MCP server

A real [Model Context Protocol](https://modelcontextprotocol.io) server, built
on the official `@modelcontextprotocol/sdk` (via the `mcp-handler` Next adapter)
and mounted on the existing app — **no separate service**.

- **Endpoint:** `https://crawlproof.com/api/mcp`
- **Transport:** Streamable HTTP
- **Auth:** `Authorization: Bearer crp_…` — a CrawlProof API token. Mint one in
  the app under **Social → API tokens** (server action `createApiToken`). The
  token scopes every call to that user's own connected accounts.

## Connect your agent

Any MCP client that supports a remote Streamable-HTTP server with a custom auth
header, e.g.:

```json
{
  "mcpServers": {
    "crawlproof": {
      "url": "https://crawlproof.com/api/mcp",
      "headers": { "Authorization": "Bearer crp_xxxxxxxx" }
    }
  }
}
```

For clients that only speak stdio, bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "crawlproof": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://crawlproof.com/api/mcp",
               "--header", "Authorization: Bearer crp_xxxxxxxx"]
    }
  }
}
```

## Raw curl

The Streamable-HTTP transport **requires** `Accept: application/json, text/event-stream`.

```bash
# list tools
curl -s https://crawlproof.com/api/mcp \
  -H "Authorization: Bearer $CRAWLPROOF_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# write + post in one call
curl -s https://crawlproof.com/api/mcp \
  -H "Authorization: Bearer $CRAWLPROOF_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"promote_url","arguments":{"url":"https://example.com"}}}'
```

Responses come back as SSE frames (`event: message` / `data: {…}`).

## Tools (module: `promote`)

| Tool | What it does |
|------|--------------|
| `list_accounts` | List the caller's connected social accounts (platform, handle, id). |
| `generate_promo_post` | Write an on-brand promo post for a URL. Does **not** publish — returns the text. `{ url, platform?, angle?, brand_voice? }` |
| `post_to_socials` | Publish given text to accounts (all active, or `account_ids`). `{ text, account_ids? }` |
| `promote_url` | One shot: write a per-platform promo post for a URL and publish it. `{ url, account_ids?, angle?, brand_voice? }` |

Cookie-auth platforms (reddit/facebook/…) publish asynchronously, so their
result reads **`queued`** — the post lands shortly after and the View-post link
appears in the app's Promote history.

## Example

> "Write me a promo post for https://pairux.com and post it on my socials using
> the crawlproof MCP server."

The agent calls `promote_url({ url: "https://pairux.com" })` and gets a
per-account summary (posted → URL, or queued, or the error).

## Adding capabilities

Each capability is a module that registers its tools onto the SDK server. Add a
`registerXxxTools(server)` (see `lib/mcp/promote.ts`) and call it in the
`createMcpHandler` initializer in `app/api/mcp/route.ts`.
