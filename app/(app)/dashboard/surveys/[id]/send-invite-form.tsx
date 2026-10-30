"use client";

import { useState, useTransition } from "react";
import { sendSurveyInvitation } from "@/app/actions/surveys";

export function SurveyInviteForm({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailConsent, setEmailConsent] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    start(async () => {
      const result = await sendSurveyInvitation({ slug, email, phone, emailConsent, smsConsent });
      setError(!result.ok);
      if (!result.ok) { setMessage(result.error); return; }
      if (result.channel === "none") return;
      setMessage(`Invitation sent by ${result.channel}.`);
      setEmail(""); setPhone(""); setEmailConsent(false); setSmsConsent(false);
    });
  }

  return <form onSubmit={submit} className="mt-4 space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm font-medium">Email
        <input type="email" autoComplete="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} className="input mt-1 w-full" placeholder="name@example.com" />
      </label>
      <label className="block text-sm font-medium">Phone
        <input type="tel" autoComplete="tel" maxLength={24} value={phone} onChange={(event) => setPhone(event.target.value)} className="input mt-1 w-full" placeholder="+1 555 010 0123" />
      </label>
    </div>
    <div className="space-y-2 rounded border border-[var(--color-border)] p-3 text-sm">
      <p className="font-medium">Confirm the recipient agreed to each channel you use.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} className="mt-1" /><span>They agreed to one survey text from the site shown above at this number. Message and data rates may apply. Reply STOP to opt out or HELP for help.</span></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={emailConsent} onChange={(event) => setEmailConsent(event.target.checked)} className="mt-1" /><span>They agreed to receive this survey by email. Email is used as a fallback only if SMS fails.</span></label>
    </div>
    {message && <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-red-600" : "text-green-700"}`}>{message}</p>}
    <button className="btn btn-primary" disabled={pending}>{pending ? "Sending…" : "Send invitation"}</button>
    <p className="text-xs text-[var(--color-muted)]">One invitation costs 1 credit. A failed send is refunded. SMS includes STOP and HELP instructions.</p>
  </form>;
}
