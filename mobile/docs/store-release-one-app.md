# Store release playbook — the merged one-app (Repset 2.3.0)

Operator runbook for taking the merged staff + member binary (Repset, bundle
`com.un1tdublin.crm`, ASC record `6770890839`, EAS project
`6256a4d8-03ff-4898-9d47-b4de6c9c20e1`) through public App Store and Play
release, and for sunsetting the GRAFT store records. Phase 5 of the Repset
one-app merge; companion to `docs/repset-asc-metadata.md` (the staff-era ASC
reference — this doc supersedes its Description/Keywords/Review-Notes copy but
inherits its one-time App Information fields and pre-submission checklist).

> **⚠️ READ FIRST — three rules that outrank everything below**
> 1. **Never surface class or event capacity to members anywhere** — not in
>    screenshots, not in the description, not in review notes. Time + name
>    only. This is a hard product rule.
> 2. **Run every `eas credentials` / `eas build` / `eas submit` from a
>    checkout whose `mobile/app.config.js` contains the HealthKit plugin**
>    (post-P2 `main` qualifies). EAS capability-sync reads the app config of
>    the CWD — running from a pre-merge tree UN-TICKS HealthKit on the App ID
>    and has already reverted the portal capability twice.
> 3. **The staged-rollout OTA gate was merged (#1439) and then REVERSED**
>    (OTAPCT.1, 2026-08-21). It is no longer true that an auto-publish
>    starts at 10%: `rollout_percentage` defaults to **100**, and at 100 the
>    workflow omits the flag entirely, so no rollout object and no 48h ramp
>    clock exist. A push to `main` IS an instant, ungated shove to every
>    device on the runtime lane — ~1,100 member devices now that 2.3.0 is
>    public. The gate was reversed because a 10% rollout nobody ramped
>    BLOCKS the next publish, which silently cost five publishes over two
>    days; see `mobile/docs/ota-rollout.md`. What still binds: the trigger
>    is an **allowlist** of bundle-entering paths (a screenshots-, docs- or
>    `eas.json`-only commit publishes nothing — §4). If you deliberately
>    stage one via `workflow_dispatch` with `rollout_percentage` < 100, the
>    ramp-to-100-or-roll-back-within-48h rule applies to *that* publish, and
>    until you do, the next merge's publish fails.

---

## 1. App Store listing copy (dual audience)

The listing changes from "internal staff tool" to "studio platform with a
member side". Paste these into ASC on the 2.3.0 version page (Description /
What's New are per-version; Name / Subtitle live under App Information and
need the version in an editable state to change).

### Name (unchanged)
```
Repset
```

### Subtitle (30-char limit)
```
Your studio, your training
```
(26 chars. Replaces "Operations for UN1T Dublin staff", which no longer
covers half the audience.)

### Description
```
Repset is the studio platform for UN1T gyms. One app, two sides: staff run the gym, members track their training.

FOR MEMBERS

If you train at a UN1T studio, Repset is where your work shows up:

• Live effort points during class — your heart rate scored in real time on the studio system
• Session reports after every class: points earned, time in each effort zone, and how the session compared to your recent training
• Progress over time — weekly training ring, streaks, and personal trends
• Challenges and leaderboards with other members at your studio
• Apple Health integration — workouts you record elsewhere count towards your progress, and Repset can save session summaries back to Apple Health
• Coaching check-ins: goals, body composition scans, and progress photos shared privately with your coach

A membership at a participating UN1T studio is required for the member experience. Class bookings are managed through your studio's existing booking system.

FOR STAFF

Staff, coaches, and authorised contractors sign in with their UN1T account to:

• View shift schedules, request time off, and arrange swaps — arrival at the gym is logged automatically
• Manage member bookings, classes, and contact records
• Message members by WhatsApp, SMS, and email from the shared inbox
• Submit and track contractor invoices with receipt capture
• Run studio settings, dashboards, and team rosters for their locations

What each staff member can see and do is controlled by their role and location assignments, mirroring the Repset web platform.

Staff who are also members can switch between the two sides from their profile — one account, one app.

For privacy and data-handling details, see https://crm.repset.ie/privacy
```
(~1,600 chars — comfortably under the 4,000 limit. Deliberately plain: no
superlatives, no "revolutionary", and no mention of class capacity,
spot counts, or sold-out state anywhere.)

