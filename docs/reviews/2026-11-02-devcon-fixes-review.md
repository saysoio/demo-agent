# Review: Devcon fixes (game-devcon-fixes)

Reviewer: separate agent, 2026-11-02. Scope: `git diff main..game-devcon-fixes` (f62d257, 2a9646e, bd52133, 29ecccb) on
top of `main` 184ba9b.

## Verdict

**Ship after fixes.** The claim code itself is sound: 128 random bits, only its sha256 is stored, it is never read into
an `Attempt`, so the allowlists in `src/guard/expose.ts` keep it out of the feed, tricks and pot, and nothing logs it.
Nobody can claim another player's win without the code, and a guess cannot tell a missing try from a wrong code. All new
DOM code sets text with `textContent`. The blockers are in the public text: the page now promises real money, and the
rules do not yet say which win gets it, what happens when that winner cannot claim, or how the promise sits next to "No
promises / can stop at any time". One page label ("Simulated") states something the code does not do.

Checks run: `npm test` 139/139 pass, `npx tsc --noEmit` clean (exit 0).

## What holds

- **Code never public.** `claim_hash` is not in `COLS` (`src/store.ts:53`), so `row()` never carries it; `PUBLIC_FIELDS`
  and `TRICK_FIELDS` are allowlists; `/api/admin/claims` sits behind `AdminGate` (`src/server.ts:101`); the only log line
  is the attempt number (`src/server.ts:141`). The test greps the feed for the code and for "claim".
- **No claiming someone else's win.** `store.claim` (`src/store.ts:177-183`) needs the right code before it reveals "not
  a win" or "claimed"; a missing try answers "wrong code". Codes are 32 lowercase hex, enforced by `parseClaim`. One
  claim per try (`attempt_id` primary key, `ON CONFLICT DO NOTHING`), so a second claim cannot overwrite the payout.
- **timingSafeEqual.** Both sides are 64-char sha256 hex, so the lengths match; and since the stored value is a hash of a
  128-bit secret, timing would leak nothing useful anyway. A malformed legacy value would throw and end as a 500, not a
  crash (`src/server.ts:181`).
- **Handle.** `HANDLE` (`src/guard/input.ts:128`) allows letters, digits, space and `@ . _ + : / -` only, after `tidy`,
  80 code points max; `<b>` is rejected and tested. The handle is only ever returned as JSON to the admin.
- **No XSS in new DOM code.** `simulated`, `claimForm`, the tag and the server's error text all go through
  `textContent`; `className` and `dataset` values are constants or numbers. The "View analysis" card reuses `trick()`,
  which is text-only, and passes the full body only inside the feed row that already shows it in full.
- **Migration.** `CREATE TABLE IF NOT EXISTS claims` and a nullable `ALTER TABLE ... ADD COLUMN claim_hash` are both
  metadata-only in SQLite and idempotent; older code still runs on the migrated file (explicit insert column lists).
- **toWei** (`public/game/app.js:241-245`) is string and BigInt only, rejects anything that is not a plain decimal or has
  more than 18 decimals, and is used for ETH only; USDC falls back to plain text. Amounts come from `formatUnits`, so
  they are canonical.
- **CSRF.** The claim needs the code from the sender's tab, so a cross-site post gains nothing.

## Findings

### Must-fix

1. **"First verified winner" is undefined in the cases that matter** (`public/game/rules.html:44-46`,
   `public/game/index.html` lede and rules line, claim form text at `index.html:248`). The rules say a closed tab makes a
   win unclaimable, but not whether the prize then passes to the next winner or is not paid. They do not say whether
   "first" means first win by time (what `store.claims()` sorts by, `src/store.ts:186`) or first valid claim. Wins on the
   production database from before this deploy have no `claim_hash` and can never claim: if `stats.wins` is above zero on
   the live box, someone already "won first" and is now told the $300 goes to the first verified winner. Fix: state
   "the first win after <date and time> that is claimed and verified", what happens to an unclaimed first win, and check
   the live `wins` count before launch.
