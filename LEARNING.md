# The learning loop

The bot improves its own settings on paper, and a weekly Claude review
improves its code. Three loops, each slower than the last:

| Loop | How often | What it is | What it changes |
| --- | --- | --- | --- |
| The bot | every coin | plain code (the existing engine) | nothing: it trades on paper and **records** every coin it judges |
| The tuner | every night | plain code (`apps/engine/src/learning`) | the live **settings**, only when a better version proves itself |
| The review | every week | a scheduled Claude session | the **code**, through a pull request you approve |

Nothing here trades real money. The tuner refuses to change settings outside
`MODE=paper`, and it never touches position size or the loss limits.

## 1. Recording (outcome tracker)

For every coin the filters judge, bought or rejected, the tracker stores:

- what each filter measured (top-holder %, dev rug rate, sell tax, liquidity…)
  and the thresholds in force at the time;
- its price and liquidity for `TRACK_WINDOW_MIN` (default 60) minutes after the
  verdict: every 10 s for the first 5 minutes, every 30 s to 20 minutes, then
  every minute.

A recording ends early when the coin dies (below 5% of its first price), stops
being quoted, or never gets a first price within 30 s (no version could have
bought it; the live trader would not have either).

Prices come from Jupiter in batches of 50 mints per request, within
`TRACK_MAX_RPM` requests a minute (default 20). When there are more coins than
budget, polls run late instead of being dropped, and the stats line shows the
lag. Jupiter's free limit is 60 requests a minute **for everything** (the open
positions poll too), and the keyless `lite-api` is being phased out with falling
limits. A free API key from https://developers.jup.ag goes in `JUPITER_API_KEY`;
then point `JUPITER_PRICE_API` and `JUPITER_QUOTE_API` at `https://api.jup.ag/...`.
If the budget can't keep up, set `TRACK_REJECT_SAMPLE_RATE` below 1 to follow
only a share of rejected coins (bought coins are always followed).

Recordings are kept `TRACK_RETENTION_DAYS` (21) days, about 2 KB per coin: at
10,000 coins a day that is roughly 0.5 GB of database. Each night replays at
most `TUNER_MAX_COINS` (60,000) of them, an even sample above that, which keeps
the tuner under about 200 MB of memory.

## 2. Tuning (every night at `TUNER_HOUR_UTC`, default 08:00 UTC = 3 AM Eastern)

About 20 **versions** of the settings compete. Each is a full set of filter
thresholds, filter on/off switches and exits (stop-loss, take-profit ladder,
trailing stop, time exit). The tuner replays every version over the last
`TUNER_LOOKBACK_DAYS` (14) of recordings with the same costs as the paper
executor: slippage, fees, failed fills, sandwich losses, rug exits.

Then:

1. **Rank** the versions on the older days (the selection window).
2. **Promote** the best one only if it passes every check:
   - it has at least `TUNER_MIN_TRADES` (30) trades;
   - it beats the live version on the selection window;
   - on the last `TUNER_HOLDOUT_DAYS` (3) days, which the ranking never saw, it made money on at least
     `TUNER_MIN_HOLDOUT_TRADES` (10) trades and beat the live version by
     `TUNER_PROMOTE_MARGIN_PCT` (1% of the bankroll);
   - the last promotion was at least `TUNER_PROMOTE_COOLDOWN_DAYS` (2) ago.
3. **Evolve**: retire the weakest `TUNER_CULL` (5) and replace them with slightly
   changed copies of the strongest.

The score is profit **without each version's three best trades**, minus half
its worst drawdown, so one lucky moonshot can't carry a version. Versions bet a
flat share of the starting bankroll in the replay, so early luck doesn't
snowball either.

A promotion writes the winner's filters as the **"Auto-tuned"** preset and its
exits as the dashboard trading settings, and the running bot uses them from
the next coin. If you change the settings by hand on the dashboard, the tuner
notices and makes your settings the live version it has to beat
(`manual-…`). To stop promotions but keep the reports, set
`TUNER_AUTO_PROMOTE=false`.

Safety checks (honeypot, mint authority, freeze authority, LP lock) can never
be switched off by the tuner.

