# Emergency OTA hotfix to the STAFF 2.2.0 lane (post-Phase-2)

## ⚠️ READ THIS FIRST — THE ONE RULE
The publish MUST run from a checkout whose `mobile/app.config.js` says
`runtimeVersion: '2.2.0'`. EAS stamps the update with the runtimeVersion of the
checkout you publish from. Publishing from a post-P2 checkout (runtime 2.3.0)
onto branch main would deliver MEMBER-app code to every staff 2.2.0 install —
the exact brick the single-merge rule exists to prevent. Verify the runtime
line BEFORE running `eas update`, every time.

Pre-P2 anchor: `2ce8971c0bc23fa4e8c65396cf3da006806f1cf1`
(origin/main immediately before the Phase-2 merge; app.config.js line 309 = '2.2.0')

## Recipe

    # 1. Isolated worktree at the pre-P2 anchor (never checkout in the main clone)
    git -C ~/code/un1t-crm fetch origin
    git -C ~/code/un1t-crm worktree add /tmp/crm-2.2.0-hotfix 2ce8971c0bc23fa4e8c65396cf3da006806f1cf1

    # 2. Cherry-pick the fix commit(s) onto the anchor
    git -C /tmp/crm-2.2.0-hotfix cherry-pick <fix-sha>
    #    Resolve conflicts here if the fix was authored against post-P2 code.

    # 3. GUARDRAIL — abort unless the lane is 2.2.0
    grep -n "runtimeVersion: '2.2.0'" /tmp/crm-2.2.0-hotfix/mobile/app.config.js || { echo 'WRONG LANE — STOP'; exit 1; }

    # 4. Install and publish
    cd /tmp/crm-2.2.0-hotfix/mobile
    # Plain `npm ci` (OTATREE.1, 2026-08-20). `--legacy-peer-deps` used to be
    # here; it prunes 13 peer entries under npm 11 and EAS Build installs the
    # binary's tree with a plain `npm ci` (there is no .npmrc), so the flag
    # could only ever build the hotfix from a different tree than the 2.2.0
    # binary it has to be bytecode-compatible with. See
    # store-release-one-app.md §7.
    npm ci
    npx eas-cli update --branch main --message "hotfix: <desc> (2.2.0 lane)" --non-interactive

    # 5. Verify: the new update group must show runtimeVersion 2.2.0
    npx eas-cli update:list --branch main --limit 3 --non-interactive --json
    #    Confirm the top entry is your message AND runtimeVersion == "2.2.0".
    #    If it says 2.3.0 you published from the wrong checkout: immediately
    #    republish the last-known-good 2.2.0 update (eas update:republish) and investigate.

    # 6. Clean up
    git -C ~/code/un1t-crm worktree remove /tmp/crm-2.2.0-hotfix

## Notes
- Branch `main` serves channel `production` for BOTH runtimes; clients
  self-select by runtimeVersion, so publishing 2.2.0 updates here is safe
  alongside 2.3.0 ones.
- The GitHub Action auto-publishes an OTA on every push to main from the
  post-P2 tree (runtime 2.3.0). Do NOT push the hotfix branch anywhere to
  publish it — publish manually from the worktree as above.
- Store binaries for the 2.2.0 lane (rollback of last resort):
  iOS build 27d940e3-c5c3-49d5-81e8-ad4a9da93707, Android 2b63f70d-d4aa-4fc8-91e8-8b71e6b6506f
  (both 2026-07-30, production profile). Local copies: ~/code/release-anchors/2.2.0/
  (pulled 2026-08-17 before the ~Aug-29 EAS artifact expiry).