### Keywords (100-char limit)
```
gym,fitness,training,workout,heart rate,effort,studio,crm,staff,scheduling,challenges
```
(85 chars. "Repset" and "UN1T" are indexed automatically — don't spend
characters on them.)

### Promotional Text (170-char limit, editable without review)
```
Repset now includes the member experience: live effort points in class, session reports, streaks, challenges, and Apple Health sync.
```

### What's New in This Version (2.3.0)
```
Repset is now one app for the whole studio.

• Members: live effort points in class, session reports, weekly progress ring, streaks, and challenges
• Members: Apple Health integration — sync workouts both ways
• Staff who are also members can switch sides from their profile
• Staff features unchanged: schedule, inbox, bookings, invoices, studio management
```

### App Information deltas (one-time)
- **Primary category:** change `Business` → `Health & Fitness`; keep
  `Business` as secondary. (The member audience is now the public face of
  the listing.)
- **Age rating:** re-run the questionnaire; every answer stays **No** → 4+.
  The member social features (kudos, challenge leaderboards) are
  member-to-member within a gym, not open user-generated content — if Apple
  asks, they are moderated by studio staff via the CRM.
- **Privacy Policy URL** changes to **`https://crm.repset.ie/privacy`**
  (domain migration, Phase 6 — crm.repset.ie is the canonical CRM host).
  The page itself MUST be updated to cover health data AND be live on the
  repset host before submission (see §3; App Review checks that the policy
  matches the privacy labels, and clicks the URL).
- **Support URL** — set it to **`https://crm.repset.ie/technical`**.
  > **⚠️ Do NOT carry forward the inherited value.** The staff-era ASC
  > reference (`docs/repset-asc-metadata.md`) cited
  > `https://crm.un1tdublin.com/support`, and that URL has NEVER been a real
  > page: there is no `/support` route in the CRM (`src/app/` has only the
  > `api/support-session` API route), so it 307-redirects to the staff
  > login screen (`/login?redirect=%2Fsupport`). If the live ASC listing
  > still carries it, App Review's click-through lands on a login wall —
  > fix it on the 2.3.0 version page. `/technical` is the live, public,
  > allowlisted platform page (UN1T communications platform, with a
  > contact link) — a real page a reviewer or member can land on.

---

## 2. App Review notes (ready to paste)

Fill App Review Information on the 2.3.0 version page. Sign-in required:
**Yes**. Demo credentials: `apple-review@un1tdublin.com` + the password
stored in the ASC password field ⟨stored in ASC — never in this repo⟩.

> **⚠️ Demo account prep — do this BEFORE submitting, it is the point of no
> return.** Dashboard-created auth users get NO profile (post-Phase-0 the
> trigger only mints staff for `invited_for='staff'` invites). The review
> account must be created through the staff invite route (`/api/staff`),
> scoped to the non-production demo studio location only, and its linked
> member contact must be **seeded with session + HR data** — an unseeded
> member side renders a blank first-run state and reads as "app doesn't
> work" to a reviewer. Verify both sides render with real-looking data by
> signing in as the account yourself before you submit. The demo location
> must have no live integrations (no WhatsApp sender, no email), so nothing
> the reviewer does can reach a real member.