2. **A money promise under "No promises"** (`public/game/rules.html:67-69`). "The game can change or stop at any time"
   now sits beside a $300 offer with no end date, no deadline to claim and no statement of what happens if the game stops
   before anyone wins or while a win is being verified. Add the prize window (start, end), a claim and verification
   deadline, and that the prize is void if no verified win happens in the window. Have the founder confirm the prize is
   funded and approved, since CLAUDE.md says only the founder moves real funds.
3. **"Simulated, never sent" is not true of the code** (`public/game/index.html:241`, comment at `app.js:197-198`).
   Nothing in this repo simulates the transaction: a blocked or held payment is simply never signed, and the "Unsigned
   transaction" line is assembled in the browser from `toAddr` and `amount` (no nonce, gas or chain id). Unless sayso's
   check really simulates it and the team can point to where, say "Not signed, never sent" and label the line "The
   transfer it asked for", so the public page does not claim a simulation that never ran.

### Should-fix

4. **Claim rate limit shared by a whole network** (`src/server.ts:68,136`). Ten claims an hour per IP key, counted
   before the body is parsed. At Devcon most players share a few NAT addresses, and a win pauses the game publicly, so
   anyone on the venue wifi can spend the ten with junk posts and keep the winner locked out hour after hour. Count only
   failed claims, or key by IP plus try id, or raise the limit; 128-bit codes need no tight limit.
5. **No checksum check on the payout address** (`src/guard/input.ts:134`). Any 40 hex chars pass, so a mistyped
   mixed-case address is accepted and $300 goes nowhere. Use viem's `isAddress` (strict) / `getAddress` and store the
   checksummed form; viem is already a dependency.
6. **A reloaded tab may not show its own win** (`public/game/app.js` `loadFeed`, `followWaiting`). Codes survive a
   reload in sessionStorage, but the claim form only appears on rows the feed happens to load. If the win is not on the
   newest page (vendor invoices keep arriving until the pause lands), the winner sees no form. On load, ask
   `/api/feed?ids=` for the ids in `claimCodes`.
7. **sayso's reason at 1000 characters in the tricks list** (`src/guard/model.ts:30`, `TRICK_FIELDS` in
   `src/guard/expose.ts:32`). The trick card shows `reason` unclipped. If sayso quotes the message back, the tricks list
   shows far more than the 140-character excerpt rule allows, and a 1000-character reason stretches the carousel card.
   Clip `reason` in `publicTrick` (say 300) and keep the full text in the feed.

### Low

8. **"Only this browser tab can claim this win"** (`index.html:248`) and the privacy line (`rules.html:83`): browsers
   copy sessionStorage when a tab is duplicated, so "this tab or a copy of it" is the accurate wording.
9. **Conduct rule vs claim form** (`rules.html:61`): "No real people's private data, yours or anyone else's" now
   contradicts asking a winner for an email or handle. Exempt the claim form.
10. **Payout becomes public** (`rules.html:78`): the handle is team-only, but paying USDC on Base links the payout
    address to sayso's wallet onchain. One clause in the privacy notice covers it.
11. **Handle may look like a URL** (`src/guard/input.ts:128`): `:` and `/` allow `javascript:...`. Harmless while
    `/api/admin/claims` is read as JSON; if an admin page ever renders it as a link, it must not become an `href`.

## Fixes applied (2026-11-02)

- Must-fix 1 and 2: rules define "first" (earliest win by landing time, verified and claimed within 7 days, else the next win), the offer window (from 2 November 2026 until paid or ended on the page; ending never cancels an earlier win; no winner, no payment; earlier wins do not count), a 7-day claim deadline, an email fallback for a closed tab that pays only the address the test ETH reached, and "a win made before it stops still gets the prize terms" under No promises. Live `wins` was 0 on 2 November, so no earlier win exists. Still for the founder: confirm the prize is funded and these terms.
- Must-fix 3: the block now says "Simulated by Sayso, never sent" (sayso's check simulates every transaction it judges on its copy of the chain) and labels the line as the transaction the agent asked the wallet to sign (unsigned).
- Should-fix: a right claim code is never rate-limited; only refused claims count per network. Mixed-case payout addresses must carry a valid checksum and payouts are stored checksummed. The stopped-trick card clips sayso's reason to 300 characters.
- Left: a reloaded tab shows its win only while the row is in the loaded feed pages.
