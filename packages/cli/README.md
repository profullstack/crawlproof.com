# @profullstack/crawlproof

What the fleet costs and what it returns, in a terminal.

```
npm install -g @profullstack/crawlproof
crawlproof dashboard
```

Five live screens over three feeds that are not otherwise in the same place:
CrawlProof's tracker for who arrived, its ad network for what was delivered,
and CoinPay for what the bank actually did.

| Screen | Answers |
| --- | --- |
| ROI | Monthly burn against revenue, cost per reader, break-even |
| Traffic | Every site on the account, ranked, with its score and its share of the cost — open one for its own numbers |
| Ads | Delivery as advertiser and as publisher, and ad-driven arrivals |
| Money | Earnings, bank position, invoices, income vs spending by month |
| Spend | Who we pay, largest first, and burn by category |

`1`–`5` or Tab switches screens, `w` cycles the window, `b` cycles humans /
all / bots, `r` refreshes, `?` explains the arithmetic, `q` quits.

## One property at a time

On **Traffic**, `↑`/`↓` pick a site and `Enter` — or a click on the row — opens
it. That screen is only that domain: its pageviews, visits, humans against
bots, AI referrals and where they arrived from; the burn prorated onto it by
both denominators; its ad earnings and spend, joined by project and by where
the campaign points; and the commission, when there is exactly one merchant
business to attribute it to. `Esc`, `←` or `2` comes back to the list.

## The risk-to-viral score

Every property gets a score out of 100, shown as a column on the list and taken
apart on the domain screen. It is arithmetic over numbers already on the screen,
not a model:

```
score = 100 × viral × (1 − risk/2)

viral = momentum .40 + discovery .30 + humanity .20 + money .10
risk  = volatility .40 + concentration .30 + bot dependence .20 + unmonetised .10
```

| Component | What it is |
| --- | --- |
| momentum | Human visits in the recent half of the window against the earlier half. Flat scores 0.5, doubling scores 1. |
| discovery | Share of arrivals through search, social, an AI assistant, an ad or another site's link, rather than direct. |
| humanity | Humans over humans plus bots, from an unfiltered read — never from a filtered one, whose bot column is zero by construction. |
| money | Revenue per 1,000 human visits against a $2 target. |
| volatility | Coefficient of variation of the human series. Scale-free, so a small site is not penalised for being small. |
| concentration | The largest single arrival channel's share. An even spread is not a risk; one channel being everything is. |
| bot dependence | 1 − humanity. |
| unmonetised | 1 − money. |

A component with no data behind it is **dropped and its weight redistributed**,
never counted as a zero, and the domain screen prints the raw figure under each
one. A trailing `~` marks fewer than 25 human visits in the window — too small a
sample to lean on. A site whose stats call failed is not scored at all.

`s` cycles the order: score, visitors, pageviews. `--sort=score` starts there.
`--json` carries `.sites[].score` with every component, for a script.

## Two rules the numbers keep

**Self-deal is not revenue.** Where an account advertises on its own slots, ad
spend and ad earnings are one dollar moving between two pockets. They are shown
under *Internal* and counted as neither cost nor revenue.

**Personal money is not business cost.** A bank feed carries groceries next to
servers, so cost is the business scope only — joined from each transaction's
account to that account's scope.

Everything is normalised to a monthly rate and then prorated onto the traffic
window, because burn is a rate: the traffic side can be asked for an hour while
the bank side only answers in weeks.

The dashboard also reports what it cannot know. A site that did not answer is
missing rather than zero. A vendor list built from one page of a longer ledger
says so. A fleet whose visits run far above its pageviews — a "visitor" is any
non-crawler hit, which on a site with a machine-readable endpoint runs orders of
magnitude above pages anyone read — says that next to the number, and offers the
per-pageview figure instead.

## Commands

```
crawlproof dashboard [--range=1h|4h|1d|1w|1m] [--who=humans|bots|all]
                     [--interval=60] [--sites=a.com,b.com] [--concurrency=8]
                     [--sort=score|visitors|pageviews] [--no-coinpay] [--json]
crawlproof stats [site] [--range=1d] [--who=humans] [--json]
```

`--json` prints the same snapshot the screens render, for a script or a box
with no terminal. Aliases for `dashboard`: `roi`, `tui`.

## Auth

| | |
| --- | --- |
| `CRAWLPROOF_TOKEN` | API token (`crp_…`) from Social → API tokens. Also read from the `token` field of `~/.crawlproof.json`. `--token` wins. |
| `CRAWLPROOF_SITE_URL` | API base, default `https://crawlproof.com`. |
| `COINPAY_SESSION_TOKEN` | CoinPay merchant JWT for the money screens. Defaults to `jwtToken` in `~/.coinpay.json`, which `coinpay auth login` writes. |

Without a CoinPay session the traffic and ads screens still work and the money
panels say what is missing, rather than showing zero.

Needs Node 22.6 or newer, and a terminal for the dashboard. `--json` needs
neither.

## License

MIT
