# OTA staged rollout — ramp / halt runbook

**Since 2026-08-21, every auto-published OTA goes out to the whole runtime
lane.** `.github/workflows/eas-update.yml` publishes on each push to `main`
touching a path that genuinely enters the Metro bundle (see
[What actually publishes](#what-actually-publishes)), or `shared/**`. Every
device on the matching runtime lane takes it on next launch.

Mechanically it publishes with **no rollout object at all** — at 100 the
`--rollout-percentage` flag is omitted rather than passed as `100`, because
a rollout sitting at 100% is the same kind of object that blocked five
publishes below, and there is no reason to mint one.

This **reverses the P5 staged-rollout gate** (2026-08-17), which published
at 10%. Why: *a partial rollout blocks the next publish.* EAS refuses a new
update on a runtime version while a rollout is in progress for it, and
nothing ramped automatically. The 10% publish on 08-19 (`TOKENDEAD.1`,
group `7a752860-079e-4431-bdd7-2feb2d03f86f`) was never ramped, so the next
**five** publishes all failed — BAREWRITE, LEGALENT, FUNNEL.5,
RETURNPIPE.1. They failed *silently*: this job is not a required check and
at the time `main` had no branch protection, so every merge reported green while phones
received nothing for two days. A staged default that nobody ramps is not a
safety mechanism; it is an outage that reports success.

**What the reversal costs.** There is no longer a cohort between a bad
bundle and the whole fleet. Runtime 2.3.0 went public on 2026-08-21
(build 24, Apple phased release), so a bad publish reaches every 2.3.0
device on next launch. [Halting](#halt-a-bad-rollout) is now the entire
safety net — know those two commands before you merge, not after.

**To stage a single publish anyway:** run the workflow via
`workflow_dispatch` and set the `rollout_percentage` input below 100. Doing
so re-arms the block described above, so ramp it to 100 before the next
merge or that merge's publish fails.

## What actually publishes

The trigger is an **allowlist**, not `mobile/**`. Publishing paths:

    mobile/app/**            mobile/index.js           mobile/global.css
    mobile/components/**     mobile/app.config.js      mobile/package.json
    mobile/lib/**            mobile/babel.config.js    mobile/package-lock.json
    mobile/assets/**         mobile/metro.config.js    shared/**
                             mobile/tailwind.config.js

Everything else under `mobile/` is **inert** and publishes nothing —
`docs/`, `asc-screenshots/`, `certs/`, `scripts/`, `eas.json`, `.eas/`,
`.audit-allowlist.json`, `.env.example`. So committing fresh App Store
screenshots, accepting a dependency advisory, or editing this runbook
does **not** mint an update group.

It used to. `mobile/**` with `!` negations bolted on published a no-op
OTA from a docs-only push (#1451) and from a
`mobile/.audit-allowlist.json`-only push (#1434) — each stacking a fresh
10% rollout on top of whatever ramp was in flight, plus a 48h obligation
under [the rule](#the-rule--no-zombie-partials) for a publish that
changed nothing.

### Three things on that list still publish a no-op

The allowlist is per-directory, so it over-triggers in three known places.
None of these is a bug to be surprised by — they are listed here so nobody
rediscovers them mid-ramp, and all three are pinned in
`tests/ota-trigger-paths.test.js`.

- **App icon / splash art.** `mobile/assets/**` is listed because the
  Archivo fonts are `require()`d, but the four PNGs beside them
  (`icon.png`, `splash.png`, `adaptive-icon.png`, `notification-icon.png`)
  are referenced only from `mobile/app.config.js` — native-build inputs.
  Changing one produces a byte-identical JS bundle **and still publishes**.
  During a rebrand or a launch week, swap art in the same push as real
  code, or do it deliberately and ramp.
- **Test and fixture files.** `mobile/lib/**` and `shared/**` are listed
  wholesale, so the 36 `*.test.js` under `mobile/lib/` and the 62
  `*.test.js` / `__tests__/` / `__fixtures__/` files under `shared/` all
  publish. A **test-only** change does mint an update group; it has
  happened twice in real history (`2941c7c8`, `206a0366`). Narrowing needs
  a `!` exclusion, which is the denylist this replaced.
- **Anything new under `shared/`.** `shared/**` is wholesale on purpose
  (mobile pulls it transitively and the set churns weekly), so a new
  `shared/README.md` or `shared/docs/` would publish. `check:ota-paths`
  walks `mobile/` only and will still report clean.

**Adding a directory under `mobile/`?** Decide whether it ships: add it
to the trigger, or to `NON_BUNDLE` in
`scripts/check-ota-trigger-paths.mjs`. `npm run check:ota-paths` fails
until you do. Do **not** answer an unwanted trigger with a `!` negation —
that is the denylist this replaced.

> **`check:ota-paths` is a signal on PRs, a gate on publish.** `main` has
> no branch protection and no rulesets, so a red Web CI blocks no merge and
> a direct-to-main push skips PR checks entirely. What actually stops a
> misclassified path is the same check running inline in the **EAS Update**
> job, where it aborts the publish. Treat the PR-side run as the early
> warning, not the wall.

**Recovery if the allowlist misses a genuinely-bundled file:** run the
**EAS Update** workflow via `workflow_dispatch`. It takes no ref input, so
it publishes from **main HEAD** — whatever else has landed since, not just
the missed commit — and at the default `rollout_percentage` of 100 that
reaches the whole runtime lane immediately. Read the diff between the
missed commit and HEAD before dispatching; that is the step people skip.

The pinned eas-cli **18.9.1** supports `--rollout-percentage` on `update`,
`update:edit` and `update:republish` (verified against its `--help`
output), so the Hermes-bytecode CLI pin (`eas.json` `cli.version` =
workflow pin = 18.9.1) is unchanged. Do **not** bump the pin to change
rollout behaviour.

## THE RULE — no zombie partials

**Any rollout you deliberately stage below 100 is ramped to 100 or rolled
back within 48 hours.** At the 100% default this rule is dormant — nothing
partial exists to go stale. It applies the moment you use the
`rollout_percentage` input, or publish a staged update to the 2.2.0 lane
by hand.

A partial left sitting is worse than it looks. Two cohorts run different
code indefinitely and bug reports stop reproducing — but the sharp edge is
that **it blocks every subsequent publish on that runtime version**. That
is not a style rule; it is the failure that cost this estate five silent
publish failures and two days of stale JS on phones. Ramp it or kill it.

## Ramp a partial to 100

Only needed after a deliberately staged publish. The group id is printed in
the GitHub Actions **job summary** of the publish run (or
`npx eas-cli@18.9.1 update:list --branch main`).

    cd mobile
    # sanity: watch crash-free behaviour in the staged cohort first
    npx eas-cli@18.9.1 update:edit <GROUP_ID> --rollout-percentage 50
    # then, when still clean:
    npx eas-cli@18.9.1 update:edit <GROUP_ID> --rollout-percentage 100

Straight to 100 is fine for low-risk changes; the 50% step is for anything
touching boot/auth/navigation. Percentages only go **up** — to pull an
update back, use a halt (below), not a lower percentage (the flag accepts
1–100; there is no 0).

**`update:edit` needs a working local `mobile/node_modules`.** It resolves
the Expo config, so a stale or partial install fails with
`Failed to resolve plugin for module "…"` before it ever reaches the API.
`npm ci --legacy-peer-deps` in `mobile/`, or use the Expo dashboard
(project → Updates → branch `main` → the group) which needs no local setup
at all.

## Halt a bad rollout

Two levers, in order of preference:

1. **Republish the last known-good group** (converges everyone who took the
   bad update onto the good bundle — at the 100% default that is the whole
   runtime lane, so reach for this fast):

       cd mobile
       npx eas-cli@18.9.1 update:republish --group <LAST_GOOD_GROUP_ID> \
         --message "halt: republish last good over <bad-sha>" --non-interactive

   (Interactive `update:republish --branch main` also works and lets you
   pick the group from a list.)

2. **Nuclear — back to the embedded bundle** (every device falls back to
   the JS baked into its binary; loses ALL OTAs since the store build):

       npx eas-cli@18.9.1 update:roll-back-to-embedded --channel production

Then fix forward: land the fix on `main` and the workflow publishes it at
100%. If you would rather the fix went out to a cohort first, dispatch the
workflow manually with `rollout_percentage` set — and remember to ramp it
to 100 afterwards, or the publish after it fails.

## Interaction with the 2.2.0 / 2.3.0 runtime lanes

**runtimeVersion isolation is unchanged.** A rollout percentage is scoped to
its update group, and an update group only ever serves binaries whose
runtimeVersion matches the checkout it was published from. Post-P2, `main`
is runtime **2.3.0**, so an auto-publish reaches 2.3.0 installs only; staff
binaries still on the **2.2.0** lane see nothing from it.

**2.3.0 is the public lane as of 2026-08-21** (build 24 approved, Apple
phased release running). Before that date the lane was TestFlight-only and
a 100% publish was near-harmless; it is not any more. Every push to `main`
now reaches real members.

An emergency hotfix to the 2.2.0 lane (see `rollback-2.2.0-lane.md`) is a
manual publish — add `--rollout-percentage` there explicitly if the blast
radius warrants staging, and apply the 48h rule to it.

## Gotchas

- **A partial rollout blocks the next publish — it does not stack.** This
  is the single most expensive thing in this file. While a rollout is in
  progress on a runtime version, `eas update` REFUSES to publish another
  one for that version: *"the latest rollout percentage must be set to 100%
  or the rollout update deleted."* The job fails, and because it is not a
  required check on an unprotected `main`, the merge still reports green.
  Five consecutive publishes were lost this way (18–21 Aug 2026). At the
  100% default this cannot happen; it returns the moment you stage one.
- The job summary of each publish run shows runtimeVersion, rollout % and
  group id — check there before reaching for the EAS dashboard.
- `eas update:edit` needs `EXPO_TOKEN`/login locally: run it from `mobile/`
  with `npx eas-cli@18.9.1` (matches the pin; a newer global CLI also works
  for `update:edit` since it publishes no bytecode, but staying on the pin
  removes the thought entirely).
