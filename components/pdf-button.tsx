"use client";

import { useState } from "react";

export function PdfButton({ auditId }: { auditId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <a
      className="btn"
      href={`/api/audits/${auditId}/pdf`}
      onClick={() => {
        setBusy(true);
        setTimeout(() => setBusy(false), 3000);
      }}
    >
      {busy ? "Preparing PDF…" : "Download PDF"}
    </a>
  );
}
