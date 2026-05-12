"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAuditForProject } from "@/app/actions/runAudit";

export function RunAuditButton({
  projectId,
  url,
}: {
  projectId: string;
  url: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      className="btn btn-primary"
      disabled={pending}
      onClick={() => {
        start(async () => {
          const res = await runAuditForProject({ projectId, url });
          if (res.ok) router.push(`/audits/${res.id}`);
        });
      }}
    >
      {pending ? "Starting…" : "Run audit"}
    </button>
  );
}
