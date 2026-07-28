// Prove a discovered mailbox actually works before we store a password for it.
//
// Discovery produces a proposal; this logs in. Storing credentials that turn
// out to be wrong is worse than refusing them, because the failure then shows
// up much later as a silently broken campaign.
//
// SMTP goes through nodemailer, which the outreach sender already uses, so a
// passing check here means the same code path will send. IMAP is checked over
// a raw TLS socket: the only question is whether LOGIN succeeds, and a
// hand-rolled exchange answers it without adding an IMAP client dependency
// for one command.

import tls from "node:tls";
import net from "node:net";
import nodemailer from "nodemailer";
import type { MailboxServer } from "./mailboxDiscovery";

export type VerifyResult = { ok: true } | { ok: false; error: string };

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Map a raw protocol error onto something a user can act on.
 *
 * Mail servers phrase rejections badly and inconsistently; the point here is
 * that "wrong password" and "your host blocks this" lead to different fixes.
 */
function explain(raw: string): string {
  const m = raw.toLowerCase();
  const authRejected =
    /invalid (login|password|credential)/.test(m) ||
    /authenticationfailed|authentication failed|login failed|bad credential/.test(m) ||
    (m.includes("auth") && m.includes("fail"));
  if (authRejected) {
    // Keep whatever the server said after the generic explanation — hosts
    // often name the exact page where a mailbox password is generated, which
    // is more useful than anything we could write.
    const detail = raw.replace(/^(NO|BAD)\s*/i, "").trim().slice(0, 200);
    return `The server rejected that username and password. If your provider requires an app-specific password, use that rather than your account password.${
      detail ? ` The server said: ${detail}` : ""
    }`;
  }
  if (m.includes("certificate") || m.includes("altname") || m.includes("self signed")) {
    return "The server's TLS certificate didn't validate for that hostname. Check the hostname is exactly what your mail host documents.";
  }
  if (m.includes("timeout") || m.includes("etimedout")) {
    return "Connection timed out — the host or port is probably wrong, or the server is blocking us.";
  }
  if (m.includes("enotfound") || m.includes("eai_again")) {
    return "That hostname doesn't resolve. Check it for typos.";
  }
  if (m.includes("econnrefused")) {
    return "The server refused the connection on that port. Check the port and encryption setting.";
  }
  return raw.slice(0, 300);
}

export async function verifySmtp(
  server: MailboxServer,
  password: string,
): Promise<VerifyResult> {
  try {
    const transporter = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.socket === "SSL",
      requireTLS: server.socket === "STARTTLS",
      auth: { user: server.username, pass: password },
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: CONNECT_TIMEOUT_MS,
    });
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: explain(error instanceof Error ? error.message : "SMTP check failed") };
  }
}

// IMAP quoted-string escaping (RFC 3501 §4.3) — a password containing a quote
// or backslash would otherwise desynchronise the command stream.
function imapQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Connect, LOGIN, LOGOUT. Resolves ok only on a tagged OK.
 *
 * STARTTLS is deliberately not implemented: sending a password over a
 * connection we never upgraded would be worse than declining, and every
 * provider worth connecting to offers implicit TLS on 993.
 */
export async function verifyImap(
  server: MailboxServer,
  password: string,
): Promise<VerifyResult> {
  if (server.socket !== "SSL") {
    return {
      ok: false,
      error:
        "Only implicit TLS (usually port 993) is supported for the IMAP check, to avoid ever sending your password over a plaintext connection.",
    };
  }

  return new Promise<VerifyResult>((resolve) => {
    let settled = false;
    const done = (result: VerifyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: explain("timeout") }),
      CONNECT_TIMEOUT_MS,
    );

    const socket = tls.connect(
      {
        host: server.host,
        port: server.port,
        servername: net.isIP(server.host) ? undefined : server.host,
        timeout: CONNECT_TIMEOUT_MS,
      },
      () => {
        if (!socket.authorized && socket.authorizationError) {
          done({ ok: false, error: explain(String(socket.authorizationError)) });
        }
      },
    );

    let buffer = "";
    let sentLogin = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\r\n")) return;

      if (!sentLogin) {
        // Server greeting. * OK means ready; * BYE / * NO means refused.
        if (/^\* (BYE|NO)/i.test(buffer)) {
          done({ ok: false, error: explain(buffer.trim()) });
          return;
        }
        if (!/^\* (OK|PREAUTH)/i.test(buffer)) return;
        sentLogin = true;
        buffer = "";
        socket.write(`a1 LOGIN ${imapQuote(server.username)} ${imapQuote(password)}\r\n`);
        return;
      }

      // Tagged response to our LOGIN.
      const tagged = buffer.match(/^a1 (OK|NO|BAD)(.*)$/im);
      if (!tagged) return;
      if (tagged[1].toUpperCase() === "OK") {
        socket.write("a2 LOGOUT\r\n");
        done({ ok: true });
      } else {
        done({ ok: false, error: explain(`${tagged[1]}${tagged[2]}`.trim() || "invalid login") });
      }
    });

    socket.on("error", (error: Error) => done({ ok: false, error: explain(error.message) }));
    socket.on("timeout", () => done({ ok: false, error: explain("timeout") }));
    socket.on("close", () =>
      done({ ok: false, error: "The server closed the connection before the login completed." }),
    );
  });
}
