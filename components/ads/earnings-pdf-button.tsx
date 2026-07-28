"use client";

import { useState } from "react";

export function EarningsPdfButton({ days = 30 }: { days?: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <a
      className="btn"
      href={`/api/ads/earnings/pdf?days=${days}`}
      onClick={() => {
        setBusy(true);
        setTimeout(() => setBusy(false), 4000);
      }}
    >
      {busy ? "Preparing PDF…" : "Download PDF report"}
    </a>
  );
}
