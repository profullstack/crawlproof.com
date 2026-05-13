-- Track whether we've already mailed a receipt PDF for a completed credit
-- purchase. The CoinPay webhook may be retried after we've already credited
-- the user; we don't want to send the receipt twice.
alter table public.credit_purchases
  add column if not exists receipt_emailed_at timestamptz;
