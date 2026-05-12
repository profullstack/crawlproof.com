import Link from "next/link";
import { NewProjectForm } from "./form";

export const metadata = { title: "New project" };

export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-xl">
      <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
        ← Dashboard
      </Link>
      <h1 className="mt-4 text-3xl font-bold">New project</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Group audits under one project. You can also schedule weekly re-audits on Pro.
      </p>
      <NewProjectForm />
    </div>
  );
}
