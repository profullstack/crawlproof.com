import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSeal,
  isSealedValue,
  openPrivateKey,
  openWithPrivateKey,
  parseTtl,
  rewrapSeal,
  sealToPublicKey,
  unlockSeal,
  unlockSealWithRecovery,
  verifyDataKey,
  UNLOCK_MAX_TTL_SECONDS,
  WrongPassphraseError,
  type CreatedSeal,
} from "@/lib/sealed/crypto";
import { clearAllUnlocks, isUnlocked, lockOwner, privateKeyFor, unlockOwner, unlockStatus } from "@/lib/sealed/unlockStore";
import { decryptSecret, encryptSecret, isLockedError, setSealLoaderForTests, SealRequiredError } from "@/lib/sealed/vault";
import { legacyDecryptForMigration, legacyEncryptForTests } from "@/lib/sealed/legacy";
import { resealRow, SP_ACCOUNT_COLUMNS, OUTREACH_PLAINTEXT, OUTREACH_CONFIG_COLUMNS } from "@/lib/sealed/migrate";
import { getOperatorSecret, setOperatorRowLoaderForTests } from "@/lib/sealed/operator";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PASS = "correct horse battery staple";

let created: CreatedSeal;

beforeAll(async () => {
  created = await createSeal(PASS, OWNER);
  setSealLoaderForTests(async (id) => (id === OWNER ? created.seal : null));
});

afterEach(() => {
  clearAllUnlocks();
  vi.unstubAllEnvs();
});

