import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { isPlaceholderEmail, supabaseCoinpayStore } from "@/lib/coinpay-signin";
import { CoinpayDisconnectButton } from "./coinpay-disconnect";

// Settings → CoinPay: connect this account to a CoinPay account (CoinPay is
// the house master account), or disconnect it. Linking only ever happens here,
// while signed in; a CoinPay login never claims an account by its email.
export async function CoinpayCard({ status, error }: { status?: string; error?: string }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const identity = await supabaseCoinpayStore(serviceClient())
    .identityByUser(data.user.id)
    .catch(() => null);
  const onlyWayIn = isPlaceholderEmail(data.user.email);

  return (
    <div className="card p-5" id="coinpay">
      <h2 className="text-lg font-semibold">CoinPay</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Sign in to CrawlProof with your CoinPay account. Your CoinPay account can be used across every Profullstack app.
      </p>
      {status === "connected" && <p className="mt-3 text-sm text-[var(--color-pass)]">CoinPay connected.</p>}
      {error && <p className="mt-3 text-sm text-[var(--color-fail)]">{error}</p>}
      {identity ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            Connected
            {identity.coinpay_email ? (
              <span className="text-[var(--color-muted)]"> as {identity.coinpay_email} (unverified, from CoinPay)</span>
            ) : null}
          </p>
          {onlyWayIn ? (
            <p className="text-xs text-[var(--color-muted)]">This account was created with CoinPay, so it stays connected.</p>
          ) : (
            <CoinpayDisconnectButton />
          )}
        </div>
      ) : (
        <a href="/api/v1/coinpay/oauth/start?mode=connect&next=%2Fdashboard%2Fsettings" className="btn btn-secondary mt-3 inline-block text-sm">
          Connect CoinPay
        </a>
      )}
    </div>
  );
}
