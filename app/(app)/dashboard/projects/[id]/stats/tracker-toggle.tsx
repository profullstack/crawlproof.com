"use client";

import { useState, useTransition } from "react";
import { setTrackerEnabled } from "@/app/actions/projects";

interface TrackerToggleProps {
  projectId: string;
  initialEnabled: boolean;
}

export function TrackerToggle({ projectId, initialEnabled }: TrackerToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip() {
    const next = !enabled;
    setError(null);
    startTransition(async () => {
      const res = await setTrackerEnabled({ projectId, enabled: next });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEnabled(res.enabled);
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={flip}
        disabled={pending}
        className={`btn ${enabled ? "btn-secondary" : "btn-primary"}`}
      >
        {pending ? "…" : enabled ? "Disable tracker" : "Enable tracker"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
