"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  pausePromoteList,
  resumePromoteList,
  deletePromoteList,
  postNow,
} from "@/app/actions/promote";

export function PromoteListActions({
  id,
  status,
  showEdit = true,
}: {
  id: string;
  status: string;
  showEdit?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const handlePause = () =>
    start(async () => {
      await pausePromoteList(id);
      router.refresh();
    });

  const handleResume = () =>
    start(async () => {
      await resumePromoteList(id);
      router.refresh();
    });

  const handleDelete = () => {
    if (!confirm("Delete this promote list and all its posts?")) return;
    start(async () => {
      await deletePromoteList(id);
      router.refresh();
    });
  };

  const handlePostNow = () =>
    start(async () => {
      await postNow(id);
      router.refresh();
    });

  return (
    <div className="flex items-center gap-2">
      {status === "running" ? (
        <button onClick={handlePause} disabled={pending} className="btn text-sm">
          Pause
        </button>
      ) : status === "paused" ? (
        <button onClick={handleResume} disabled={pending} className="btn text-sm">
          Resume
        </button>
      ) : null}
      <button onClick={handlePostNow} disabled={pending} className="btn text-sm">
        Post now
      </button>
      {showEdit && (
        <Link href={`/promote/${id}`} className="btn text-sm">
          Edit
        </Link>
      )}
      <button onClick={handleDelete} disabled={pending} className="btn text-sm text-[var(--color-fail)]">
        Delete
      </button>
    </div>
  );
}