### Notes field
```
Repset is the studio platform for UN1T, a fitness club operator in Dublin, Ireland. It is ONE binary serving TWO audiences:

1. STAFF — gym staff, coaches, and contractors use it to run the gym (schedules, bookings, member messaging, invoices, studio settings). This was the app's original scope and is unchanged.
2. MEMBERS — gym members use it to track their training: live effort points during class (heart-rate based), post-class session reports, progress streaks, challenges, and Apple Health sync.

A single account can hold both roles. The demo account provided (credentials above) is exactly that: it signs in to the STAFF side, scoped to a demonstration studio, and can switch to the MEMBER side in-app.

REVIEWER WALKTHROUGH
1. Sign in with the demo credentials (email + password; the app may offer an emailed login code — the password field works without it).
2. You land on the staff Today/Home tab: dashboard tiles, Schedule, Inbox, Tasks, and More tabs. The demo account is scoped to a sandbox studio — any action taken affects demo data only and triggers no external messages.
3. Tap the avatar (top of the screen). Because this account holds both roles, the sheet offers "Switch to Personal".
4. Tap "Switch to Personal" — you are now on the member side: home screen with the weekly training ring, Sessions (open one for a full session report with effort points and zone breakdown), Progress, Compete (challenges), and Account.
5. On first visit to the member side, the app offers to connect Apple Health — this is optional and everything works without granting it.
6. The avatar switches you back to the staff side at any time. The app remembers which side you were on.

WHY EACH PERMISSION
- HealthKit (read + write): the member side reads workouts and heart rate to score training sessions, build progress trends, and count members into gym challenges; it can write workout summaries back to Apple Health. Health data is used for these features only — never for advertising or tracking, and it is not read on the staff side.
- Location (including Always): staff-side only — geofenced shift attendance. The app registers a geofence around the staff member's gym and logs arrival automatically; no continuous location tracking, and members are never asked for location.
- Camera: staff-side — scanning attendee QR codes at event check-in, and photographing receipts/documents for contractor invoice capture.
- Face ID: optional biometric app lock, protecting member and business data on a shared or lost device.

The member social surfaces (kudos, challenges) are visible only to members of the same gym and are moderated by studio staff through the Repset web platform.

If anything is unclear, please contact richard@un1tdublin.com before issuing a rejection — happy to walk through any flow over a call.
```

### Attachments
Optional but recommended for this submission: a 60–90s screen recording of
the walkthrough above (sign-in → staff Today → avatar → Switch to Personal →
session report → HealthKit prompt). One recording heads off the most likely
rejection ("account provided doesn't show the member features").

---

## 3. App Privacy questionnaire — delta

The questionnaire was published for the staff-only app. The one-app merge
adds **Health & Fitness** collection; everything else is unchanged. Update
via App Store Connect → App Privacy → Edit.

### ADD (new with 2.3.0)

| Apple category | Data types | Linked to identity? | Used for tracking? | Purposes |
|---|---|---|---|---|
| **Health & Fitness → Health** | Heart rate (from straps in class and from HealthKit), workouts read from HealthKit, body-composition scan results (InBody) shared into coaching | **Yes** (tied to the member's account) | **No** | App Functionality |
| **Health & Fitness → Fitness** | Session/effort scores, training streaks, challenge participation | **Yes** | **No** | App Functionality |

### UNCHANGED (already declared — verify they still read like this)

| Apple category | Data types | Linked | Tracking | Purposes |
|---|---|---|---|---|
| Contact Info | Name, email address, phone number (account + CRM contact records) | Yes | No | App Functionality |
| User Content | Photos (receipt/document capture, member progress photos), messages (inbox) | Yes | No | App Functionality |
| Location | Precise location (staff geofenced attendance only) | Yes | No | App Functionality |
| Identifiers | User ID | Yes | No | App Functionality |

Nothing in the app is used for tracking (no ad SDKs, no data brokers, no
cross-app identifiers), so the "Used for Tracking" answer stays **No**
across the board and no ATT prompt is needed.

**Prerequisite:** update `https://crm.repset.ie/privacy` to describe the
health-data collection (what is read from HealthKit, what the straps
capture, retention, and that it is never sold or used for advertising)
BEFORE submitting — App Review cross-checks the policy against the labels,
and "policy doesn't list all the data we collect" is a stock rejection.
Per the estate rule, the privacy page copy is operator-editable in the CRM —
edit it there, not in code.

---

## 4. Screenshot shot-list

### Sizes (per current ASC rules — confirm against the upload sheet on the day)
- **iPhone 6.9"** — REQUIRED. 1320×2868 (iPhone 16 Pro Max) or 1290×2796
  accepted. 3–10 screenshots.
- **iPhone 6.5"** — optional; ASC auto-scales the 6.9" set down if omitted.
  Upload natively (1242×2688) only if the scaled set looks wrong.
- **iPad 13"** — 2064×2752 (or 12.9" 2048×2732). The app is a universal
  binary (`supportsTablet: true`), so ASC expects iPad screenshots; the
  "use iPhone screenshots" deferral toggle remains acceptable if iPad shots
  aren't ready, but native ones are better since staff genuinely use iPads.

