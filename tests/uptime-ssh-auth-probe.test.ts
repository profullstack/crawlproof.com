import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { fingerprint, parsePublicKey, probeSshAuth } from "../lib/ssh-auth-probe";

// A real sshd stand-in: accepts `allowed` for user "deploy" and records whether
// a client ever sent a signature or reached an authenticated session.
const hostKey = utils.generateKeyPairSync("ed25519");
const allowed = utils.generateKeyPairSync("ed25519", { comment: "allowed@test" });
const other = utils.generateKeyPairSync("ed25519", { comment: "other@test" });
const allowedPub = utils.parseKey(allowed.public) as import("ssh2").ParsedKey;

let server: Server;
let port = 0;
let signaturesSeen = 0;
let sessionsOpened = 0;

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "publickey" &&
        ctx.username === "deploy" &&
        ctx.key.algo === allowedPub.type &&
        ctx.key.data.equals(allowedPub.getPublicSSH())
      ) {
        if (ctx.signature) signaturesSeen++;
        return ctx.accept(); // without a signature this is PK_OK
      }
      ctx.reject(["publickey"]);
    });
    client.on("ready", () => sessionsOpened++);
    client.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const probe = (username: string, publicKey: string, p = port) =>
  probeSshAuth({ host: "127.0.0.1", port: p, username, publicKey, timeoutMs: 5000 });

describe("ssh auth probe", () => {
  it("reports an authorized key as accepted without signing or logging in", async () => {
    expect(await probe("deploy", allowed.public)).toMatchObject({ reachable: true, accepted: true });
    expect(signaturesSeen).toBe(0);
    expect(sessionsOpened).toBe(0);
  });

  it("reports a key the server does not know as rejected", async () => {
    expect(await probe("deploy", other.public)).toMatchObject({ reachable: true, accepted: false });
  });

  it("reports the right key for the wrong user as rejected", async () => {
    expect(await probe("root", allowed.public)).toMatchObject({ reachable: true, accepted: false });
  });

  it("reports a closed port as unreachable", async () => {
    const r = await probe("deploy", allowed.public, 1);
    expect(r.reachable).toBe(false);
  });
});

describe("parsePublicKey", () => {
  it("accepts an OpenSSH public key line and fingerprints it", () => {
    const r = parsePublicKey(allowed.public);
    expect("key" in r).toBe(true);
    if ("key" in r) expect(fingerprint(r.key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("refuses a private key", () => {
    expect(parsePublicKey(allowed.private)).toEqual({
      error: "That is a private key. Paste the public key (the .pub file) instead.",
    });
  });

  it("refuses garbage and empty input", () => {
    expect("error" in parsePublicKey("not a key")).toBe(true);
    expect(parsePublicKey("  ")).toEqual({ error: "Public key is required." });
  });
});
