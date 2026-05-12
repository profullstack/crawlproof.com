export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-extrabold">Privacy</h1>
      <div className="prose mt-6 text-[var(--color-muted)]">
        <p>
          We store the bare minimum required to deliver the service: your email,
          your audit history, and your billing identifiers. Raw HTML captured
          during a run is stored privately and is only accessible to you; you can
          turn off raw HTML retention in Settings.
        </p>
        <p className="mt-3">
          Standard data export and account-delete flows are available on request
          at <a className="underline" href="mailto:privacy@crawlproof.com">privacy@crawlproof.com</a>.
        </p>
      </div>
    </main>
  );
}