### Shots (order = listing order; lead with member, it's the public audience)

| # | Side | Screen | Required state |
|---|---|---|---|
| 1 | Member | Session report (`(member)/sessions/[id]`) | **LIT volt state** — a completed session with effort points earned, zone breakdown visible. Needs the seeded demo member's HR session. |
| 2 | Member | Home (`(member)/(tabs)/home`) | Week training ring partially filled, current streak visible. |
| 3 | Member | Compete (`(member)/(tabs)/compete`) | An active challenge with a leaderboard of demo members. |
| 4 | Member | Progress (`(member)/(tabs)/progress`) | Trend charts populated from the seeded sessions. |
| 5 | Staff | Today/Home dashboard | Reuse from the current listing if the post-reskin chrome still matches; otherwise recapture. |
| 6 | Staff | Schedule week view | Reuse if current. |
| 7 | Staff | Inbox | Reuse if current — check no real member names/numbers are visible; demo data only. |

Hard rules for every shot: **no class capacity, spot counts, or attendee
numbers visible anywhere** (member side must never show them by design —
double-check staff shots too, the Schedule and Bookings surfaces do show
counts to staff, so crop or use screens without them); no real member PII —
demo studio data only.

### How to capture
1. Build or download the 2.3.0 build and run it in the iOS Simulator
   (**iPhone 16 Pro Max** for 6.9", **iPad Pro 13-inch (M4)** for iPad).
   A simulator build: `npx eas-cli build --platform ios --profile development`
   (simulator: true on that profile), or run `npx expo run:ios` from
   `mobile/` on a post-merge checkout.
2. Sign in with the demo account (`apple-review@un1tdublin.com`) — the same
   seeding that App Review needs (§2) produces the LIT member states.
3. Simulator → File → New Screen Shot saves at the exact pixel size ASC
   wants. Status bar contents don't matter (Apple no longer requires
   styling).
4. Member shots: switch to Personal via the avatar, open the seeded session
   for shot 1.
5. Normalise sizes with `bash scripts/resize-screenshots.sh <pngs>`, then
   commit the finals to `mobile/asc-screenshots/` (originals under
   `asc-screenshots/source/`) and upload them to ASC by hand.

> **Committing screenshots does NOT publish an OTA.** `mobile/asc-screenshots/`
> is outside `eas-update.yml`'s publish allowlist, along with `docs/`,
> `certs/`, `scripts/`, `eas.json` and `.audit-allowlist.json`. This is worth
> stating because it was **not** true until OTA-PATHS.1: the trigger was
> `mobile/**`, so a screenshots-only commit would mint a fresh update group
> for a publish that changed no code. Since OTAPCT.1 that group would go out
> at **100%**, replacing the live bundle on every device on the runtime lane
> at next launch. Do not "simplify" that trigger back to
> `mobile/**`; `npm run check:ota-paths` guards it, and
> `mobile/docs/ota-rollout.md` has the full list.

