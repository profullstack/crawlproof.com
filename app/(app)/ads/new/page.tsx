import Link from "next/link";
import { NewAdForm } from "./form";

export const metadata = { title: "New ad campaign" };

export default function NewAdPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>
      <h1 className="mt-4 text-3xl font-bold">Create an ad</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Drop in a landing-page URL and we auto-design on-brand display ads. Preview,
        tweak the copy and colours, or upload your own logo — then save.
      </p>
      <NewAdForm />
    </div>
  );
}
