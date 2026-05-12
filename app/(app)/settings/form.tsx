"use client";

import { useState, useTransition } from "react";
import { saveSettings } from "@/app/actions/settings";

export function SettingsForm({
  displayName,
  retainRawHtml,
}: {
  displayName: string;
  retainRawHtml: boolean;
}) {
  const [name, setName] = useState(displayName);
  const [retain, setRetain] = useState(retainRawHtml);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  return (
    <form
      className="card space-y-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        start(async () => {
          await saveSettings({ displayName: name, retainRawHtml: retain });
          setSaved(true);
        });
      }}
    >
      <div>
        <label className="block text-sm font-medium">Display name</label>
        <input
          className="input mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={retain}
          onChange={(e) => setRetain(e.target.checked)}
        />
        Retain raw HTML from audits (uncheck to keep only structured findings)
      </label>
      {saved && <p className="text-sm text-[var(--color-pass)]">Saved.</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