> ⚠️ **App ICON and SPLASH art are the exception — those DO publish.**
> `mobile/assets/**` is *inside* the allowlist (the Archivo fonts beside
> them are `require()`d), so committing a new `icon.png`, `splash.png`,
> `adaptive-icon.png` or `notification-icon.png` mints an update group — at
> the 100% default since OTAPCT.1 — even though the JS bundle is
> byte-identical. Those four PNGs are
> referenced only from `mobile/app.config.js`, i.e. they are native-build
> inputs. This matters here because §4 is the same step where rebrand art
> gets regenerated. Do it in the same push as real code, or push it
> deliberately and ramp. Same for `mobile/app.config.js` itself (§7's
> version bump) — see §8.

---

## 5. Google Play

### 5.1 Data safety form — delta
Play Console → App content → Data safety → Manage. Add under **Health and
fitness**:

- **Health info** — collected: Yes. Shared: No. Processed ephemerally: No.
  Required or optional: Optional (Health Connect/strap data powers member
  features; the app works without it). Purpose: App functionality.
  Encrypted in transit: Yes. Deletion: users can request deletion
  (account deletion path / support contact).
- **Fitness info** — same answers (workout sessions, effort scores).

Everything already declared (personal info, photos, location for staff
attendance, app interactions) is unchanged. Re-submit the form — Play
reviews data-safety changes asynchronously; do this EARLY, it can lag the
binary review.

### 5.2 FCM prerequisite (push on Android — currently missing)
Android push does NOT work until FCM credentials exist for
`com.un1tdublin.crm` on EAS project `6256a4d8-03ff-4898-9d47-b4de6c9c20e1`.
This is a Richard task (Firebase console access):

1. Firebase console → create (or open) the project → Add app → Android →
   package name `com.un1tdublin.crm` → download `google-services.json`.
2. Put it at `mobile/google-services.json` and reference it in
   `mobile/app.config.js` under `android.googleServicesFile` (this is a
   native-build input — it ships in the NEXT build, not over OTA).
3. Firebase console → Project settings → Cloud Messaging: confirm the
   **FCM V1 API** is enabled. Then Project settings → Service accounts →
   Generate new private key (a JSON file).
4. From a post-merge checkout:
   `cd mobile && npx eas-cli credentials` → Android → production →
   Google Service Account → "Manage your Google Service Account Key for
   Push Notifications (FCM V1)" → upload the JSON from step 3.
5. Verify with a test push to a real Android device after the next build
   installs.

### 5.3 Upload + promotion (manual — no eas submit for Android here)
1. Download the .aab from EAS: build **`b759ed5b`** (2.3.0 lane) **or any
   newer 2.3.0 production build** — expo.dev → project → Builds → download,
   or `npx eas-cli build:list --platform android --limit 5` for the URL.
   Prefer a newer build if FCM (§5.2) has landed since, so push works from
   day one.
2. Play Console (`com.un1tdublin.crm`) → Testing → **Internal testing** →
   Create new release → upload the .aab → release notes (reuse the ASC
   "What's New" bullets) → roll out to internal testers.
3. Smoke-test the internal build on a device — R8/ProGuard is on, and
   reflection breakage only ever surfaces in a minified build. Check: sign
   in, staff Today, avatar switch, member home, a session report, camera
   (QR scanner), and a push if FCM is live.
4. Promote: release page → Promote release → **Production**. Use a
   **staged rollout** (start 20%, raise to 100% over a few days) — the Play
   analogue of Apple's phased release.
5. Play review for a Production release of an existing app is typically
   hours-to-days; the data-safety delta (§5.1) must be approved before the
   release goes live.

---

## 6. GRAFT sunset (dashboard steps)

