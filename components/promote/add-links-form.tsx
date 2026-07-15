"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addLinksToList } from "@/app/actions/promote";

export function AddLinksForm({ listId }: { listId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [links, setLinks] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    start(async () => {
      const result = await addLinksToList({ listId, links });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinks("");
      setNotice(`Added ${result.added} link${result.added !== 1 ? "s" : ""}.`);
      router.refresh();
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {error && (
        <p className="text-sm text-[var(--color-fail)]">{error}</p>
      )}
      {notice && (
        <p className="text-sm text-[var(--color-pass)]">{notice}</p>
      )}
      <textarea
        value={links}
        onChange={(e) => setLinks(e.target.value)}
        placeholder="Paste more URLs to add..."
        rows={3}
        className="input w-full font-mono text-sm"
      />
      <button type="submit" disabled={pending} className="btn text-sm">
        {pending ? "Adding..." : "Add links"}
      </button>
    </form>
  );
}
