# demo-agent: read this first

sayso's public "Break the guard" demo with a real prize pot. How it works: `README.md`. The product and the team's
rules live in the main repo (`saysoio/sayso`): its `CLAUDE.md` and `docs/decisions.md` bind this repo too.

## Hard rules

- The model gets **no tools**, ever. It returns one decision in the schema in `src/brain.ts`; nothing it says is run.
- The code never pre-filters payments by recipient or amount. sayso decides; `checkDecision` checks shape only.
- Nothing can sign except through the guarded client in `src/wallet.ts` (enforce mode, fail-closed, signatures refused).
  Never hand the raw CDP account or an unguarded client to anything.
- The owner key never goes to the box. `src/setup.ts` runs on the owner's Mac, by hand.
- The only secret names the box accepts are in `OWN_SECRETS` (`src/isolation.ts`). Never print, log or commit a secret;
  check `git diff --cached --name-only` before every commit.
- Real funds: only the founder funds or moves the pot. Development runs with `DEMO_FAKE=1` or on Base Sepolia.
- Anything that changes what can be signed or who sees what gets a review by a separate agent before merge.
- Player text is shown publicly: the page sets it with `textContent` only, never as HTML.
- Write the name **sayso** in lowercase in code and notes; the page's visible text says **Sayso** (website rule).