The GRAFT store launch is dead by decision (2026-08-17): the queued 1.2.0 is
**never submitted**, and the member app lives inside Repset. Existing
`un1tapp://` schemes and printed QR codes keep resolving — the merged binary
registers `un1tapp` alongside `repset` and `cfstudio` — so sunsetting the
store records breaks nothing in the wild.

### App Store Connect — record `6782088809`
1. Open the 1.2.0 version page. If it is **Waiting for Review / In
   Review**: click **Remove from Review** (⋯ menu on the version). If it is
   merely **Prepare for Submission**: no action needed — an unsubmitted
   version just sits there.
2. Do NOT delete the app record or the version — Apple permanently reserves
   submitted bundle IDs to the team either way, and keeping the record
   preserves history. If a GRAFT version is currently live on the store
   (check "Ready for Sale"): App Store → App Availability (formerly Pricing
   and Availability) → **Remove app from sale** in all territories. If
   nothing was ever released, there is nothing to remove — the record simply
   goes dormant.
3. The Graft OTA pipeline is killed at cutover (decision on record) — no
   sunset OTA window; do not publish anything further on champ-app's EAS
   project (`17206a0e`).

### Google Play — `ie.champfitness.app`
1. Play Console → the champ/GRAFT app. If a release is pending review:
   discard it (release page → Discard release).
2. If the app is published (even internal/closed track only): Play Console
   → (app) → Advanced settings (under Setup) → App availability →
   **Unpublish**. Unpublishing hides it from the store; existing installs
   keep working but that install base is being migrated to Repset anyway.
3. Do not delete the app record — package names are permanently reserved
   and the record keeps the history.

Note for both stores: users who already installed the old member app are
handled by comms (see §8, step 8), not by store mechanics — nothing here
force-uninstalls anything.

---

## 7. Version & build mechanics

