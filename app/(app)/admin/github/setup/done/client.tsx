"use client";

import { useEffect, useState } from "react";

interface Secrets {
  app_id?: string;
  slug?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  pem?: string;
  html_url?: string;
  owner?: string;
}

export function SetupDoneClient() {
  const [secrets, setSecrets] = useState<Secrets | null>(null);

  useEffect(() => {
    const frag = window.location.hash.replace(/^#/, "");
    if (!frag) return;
    const params = new URLSearchParams(frag);
    const obj: Secrets = {};
    for (const [k, v] of params.entries()) {
      (obj as Record<string, string>)[k] = v;
    }
    setSecrets(obj);
    // Don't strip the hash — admin might refresh while copying. They can
    // navigate away when done; nothing is persisted server-side.
  }, []);

  if (!secrets) {
    return (
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        Loading values…
      </p>
    );
  }

  const envBlock = [
    `GITHUB_APP_ID=${secrets.app_id ?? ""}`,
    `GITHUB_APP_SLUG=${secrets.slug ?? ""}`,
    `GITHUB_APP_CLIENT_ID=${secrets.client_id ?? ""}`,
    `GITHUB_APP_CLIENT_SECRET=${secrets.client_secret ?? ""}`,
    secrets.webhook_secret
      ? `GITHUB_APP_WEBHOOK_SECRET=${secrets.webhook_secret}`
      : "# GITHUB_APP_WEBHOOK_SECRET= (none set; safe to leave unset for now)",
    "GITHUB_APP_PRIVATE_KEY=" + JSON.stringify(secrets.pem ?? ""),
  ].join("\n");

  // org-owned apps live at /organizations/<owner>/settings/apps/<slug>;
  // personal apps live at /settings/apps/<slug>. The owner field tells
  // us which to use.
  const ownerLogin = secrets.owner ?? "";
  const isOrgOwned =
    !!ownerLogin && !!secrets.html_url && /\/apps\//.test(secrets.html_url ?? "");
  const manageUrl = isOrgOwned
    ? `https://github.com/organizations/${ownerLogin}/settings/apps/${secrets.slug ?? ""}`
    : `https://github.com/settings/apps/${secrets.slug ?? ""}`;
  const installUrl = secrets.slug
    ? `https://github.com/apps/${secrets.slug}/installations/new`
    : null;

  return (
    <div className="mt-8 space-y-6">
      <section className="card p-4">
        <h2 className="text-lg font-semibold">
          Paste into Railway → Variables
        </h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          The private key is shell-escaped so newlines survive a paste; Railway
          accepts the quoted form verbatim.
        </p>
        <pre className="mt-3 overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs leading-relaxed">
          {envBlock}
        </pre>
        <button
          type="button"
          className="btn btn-secondary mt-3 text-sm"
          onClick={() => navigator.clipboard.writeText(envBlock).catch(() => {})}
        >
          Copy to clipboard
        </button>
      </section>

      <section className="card p-4">
        <h2 className="text-lg font-semibold">Next steps</h2>
        <ol className="mt-3 list-decimal pl-5 text-sm leading-relaxed">
          <li>
            Set the variables above on Railway → CrawlProof app service.
            Set <code>GITHUB_APP_ID</code>,{" "}
            <code>GITHUB_APP_SLUG</code>, and{" "}
            <code>GITHUB_APP_PRIVATE_KEY</code> on the worker service too.
          </li>
          <li>Redeploy (the app reads env at boot).</li>
          <li>
            Optional — open the App on GitHub to confirm the values:{" "}
            <a className="underline" href={manageUrl} target="_blank" rel="noreferrer">
              Manage on GitHub →
            </a>
          </li>
          {installUrl && (
            <li>
              Test by installing on a sandbox repo:{" "}
              <a
                className="underline"
                href={installUrl}
                target="_blank"
                rel="noreferrer"
              >
                Install App →
              </a>
              . End users do the same from their{" "}
              <a className="underline" href="/settings/integrations/github">
                personal GitHub settings page
              </a>
              .
            </li>
          )}
        </ol>
      </section>

      <p className="text-xs text-[var(--color-muted)]">
        Owner: <code>{secrets.owner}</code>. These values are only in this
        page&apos;s URL fragment — close the tab or navigate away to wipe
        them from memory.
      </p>
    </div>
  );
}
