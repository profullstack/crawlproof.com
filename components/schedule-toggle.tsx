"use client";

import { useState, useTransition } from "react";
import { updateSchedule } from "@/app/actions/createProject";

export function ScheduleToggle({
  projectId,
  current,
}: {
  projectId: string;
  current: "off" | "daily" | "weekly" | "monthly";
}) {
  const [value, setValue] = useState(current);
  const [pending, start] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
      Schedule
      <select
        className="input w-auto py-1"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as typeof value;
          setValue(next);
          start(async () => {
            await updateSchedule({ projectId, schedule: next });
          });
        }}
      >
        <option value="off">Off</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
    </label>
  );
}
