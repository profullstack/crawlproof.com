-- Store the Bluesky app password (AES-GCM encrypted) so the worker can
-- silently re-authenticate when the access JWT expires — Bluesky has no
-- refresh-token rotation path in this app. Also enables reveal/copy in the UI.
alter table sp_account
  add column if not exists enc_app_password text;
