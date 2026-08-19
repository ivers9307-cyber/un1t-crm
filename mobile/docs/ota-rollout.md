# OTA staged rollout — ramp / halt runbook

**Since P5-OTA (2026-08-17), every auto-published OTA starts at 10%.**
`.github/workflows/eas-update.yml` publishes with `--rollout-percentage 10`
on each push to `main` touching a path that genuinely enters the Metro
bundle (see [What actually publishes](#what-actually-publishes)), or
`shared/**`. Devices outside the 10% cohort keep serving the *previous
latest* update on branch `main`. Ramping to 100% is a manual step — this
file is the runbook.

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
**EAS Update** workflow via `workflow_dispatch`. That is one dispatch
**plus a manual ramp**, not one click — the job takes no inputs, so it
publishes from **main HEAD** (whatever else has landed since, not just the
missed commit) at the same hard-coded `--rollout-percentage 10`. The
recovery publish is itself a staged partial and starts its own 48h
[ramp-or-rollback](#the-rule--no-zombie-partials) clock. Still the cheaper
failure than an unwanted publish — but budget the ramp step.

Why: P5 exit gate of the Repset one-app merge. Instant full-fleet publish
was fine for 16 staff phones; it is not acceptable with ~1,100 members on
the same `main` branch / `production` channel. The pinned eas-cli **18.9.1**
supports `--rollout-percentage` on `update`, `update:edit` and
`update:republish` (verified against its `--help` output), so the
Hermes-bytecode CLI pin (`eas.json` `cli.version` = workflow pin = 18.9.1)
is unchanged. Do **not** bump the pin to change rollout behaviour.

## THE RULE — no zombie partials

**Every rollout is ramped to 100 or rolled back within 48 hours.**
A partial rollout left sitting means two cohorts run different code
indefinitely, bug reports stop reproducing, and the next auto-publish
stacks a second partial on top (users outside the new 10% get the previous
latest update *even if that one is itself mid-rollout*). Ramp it or kill it.

## Ramp 10 → 100

The group id is printed in the GitHub Actions **job summary** of the
publish run (or `npx eas-cli@18.9.1 update:list --branch main`).

    cd mobile
    # sanity: watch crash-free behaviour in the 10% cohort first
    npx eas-cli@18.9.1 update:edit <GROUP_ID> --rollout-percentage 50
    # then, when still clean:
    npx eas-cli@18.9.1 update:edit <GROUP_ID> --rollout-percentage 100

10 → 100 directly is fine for low-risk changes; the 50% step is for
anything touching boot/auth/navigation. Percentages only go **up** —
to pull an update back, use a halt (below), not a lower percentage
(the flag accepts 1–100; there is no 0).

## Halt a bad rollout

Two levers, in order of preference:

1. **Republish the last known-good group** (converges everyone, including
   the 10% who got the bad update, onto the good bundle):

       cd mobile
       npx eas-cli@18.9.1 update:republish --group <LAST_GOOD_GROUP_ID> \
         --message "halt: republish last good over <bad-sha>" --non-interactive

   (Interactive `update:republish --branch main` also works and lets you
   pick the group from a list.)

2. **Nuclear — back to the embedded bundle** (every device falls back to
   the JS baked into its binary; loses ALL OTAs since the store build):

       npx eas-cli@18.9.1 update:roll-back-to-embedded --channel production

Then fix forward: land the fix on `main`; the workflow publishes it at 10%
and the cycle restarts.

## Interaction with the 2.2.0 / 2.3.0 runtime lanes

**runtimeVersion isolation is unchanged.** A rollout percentage is scoped to
its update group, and an update group only ever serves binaries whose
runtimeVersion matches the checkout it was published from. Post-P2, `main`
is runtime **2.3.0**, so the auto-published 10% cohort is 10% of 2.3.0
installs; staff binaries still on the **2.2.0** lane see nothing from it.
An emergency hotfix to the 2.2.0 lane (see `rollback-2.2.0-lane.md`) is a
manual publish — add `--rollout-percentage 10` there too if the blast
radius warrants it, and apply the same 48h rule.

## Gotchas

- **A new push mid-rollout stacks.** The workflow publishes every qualifying
  `main` push at 10%. If update B lands while update A is at 10%, devices
  outside B's cohort serve A (the previous latest) — including A's bad code
  if A was the problem. Halting means republishing the last *good* group,
  not just waiting for the next merge. And when ramping after stacked
  publishes, ramp the **newest** group; older partials become moot once a
  newer update is fully rolled out. The commonest *accidental* source of a
  stacked partial — a push whose only mobile files were non-bundle ones —
  is closed by the allowlist above, but a real code push mid-ramp still
  stacks, by design.
- The job summary of each publish run shows runtimeVersion, rollout % and
  group id — check there before reaching for the EAS dashboard.
- `eas update:edit` needs `EXPO_TOKEN`/login locally: run it from `mobile/`
  with `npx eas-cli@18.9.1` (matches the pin; a newer global CLI also works
  for `update:edit` since it publishes no bytecode, but staying on the pin
  removes the thought entirely).
