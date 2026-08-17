"use client";

import { useState, useTransition } from "react";
import { setCareersEnabled } from "@/app/actions/careers";

interface CareersToggleProps {
  projectId: string;
  initialEnabled: boolean;
}

export function CareersToggle({ projectId, initialEnabled }: CareersToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip() {
    const next = !enabled;
    setError(null);
    startTransition(async () => {
      const res = await setCareersEnabled({ projectId, enabled: next });
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
        {pending ? "…" : enabled ? "Unload careers widget" : "Load careers widget"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
