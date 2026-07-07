import tls from "node:tls";
import { Agent, type buildConnector, type Dispatcher } from "undici";
import { SocksClient } from "socks";
import { env } from "./env";

// Tor routing for .onion targets. Onion addresses don't resolve via DNS, so any
// fetch to one must go through a Tor SOCKS5 proxy (socks5h — the proxy resolves
// the hostname). Configure TOR_SOCKS_URL (e.g. socks5h://127.0.0.1:9050) and a
// Tor sidecar; without it, .onion fetches fail fast with a clear message.

export function isOnion(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname;
    return /(^|\.)[a-z2-7]{16,56}\.onion$/i.test(h);
  } catch {
    return false;
  }
}

export function torConfigured(): boolean {
  return !!env.torSocksUrl;
}

let cachedDispatcher: Dispatcher | null = null;

function torDispatcher(): Dispatcher {
  if (cachedDispatcher) return cachedDispatcher;
  const u = new URL(env.torSocksUrl);
  const proxyHost = u.hostname || "127.0.0.1";
  const proxyPort = Number(u.port) || 9050;

  const connect: buildConnector.connector = (opts, cb) => {
    const isHttps = (opts.protocol ?? "https:") === "https:";
    const destPort = Number(opts.port) || (isHttps ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5 },
      command: "connect",
      // host is the .onion — SOCKS5 sends it to Tor to resolve (socks5h).
      destination: { host: opts.hostname, port: destPort },
      timeout: 20_000,
    })
      .then(({ socket }) => {
        if (!isHttps) return cb(null, socket);
        const tlsSocket = tls.connect({
          socket,
          servername: opts.servername || opts.hostname,
          rejectUnauthorized: false,
        });
        tlsSocket.once("secureConnect", () => cb(null, tlsSocket));
        tlsSocket.once("error", (err) => cb(err, null));
      })
      .catch((err) => cb(err as Error, null));
  };
  cachedDispatcher = new Agent({ connect });
  return cachedDispatcher;
}

// Fetch that transparently routes .onion targets through Tor and everything
// else through the normal stack. Callers pass their usual RequestInit.
export async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!isOnion(url)) return fetch(url, init);
  if (!torConfigured()) {
    throw new Error(
      "This is a .onion address; set TOR_SOCKS_URL and run a Tor proxy to reach it.",
    );
  }
  // Node's global fetch accepts an undici dispatcher.
  return fetch(url, { ...(init ?? {}), dispatcher: torDispatcher() } as RequestInit);
}