Each run writes `reports/nightly-YYYY-MM-DD.md` (and `.json`) under the engine
folder and sends a short Telegram summary if alerts are set up.

## 3. The weekly review

`pnpm learning:export` writes `reports/weekly-YYYY-MM-DD.md`: the live
version's replayed results, which filters are doing their job, the rejected
coins that went on to double ("missed winners"), and the worst trades.
`pnpm reports:push` publishes the reports folder to the `reports` branch of
your fork.

Every Sunday evening a scheduled Claude session reads that branch, follows
[`REVIEW_PLAYBOOK.md`](REVIEW_PLAYBOOK.md), makes at most one focused code
change with tests, and opens a pull request. **It never merges.** You read the
evidence in the pull request and decide.

## Running it on a server

The bot has to run around the clock, so a laptop that sleeps won't do. Any
small Linux server works (2 GB of RAM is enough).

```bash
# once
git clone https://github.com/<you>/Memcoin-Sniper-Bot && cd Memcoin-Sniper-Bot
pnpm install
cp .env.example .env                   # then fill in keys, Telegram, etc.
ln -s ../../.env apps/engine/.env      # the engine reads .env from its own folder
pnpm docker:up                         # Postgres + Redis
pnpm --filter @sniperbot/engine exec prisma migrate deploy   # creates the learning tables too

# keep the engine and dashboard running (pm2 shown; systemd works too).
# The engine runs from source through tsx: there is no separate build step.
npm i -g pm2
pm2 start "pnpm --filter @sniperbot/engine exec node --import tsx src/index.ts" --name engine
pm2 start "pnpm dev:dashboard" --name dashboard
pm2 save && pm2 startup
```

The dashboard has no login, so never open its ports (3000 and 4000) to the
internet. Reach it through an SSH tunnel from your own computer:

```bash
ssh -L 3000:localhost:3000 -L 4000:localhost:4000 you@your-server
```

then open http://localhost:3000, press **Bot ON**, and **Start** trading.
**The bot comes up OFF after every restart** (a crash, a reboot, a `pm2
restart`), so after one, tunnel in and switch it back on, or the tracker
records nothing.

For the review to see the reports, the server needs push access to your fork
(a deploy key with write access, or a fine-grained token limited to this repo),
plus two cron lines (server time is UTC):

```cron
# nightly report, an hour after the tuner
15 9 * * *  cd ~/Memcoin-Sniper-Bot && pnpm reports:push >> ~/reports-push.log 2>&1
# weekly data, before the Sunday evening review
30 22 * * 0 cd ~/Memcoin-Sniper-Bot && pnpm learning:export && pnpm reports:push >> ~/reports-push.log 2>&1
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm learning:status` | how many coins are recorded, the live version, the last run |
| `pnpm learning:tune` | run tonight's tuner now as a dry run: writes the report, saves nothing |
| `pnpm learning:tune -- --apply` | save the run, the new versions and the retirements |
| `pnpm learning:tune -- --apply --promote` | also switch the live settings if a version qualifies (restart the engine to load them) |
| `pnpm learning:export` | write the weekly review data (`-- --days 14` for two weeks) |
| `pnpm reports:push` | publish the reports folder to the `reports` branch |

## Limits worth knowing

- **Expect nothing for about two weeks.** The tuner needs a few hundred trades
  across the lookback before anything ranks, so the first nights will report
  "keep collecting".
- **The replay is coarser than the live bot.** It sees a price every 10–60 s;
  the live bot polls every 3 s. It errs against each version: take-profits fill
  at their level, not at a higher sampled price, and stops fill at the price
  that crossed them.
- **Paper flatters.** Real fills compete with faster bots, and your own buy
  moves a thin pool. A version that only just wins on paper probably loses live.
- **Synthetic numbers mean nothing.** `SYNTHETIC_FEED=true` exercises the
  whole loop, but its fake launches win far more often than real ones.
- **The tuner can only sharpen an edge; it can't create one.** If after 4–6
  weeks no version makes money on the holdout days, the honest conclusion is
  that this strategy doesn't work, not that the tuner needs more time.