describe("seal / unseal", () => {
  it("uses PBKDF2 >= 600k with a random 16-byte salt and stores no plaintext key", () => {
    expect(created.seal.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(atob(created.seal.kdf.salt)).toHaveLength(16);
    expect(JSON.stringify(created.seal)).not.toContain(PASS);
  });

  it("passphrase and recovery key both yield the same data key; a wrong one is refused", async () => {
    const a = await unlockSeal(created.seal, PASS, OWNER);
    const b = await unlockSealWithRecovery(created.seal, created.recoveryKey, OWNER);
    expect(Buffer.from(a).equals(Buffer.from(created.dek))).toBe(true);
    expect(Buffer.from(b).equals(Buffer.from(created.dek))).toBe(true);
    await expect(unlockSeal(created.seal, "wrong passphrase!!", OWNER)).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await verifyDataKey(new Uint8Array(32), created.seal, OWNER)).toBe(false);
  });

  it("binds ciphertext to owner + field (AAD)", async () => {
    const key = await openPrivateKey(created.dek, created.seal, OWNER);
    const v = await sealToPublicKey(created.seal.public_key, "tok", OWNER, "enc_access_token");
    expect(isSealedValue(v)).toBe(true);
    expect(await openWithPrivateKey(key, v, OWNER, "enc_access_token")).toBe("tok");
    await expect(openWithPrivateKey(key, v, OWNER, "enc_refresh_token")).rejects.toThrow();
    await expect(openWithPrivateKey(key, v, OTHER, "enc_access_token")).rejects.toThrow();
  });

  it("changing the passphrase keeps every sealed secret readable", async () => {
    const v = await sealToPublicKey(created.seal.public_key, "still here", OWNER, "f");
    const next = await rewrapSeal(created.dek, created.seal, "a brand new passphrase", OWNER);
    const dek = await unlockSeal(next, "a brand new passphrase", OWNER);
    const key = await openPrivateKey(dek, next, OWNER);
    expect(await openWithPrivateKey(key, v, OWNER, "f")).toBe("still here");
    await expect(unlockSeal(next, PASS, OWNER)).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe("unlock store", () => {
  it("clamps TTL to 7 days and expires", async () => {
    const key = await openPrivateKey(created.dek, created.seal, OWNER);
    const now = 1_000_000;
    const { expiresAt } = unlockOwner(OWNER, key, 30 * 86400, now);
    expect(expiresAt - now).toBe(UNLOCK_MAX_TTL_SECONDS * 1000);
    expect(isUnlocked(OWNER, now + 1000)).toBe(true);
    expect(privateKeyFor(OWNER, expiresAt + 1)).toBeNull();
    expect(unlockStatus(OWNER, expiresAt + 1).unlocked).toBe(false);
    expect(parseTtl("8h")).toBe(8 * 3600);
    expect(parseTtl("30d")).toBe(UNLOCK_MAX_TTL_SECONDS);
  });

  it("Lock and a restart both drop the key; jobs then see a locked error, not a crash", async () => {
    const key = await openPrivateKey(created.dek, created.seal, OWNER);
    const v = await encryptSecret("bot-token", { ownerId: OWNER, field: "enc_access_token" });
    unlockOwner(OWNER, key, 3600);
    expect(await decryptSecret(v, { ownerId: OWNER, field: "enc_access_token" })).toBe("bot-token");
    lockOwner(OWNER);
    const err = await decryptSecret(v, { ownerId: OWNER, field: "enc_access_token" }).catch((e) => e);
    expect(isLockedError(err)).toBe(true);
    unlockOwner(OWNER, key, 3600);
    clearAllUnlocks(); // simulated restart
    expect(isLockedError(await decryptSecret(v, { ownerId: OWNER, field: "enc_access_token" }).catch((e) => e))).toBe(true);
  });

  it("encrypting needs only the public key (OAuth callback while locked) but requires a seal", async () => {
    const v = await encryptSecret("x", { ownerId: OWNER, field: "f" });
    expect(isSealedValue(v)).toBe(true);
    await expect(encryptSecret("x", { ownerId: OTHER, field: "f" })).rejects.toBeInstanceOf(SealRequiredError);
  });
});

describe("no env fallback", () => {
  it("a legacy SOCIAL_VAULT_KEY blob is never opened for use, even with the key in env", async () => {
    const legacy = legacyEncryptForTests("legacy-token");
    const key = await openPrivateKey(created.dek, created.seal, OWNER);
    unlockOwner(OWNER, key, 3600);
    const err = await decryptSecret(legacy, { ownerId: OWNER, field: "enc_access_token" }).catch((e) => e);
    expect(isLockedError(err)).toBe(true);
    expect(err.reason).toBe("legacy");
  });

  it("a sealed operator key is never replaced by the env value while locked", async () => {
    vi.stubEnv("COINPAY_API_KEY", "env-value");
    const enc = await encryptSecret("sealed-value", { ownerId: OWNER, field: "operator.COINPAY_API_KEY" });
    setOperatorRowLoaderForTests(async () => ({ name: "COINPAY_API_KEY", owner_id: OWNER, enc_value: enc }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getOperatorSecret("COINPAY_API_KEY")).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("operator keys locked"))).toBe(true);
    unlockOwner(OWNER, await openPrivateKey(created.dek, created.seal, OWNER), 3600);
    expect(await getOperatorSecret("COINPAY_API_KEY")).toBe("sealed-value");
    spy.mockRestore();
  });

  it("OPERATOR_ENV_FALLBACK=off ignores an unsealed env operator key", async () => {
    vi.stubEnv("X402_PRIVATE_KEY", "0xabc");
    setOperatorRowLoaderForTests(async () => null);
    expect(await getOperatorSecret("X402_PRIVATE_KEY")).toBe("0xabc");
    vi.stubEnv("OPERATOR_ENV_FALLBACK", "off");
    expect(await getOperatorSecret("X402_PRIVATE_KEY")).toBeNull();
  });
});

describe("migration", () => {
  it("re-seals v1 blobs and plaintext columns, NULLs the plaintext, skips v2", async () => {
    const already = await sealToPublicKey(created.seal.public_key, "v2 already", OWNER, "enc_refresh_token");
    const row = { id: "a", enc_access_token: legacyEncryptForTests("old-token"), enc_refresh_token: already };
    const { patch, failed } = await resealRow(row, SP_ACCOUNT_COLUMNS, OWNER, created.seal.public_key, legacyDecryptForMigration);
    expect(failed).toBe(0);
    expect(Object.keys(patch!)).toEqual(["enc_access_token"]);
    const key = await openPrivateKey(created.dek, created.seal, OWNER);
    expect(await openWithPrivateKey(key, patch!.enc_access_token!, OWNER, "enc_access_token")).toBe("old-token");

    const cfg = { id: "c", smtp_pass: "plain-pass", enc_smtp_pass: null };
    const r2 = await resealRow(cfg, OUTREACH_CONFIG_COLUMNS, OWNER, created.seal.public_key, legacyDecryptForMigration, OUTREACH_PLAINTEXT);
    expect(r2.patch!.smtp_pass).toBeNull();
    expect(await openWithPrivateKey(key, r2.patch!.enc_smtp_pass!, OWNER, "enc_smtp_pass")).toBe("plain-pass");
  });

  it("LEGACY_KEY_MIGRATION=off leaves v1 blobs untouched (no data loss) and refuses to open them", async () => {
    vi.stubEnv("LEGACY_KEY_MIGRATION", "off");
    const v1 = legacyEncryptForTests("old");
    const { patch } = await resealRow({ id: "a", enc_access_token: v1 }, SP_ACCOUNT_COLUMNS, OWNER, created.seal.public_key, null);
    expect(patch).toBeNull();
    expect(() => legacyDecryptForMigration(v1)).toThrow(/off/);
  });

  it("a corrupt legacy blob is counted as failed and left in place", async () => {
    const { patch, failed } = await resealRow({ id: "a", enc_access_token: Buffer.from("not-a-blob").toString("base64") }, SP_ACCOUNT_COLUMNS, OWNER, created.seal.public_key, legacyDecryptForMigration);
    expect(patch).toBeNull();
    expect(failed).toBe(1);
  });
});
