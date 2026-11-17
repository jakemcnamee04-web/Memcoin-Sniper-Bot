# Weekly review playbook

Instructions for the scheduled Claude session that reviews the bot every week.
A person approves every change: this review proposes, it never merges.

## Ground rules

- **One focused change per week**, as a pull request against `main`. A small
  change you can defend with this week's numbers beats a large one you can't.
- **Do not tune thresholds or exits.** The nightly tuner already searches
  those. Your job is what the tuner cannot do: add a new check, fix a broken
  one, measure something a filter needs, or fix how data is recorded.
- **Never touch**: `.env` files, keys or wallet code, `MODE` /
  `ENABLE_LIVE_TRADING` / `SOLANA_KEYPAIR_PATH` handling, live-trade
  execution, position sizing, the drawdown limits, or the tuner's safety
  checks (`SAFETY_FILTERS`, the promotion checks in `learning/tuner.ts`).
- Every claim in the pull request cites a number from the reports, with how
  many coins it rests on. Under ~50 coins, say the evidence is thin.
- `pnpm typecheck` and `pnpm test` must pass. New behavior gets a test.

## Steps

1. **Get the data.** Fetch the `reports` branch and read the newest
   `reports/weekly-*.md`, plus the `reports/nightly-*.md` files from the same
   week. If the newest weekly file is more than 8 days old, stop: report
   "no new data — is the server running and pushing reports?" and open nothing.

2. **Check data health first.** In the weekly file's "Data health" section:
   - fewer than ~500 coins in the week, or most recordings ending `no-price` /
     `shutdown`, means the recording itself is the problem (bot off, Jupiter
     budget too small, crashes). Fix or diagnose that before strategy;
   - a "buyable" share far below the coin count means first prices arrive
     late: look at `TRACK_MAX_RPM` and the tracker's lag.

3. **Read the filter table.** A filter is earning its place when the coins it
   fails *die more often and run less often* than the coins it passes.
   - Failed coins run about as often as passed ones and die no more often:
     the filter costs winners without stopping losers. Look for why: is it
     skipping on real coins, or measuring the wrong thing?
   - Passed coins die often: the filter lets losers through. Can it measure
     more (for example funding-graph clustering for bundled launches)?

4. **Read missed winners and worst trades.** Look for a pattern shared by
   several rows: the same failing filter, the same exit reason, the same
   source. One row is an anecdote; five is a pattern.

5. **Pick one change.** Good candidates, roughly in order of value:
   - a filter that does nothing on real coins (`lp-locked` skips every
     non-pump.fun pool; see `FILTER_QUALITY_PLAN.md` §4);
   - a filter that decides without recording its measured number in
     `metadata`, so the tuner can't adjust it; add the number, and teach
     `learning/judge.ts` to re-judge it, with a parity test like those in
     `learning/judge.test.ts`;
   - a new check suggested by the worst trades;
   - a data-recording fix from step 2.

6. **Build it on a branch** named `review/YYYY-MM-DD-<topic>`, with tests.
   Run `pnpm typecheck` and `pnpm test`.

7. **Open the pull request**, titled `Weekly review YYYY-MM-DD: <change>`. The
   body has four short parts: *Evidence* (the numbers and how many coins),
   *Change*, *What should move next week* (which report number, which way), and
   *Risks*. If nothing in the week's data justifies a change, open no pull
   request and say so in your summary. That is a fine outcome.

8. **Finish with a short summary** for the owner: what the data showed in two
   or three sentences, the pull request link if there is one, and anything
   that needs a person (the server looks down, the Jupiter budget is too small).
