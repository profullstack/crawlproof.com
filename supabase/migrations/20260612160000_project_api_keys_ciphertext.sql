-- Recoverable Audience ingest keys: store the key AES-256-GCM-encrypted
-- (lib/sp/vault.ts, SOCIAL_VAULT_KEY) alongside the verification hash so
-- owners can re-reveal a key instead of the old show-once flow.
-- Keys minted before this column exists stay null = not revealable.

alter table public.project_api_keys
  add column if not exists key_ciphertext text;
