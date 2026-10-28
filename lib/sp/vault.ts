// Compatibility path: secrets are now sealed per owner (lib/sealed/vault.ts).
// The old single-key implementation lives on only as the migration reader in
// lib/sealed/legacy.ts.
export {
  encryptSecret,
  decryptSecret,
  SecretsLockedError,
  SealRequiredError,
  isLockedError,
  orgOwnerId,
  canOpen,
  hasSeal as hasSealFor,
  LOCKED_MESSAGE,
  SEAL_REQUIRED_MESSAGE,
  type SecretCtx,
} from "@/lib/sealed/vault";
