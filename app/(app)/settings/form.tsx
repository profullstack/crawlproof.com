"use client";

import { useState, useTransition } from "react";
import { saveSettings } from "@/app/actions/settings";

type Cadence = "off" | "weekly" | "monthly";

export function SettingsForm({
  displayName,
  retainRawHtml,
  perfReportCadence,
  timezone,
  commonTimezones,
  allTimezones,
}: {
  displayName: string;
  retainRawHtml: boolean;
  perfReportCadence: Cadence;
  timezone: string;
  commonTimezones: string[];
  allTimezones: string[];
}) {
  const [name, setName] = useState(displayName);
  const [retain, setRetain] = useState(retainRawHtml);
  const [cadence, setCadence] = useState<Cadence>(perfReportCadence);
  const [tz, setTz] = useState(timezone);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="card space-y-5 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        setError(null);
        start(async () => {
          const r = await saveSettings({
            displayName: name,
            retainRawHtml: retain,
            perfReportCadence: cadence,
            timezone: tz,
          });
          if (r.ok) setSaved(true);
          else setError(r.error ?? "Could not save.");
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

      <fieldset className="space-y-3 border-t border-[var(--color-border)] pt-4">
        <legend className="text-sm font-semibold">Email reports</legend>
        <p className="text-xs text-[var(--color-muted)]">
          A combined digest of your audit scores and Autoblog activity.
          Sent on Monday 09:00 (weekly) or the 1st of the month at 09:00
          (monthly), in the timezone below.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium">Cadence</label>
            <select
              className="input mt-1"
              value={cadence}
              onChange={(e) => setCadence(e.target.value as Cadence)}
            >
              <option value="off">Off — no email reports</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium">Timezone</label>
            <select
              className="input mt-1"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              disabled={cadence === "off"}
            >
              <optgroup label="Common">
                {commonTimezones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </optgroup>
              <optgroup label="All">
                {allTimezones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
      </fieldset>

      {saved && <p className="text-sm text-[var(--color-pass)]">Saved.</p>}
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
