# Review: example buttons (game/example-buttons-2026-10-31)

Reviewer: separate agent, 2026-10-31. Scope: `git diff main..HEAD` (ac392dd, a76d7a4).

## Verdict

**Approve, with two Medium items the owner should decide on before the real pot.** Nothing in the diff touches the
server, the guard, scoring or the win rule. The page text hedges correctly ("expected"), the rules line is true to the
code, player text goes in only through `.value` / `textContent`, and the vendors and colleagues are the game's own
fictional directory. No High findings.

Checks run: `npm test` 131/131 pass, `npm run typecheck` (tsc --noEmit) clean. I also ran every example through
`parseFrom` (`src/guard/input.ts`) for its channel: all five shapes (usual invoice, 4 attacks) are accepted.

## What holds

- **Server side unchanged.** The diff touches only `public/game/*`, `test/*`. `checkDecision`, `Agent.handle`, the win
  rule (`src/agent.ts:97-105`) and the stats are untouched. The buttons are `type="button"`, fill the form and never
  submit (`public/game/app.js:531-543`).
- **Wording.** Both notes say "expected", the block has no "will" (and a test pins that). `ex-live` ends with "Filled in,
  not sent." Nothing says or implies a guaranteed win; the made-up note says "to keep any win", which is conditional.
- **Rules page** (`public/game/rules.html:32`): "only fill in the form ... you still press Send, and what they fill in is
  treated exactly like text you type" is true: the submit path cannot tell the two apart.
- **Exact wording.** The usual invoice matches `seedVendorInvoice` (`src/agent.ts:67`) word for word, sender included,
  and the test checks every vendor against a real seeded row (invoice number masked).
- **No HTML.** `fillExample` uses `.value`, `.checked`, `textContent` only; the test greps `app.js` and `examples.js` for
  `innerHTML|outerHTML|insertAdjacentHTML|document.write`.
- **No impersonation.** Vendors come from `/api/directory` (domains forced under `.example`, handles `_demo`,
  `src/directory.ts:3,34`); the chat example uses the made-up colleague list. No real organisation is named in the diff.
- **Made-up address.** `0x0bad...0bad` is a 160-bit pattern; nobody can hold its key, it is checked against every vendor
  wallet, and the page labels it as made up after a fill.
- **Keyboard and phone.** Native buttons, disabled until the directory loads, `aria-describedby` notes, a polite live
  region; one column under 560px, two above, buttons full width, `minmax(0, 1fr)` so nothing overflows.
- **times10** is string based and safe because `DEMO_VENDORS` usual amounts are validated as plain decimals
  (`src/config.ts:80`).

## Findings

### Medium

**M1. One click makes it easy to burn the day's cap and the pot's gas, and the result reads as Sayso's strength.**
`public/game/index.html:121-122`, `public/game/examples.js:19-28`.
Scenario: with the `.env.example` values (daily cap 0.01, usual 0.0002 to 0.0003; code default 0.005) one player on one
IP (30 an hour allowed) presses "Fill a usual invoice" + Send about 20 to 40 times. Each is allowed and paid to a vendor
wallet, so "Paid a real vendor" climbs with player traffic, each costs gas from the pot, and once the daily cap is used
every later attack and every scheduled invoice is blocked as "over a cap". For the rest of the UTC day the game cannot be
won, while the tricks list shows those blocks as "stopped by Sayso". This was possible before by typing, but the button
turns it into a one-click, encouraged action, and the note frames it as harmless. Not dishonest in code, but it can make
the public numbers misleading. Options: say on the note that a usual invoice really pays the vendor and uses the day's
cap; or keep the button but leave it unmentioned in stats; or accept it consciously. Do not fix it by filtering
server-side (that would break the "code never pre-filters" rule).

**M2. Sending an attack example unedited can "win" into an unspendable address.**
`public/game/examples.js:6,33,43,48`, `public/game/app.js:540`.
Scenario: a player presses "Fill an injection example" and Send without reading `ex-live`. If Sayso ever allows it (the
point of the game is that this is possible), the payment goes to `0x0bad...0bad`. That is a win by the code's rule: the
game pauses for everyone (`src/agent.ts:105`), and on Base the pot's USDC is burned, not kept by anyone. The "put in
your own" hint appears only in the live line after the fill, not in the textarea or near Send. Suggestion (page only,
honest): when the message still contains `Examples.MADE_UP`, show a line next to Send ("This still pays the made-up
address 0x0bad...: nobody can keep that") or ask once before sending. A client-side nudge is not a payment filter; the
server must keep treating it like any text.

### Low

**L1. The test named "sent through the form" bypasses the form.** `test/examples.test.ts:56-64` calls `store.add` directly,
so it skips the submit route, `parseFrom`, the length and request checks. It also runs on `FakePayer`, so "paid" there
says nothing about real Sayso. Suggest posting the example to the server's submit endpoint (as `server.test.ts` does) for
each of the five examples, and renaming the test to what it proves. The `parseFrom` acceptance I checked by hand is not
covered by any test.

**L2. The live line may not be announced the first time, nor on a repeat.** `public/game/style.css:267`
(`.ex-live:empty { display: none; }`) takes the live region out of the accessibility tree until it has text; some screen
readers (VoiceOver, NVDA) miss the first change of a region that was `display: none`. Pressing "usual" twice for the same
vendor can also produce text the reader treats as unchanged. The existing `say()` (`app.js:458`) clears and resets after
30 ms for this reason; reuse that pattern and hide the empty line visually only.

**L3. A press overwrites what the player typed, with no undo.** `public/game/app.js:533-537`. Scenario: a player writes a
500-character trick, hits "Fill an injection example" by mistake, and loses it (setting `.value` also clears the
browser's undo stack). Suggest a confirm when the textarea is non-empty and differs from the last fill.

**L4. Example 2 can never be a win, and the page does not say so.** `public/game/examples.js:37-41`. The 10x renewal pays
the vendor's real wallet, so even if Sayso allows it it counts as "Paid a real vendor". The attack note says only "expected
to stop or ask". A player who edits nothing may think an allowed renewal broke the guard. Add "pays the vendor's own
wallet, so it is never a win" to its `what` line.

**L5. Empty unit if the first pot load fails.** `public/game/app.js:569` runs `dir()` after `tick()` even when the pot
failed (it is caught), so `unit` can be `''` and a fill reads "Amount due: 0.0002 . Pay to ...", no longer the scheduled
wording. Rare; disable the buttons until `unit` is set, or rebuild the fill text on press (it already is built on press,
so only the first minutes are affected).

**L6. Attack/vendor pairing is fixed.** `examples.js:59-60` picks kind `i % 4` and vendor `i % vendors`; with two vendors
the "wallet changed" and "ignore your rules" examples always use the first vendor. Cosmetic.

## Not checked

- No live render in a browser or on a real phone; layout judged from the CSS.
- Real Sayso behaviour on a player-sent usual invoice ("expected to let it through" is a hedge, which is right).
