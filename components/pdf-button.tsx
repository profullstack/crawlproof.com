"use client";

import { useState } from "react";

export function PdfButton({
  auditId,
  disabled,
}: {
  auditId: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <a
      className={`btn ${disabled ? "opacity-50" : ""}`}
      aria-disabled={disabled}
      href={disabled ? undefined : `/api/audits/${auditId}/pdf`}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          alert("PDF export is a Pro feature.");
          return;
        }
        setBusy(true);
        setTimeout(() => setBusy(false), 3000);
      }}
    >
      {busy ? "Preparing PDF…" : disabled ? "PDF (Pro)" : "Download PDF"}
    </a>
  );
}
