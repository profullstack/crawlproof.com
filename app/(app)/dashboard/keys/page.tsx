import { KeysPanel } from "./keys-panel";

export const metadata = { title: "Keys" };
export const dynamic = "force-dynamic";

export default function KeysPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Keys</h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
          Your connected-account tokens, app passwords, bot tokens and mailbox passwords are sealed under a passphrase
          only you know. CrawlProof keeps no key that can open them. Scheduled posts and outreach run only while you are
          unlocked; when you are locked (after a restart, when your unlock time runs out, or when you press Lock) that
          work waits and nothing is lost.
        </p>
      </div>
      <KeysPanel />
    </div>
  );
}
