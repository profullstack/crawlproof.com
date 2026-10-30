"use client";

import { useState, useTransition } from "react";
import { sendSurveyInvitation } from "@/app/actions/surveys";

export function PublicInviteForm({ slug, siteName }: { slug: string; siteName: string }) {
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailConsent, setEmailConsent] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const form = new FormData(event.currentTarget);
    const website = String(form.get("website") ?? "");
    start(async () => {
      const result = await sendSurveyInvitation({ slug, email, phone, emailConsent, smsConsent, website });
      setFailed(!result.ok);
      setMessage(result.ok
        ? result.channel === "none" ? "Thanks." : `The survey invitation was sent by ${result.channel}. Check your inbox or messages.`
        : result.error);
      if (result.ok) { setEmail(""); setPhone(""); setEmailConsent(false); setSmsConsent(false); }
    });
  }

  return <form onSubmit={submit} className="space-y-4">
    <label className="block text-sm font-medium">Email address
      <input type="email" autoComplete="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} className="input mt-1 w-full" placeholder="you@example.com" />
    </label>
    <label className="block text-sm font-medium">Phone number
      <input type="tel" autoComplete="tel" maxLength={24} value={phone} onChange={(event) => setPhone(event.target.value)} className="input mt-1 w-full" placeholder="+1 555 010 0123" />
    </label>
    <div className="space-y-3 rounded border border-[var(--color-border)] p-4 text-sm">
      <p className="font-medium">Choose where to receive one message with this survey. Consent is not required to buy anything.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={smsConsent} onChange={(event) => setSmsConsent(event.target.checked)} className="mt-1" /><span>{siteName} may send me one survey text at the number above. Message and data rates may apply. Reply STOP to opt out or HELP for help.</span></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={emailConsent} onChange={(event) => setEmailConsent(event.target.checked)} className="mt-1" /><span>Email me one survey invitation at the address above. This can also be used if my text cannot be delivered.</span></label>
    </div>
    <input aria-hidden="true" autoComplete="off" tabIndex={-1} name="website" className="absolute -left-[10000px] h-px w-px overflow-hidden" />
    {message && <p role={failed ? "alert" : "status"} className={`text-sm ${failed ? "text-red-600" : "text-green-700"}`}>{message}</p>}
    <button className="btn btn-primary w-full" disabled={pending}>{pending ? "Sending invitation…" : "Send me the survey"}</button>
  </form>;
}
