// "Sign in with CoinPay": a plain link to the start route (a full navigation,
// so the PKCE cookie and the 302 to CoinPay happen server side).
export function CoinpaySignInButton({ next, label = "Sign in with CoinPay" }: { next?: string; label?: string }) {
  const href = `/api/v1/coinpay/oauth/start?mode=login${next ? `&next=${encodeURIComponent(next)}` : ""}`;
  return (
    <>
      <a href={href} className="btn btn-primary w-full text-center" data-testid="coinpay-signin">
        {label}
      </a>
      <div className="flex items-center gap-3 text-sm text-[var(--color-muted)]">
        <div className="h-px flex-1 bg-[var(--color-border)]" />
        or
        <div className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
    </>
  );
}