- **The release continues the CRM line:** version **2.3.0**, runtime lane
  **2.3.0** (explicit string in `mobile/app.config.js` — never switch to the
  fingerprint policy, PR #295 broke the iOS build with it). `appVersionSource`
  is **remote**: EAS owns buildNumber/versionCode — **currently 23** (iOS
  build `82c246e7`, the green Phase-2 build). Check with
  `npx eas-cli build:version:get`; every new production build
  auto-increments (`autoIncrement: true`).
- **New build, if needed** (e.g. after the FCM json lands): from a
  post-merge checkout —
  ```
  cd mobile && npm ci && npx eas-cli build --platform all --profile production
  ```
  (Plain `npm ci` — never `--legacy-peer-deps` against this lockfile, it
  prunes 13 peer entries. And per the top-of-doc rule: post-merge checkout
  ONLY, or EAS un-ticks HealthKit on the App ID.)

  **The pipeline now agrees with this** (OTATREE.1, 2026-08-20). Until then
  `.github/workflows/eas-update.yml` and `mobile-export.yml` both installed
  with `--legacy-peer-deps` while this document forbade it, and a reader
  could not tell which was true. The flag is gone from both. Measured on
  this lockfile with `npm ci --dry-run`:

  - **npm 11.12.1** — the flag prunes exactly the 13 entries named above,
    from two peer roots. `@react-native/metro-config` (peer of
    `@react-native/community-cli-plugin` and of `react-native-worklets`,
    whose Babel plugin is in `mobile/babel.config.js`) takes with it
    `@react-native/metro-babel-transformer` → `@react-native/babel-preset` →
    `@babel/plugin-transform-{react-jsx-self,react-jsx-source,regenerator}`:
    six Metro/Babel compile-path packages. `@testing-library/dom` (peer of
    `@testing-library/user-event`, a dependency of `expo-router`) takes
    `@types/aria-query`, `dom-accessibility-api`, `lz-string` and nested
    `pretty-format@27` / `react-is@17` / `ansi-styles@5`: seven test-only.
  - **npm 10.9.4** (what Node 22 ships, i.e. the CI runner today) — prunes
    **0**. The divergence was latent, waiting for a Node bump.

  The decisive reason does not depend on those 13 at all: **there is no
  `.npmrc` anywhere in this repo**, so EAS Build installs the binary's tree
  with a plain `npm ci`. Any flag on the OTA side could only ever create the
  tree mismatch the pinned install exists to prevent. Plain `npm ci` is also
  measured clean here — real install, exit 0, no `ERESOLVE`.

  Honest limit, so nobody over-claims: those six compile-path packages are
  **not reachable** from this project's actual bundler entry points —
  `metro.config.js` goes through `expo/metro-config` and `babel.config.js`
  through `babel-preset-expo`, and neither requires `@react-native/babel-preset`
  (they name it only in comments). The point is building from the same tree
  as the binary, not a bundle known to differ.
- **iOS submit** (Richard runs this — agent tooling is blocked from
  eas submit):
  ```
  cd mobile && npx eas-cli submit --platform ios --id 82c246e7-f488-42fc-b1cb-bcc399a62ea5
  ```
  Substitute the id for a newer build if one was cut. `eas.json` already
  carries ascAppId `6770890839` / team `535XMCT5PY`, so submit needs no
  extra flags.
- **Release train:** TestFlight (internal — staff, immediate) → external
  TestFlight group ("Repset Members Beta": a handful of friendly members,
  needs Beta App Review, usually <24h) → attach the build to the 2.3.0 ASC
  version → Submit for Review. Don't skip external TestFlight: it is the
  first time real member accounts touch the binary, and Richard waived
  device QA at the Phase-2 merge — this is where that debt is paid down.
- **Android:** manual, §5.3. There is no `submit` profile for Android in
  `eas.json` — that's deliberate for now.

---

## 8. Launch-day order

> **⚠️ GATE 0 — UNLISTED → PUBLIC CONVERSION (discovered 18 Aug 2026):** the ASC
> record is currently distributed as an **Unlisted App** (link-only, invisible
> in search) — a leftover from the staff-tool era. There is NO self-serve
> toggle: file a conversion request with Apple (developer.apple.com/contact →
> App Store Connect topic), citing app 6770890839 and the consumer audience
> arriving in 2.3.0. Submit the request EARLY (days of turnaround) and in
> parallel with everything below — but the app is not truly launched until
> Apple confirms public distribution, no matter what else is approved.

> **⚠️ LAUNCH-WINDOW FREEZE on bundle-path pushes to `main`.** While a build
> is in Apple review AND its runtime lane is ramped, treat every push to
> `main` that touches a publish path as a production event needing a
> deliberate ramp plan — not a routine merge. The publish paths are listed
> in `mobile/docs/ota-rollout.md`; the three that catch people out are
> **`mobile/app.config.js`** (the §7 version bump — `runtimeVersion` does
> *not* move with `version`, so the group lands on the LIVE lane),
> **`mobile/assets/**`** (icon/splash art — §4), and **test-only changes**
> under `mobile/lib/` or `shared/`. Each mints a fresh group, and since
> OTAPCT.1 that group goes to the WHOLE runtime lane at once — there is no
> cohort between a bad bundle and every device on it. If you must land one
> while a binary is in review, hold it until the review outcome is known, or
> stage it deliberately via `workflow_dispatch` and ramp it before the next
> merge (an un-ramped partial blocks that merge's publish).
>
> Current state at time of writing (2026-08-19): **2.3.0 build 24 is in
> Apple review and the 2.3.0 OTA lane is ramped to 100%.** Staff still on
> the 2.2.0 binary are on their own lane and unaffected.

Run strictly in this order — each step gates the next.

1. ~~**Merge the staged-rollout OTA gate — PR #1439**~~ — **DONE.**
   `.github/workflows/eas-update.yml` publishes to the whole runtime lane
   (default since 2026-08-21; was `--rollout-percentage 10` under the P5
   gate — see `mobile/docs/ota-rollout.md`)
   with a ramp/halt runbook (`mobile/docs/ota-rollout.md`). The publish
   trigger has since been narrowed from `mobile/**` to an **allowlist** of
   bundle-entering paths (OTA-PATHS.1), so non-bundle commits — screenshots,
   docs, `eas.json`, the audit allowlist — no longer mint a no-op update
   group on top of a live ramp. Still binding: **ramp to 100 or roll back
   within 48h**; never answer an unwanted trigger with a `!` negation
   (`npm run check:ota-paths` rejects it).
2. **Screenshots** captured per §4 (needs the seeded demo account, which
   §2 needs anyway).
3. **Metadata**: paste §1 copy into the 2.3.0 version + App Information;
   update the App Privacy labels (§3) and the privacy page (via the CRM,
   operator-editable); update the Play data-safety form (§5.1).
4. **Review prep**: demo account created via the staff invite route, demo
   location seeded, §2 notes + credentials into App Review Information,
   optional walkthrough recording attached.
   ⚠️ **Trap**: any demo/staff account minted programmatically (SQL insert,
   admin API) has `auth.users.email_confirmed_at = NULL`, and Supabase
   rejects password sign-in for unconfirmed emails — the app just says
   "password is incorrect". Confirm it before handing credentials to
   Apple: `UPDATE auth.users SET email_confirmed_at = now() WHERE email =
   '<demo email>';` (accounts created through the normal invite/OTP flow
   confirm themselves).
5. **Domain-migration reality check** — see the Stage-3 runbook,
   `docs/domain-migration-stage3.md`. The Meta/Postmark/Stripe provider
   re-registrations in that runbook are NOT required for submission (they
   gate webhooks and integrations, not App Review). What IS required
   before submitting: `https://crm.repset.ie/privacy` (updated per §3) and
   the demo account's sign-in path must be **live on the repset host** —
   the metadata now cites crm.repset.ie, and App Review clicks through.
6. **Submit**: iOS per §7 (build attached to the version → Add for Review →
   Submit). Android per §5.3 in parallel (internal → smoke test → hold at
   internal until Apple approves, then promote so the two stores go public
   together-ish).
7. **After Apple approval**: release with **Phased Release ON** (App Store
   version page → Phased Release for Automatic Updates → the 7-day curve:
   1%→2%→5%→10%→20%→50%→100%). Recommendation: ON. It only throttles
   automatic updates — anyone can pull the update manually — and it is the
   only rollback-adjacent lever Apple gives us. Pause it from the same page
   if anything goes wrong. On Play, the staged-rollout percentage (§5.3)
   is the same lever.
8. **Member comms** — only after both stores are live. Per the estate rule,
   ALL member-facing launch copy (announcement email/WhatsApp, "download
   Repset" instructions, what happens to the old app) is authored and sent
   through the CRM communications tools — sequences/broadcasts with
   operator-editable templates — and is hard-coded NOWHERE (not in the app,
   not in this repo). Draft the sequence in the CRM, respect the
   per-location comms model (row absent = that location may never send),
   and let the operator own the copy and the send.

---

## Quick reference

| Thing | Value |
|---|---|
| Bundle / package | `com.un1tdublin.crm` |
| ASC record (Repset) | `6770890839` |
| ASC record (GRAFT, sunsetting) | `6782088809` |
| Play package (GRAFT, sunsetting) | `ie.champfitness.app` |
| Apple team | `535XMCT5PY` |
| EAS project | `6256a4d8-03ff-4898-9d47-b4de6c9c20e1` (slug `un1t-crm-mobile`) |
| Version / runtime lane | 2.3.0 / 2.3.0 (buildNumber remote, currently 23) |
| Known-good builds | iOS `82c246e7` (build 23) · Android .aab `b759ed5b` · APK `b18e227f` |
| Demo account | `apple-review@un1tdublin.com` ⟨password stored in ASC⟩ |
| Staff-lane rollback | `mobile/docs/rollback-2.2.0-lane.md` |
