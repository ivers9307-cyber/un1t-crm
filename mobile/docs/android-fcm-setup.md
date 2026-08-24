# Android push — the FCM setup (operator runbook)

**Status: NOT DONE.** Android push has never worked on Repset. This is the
authoritative runbook for turning it on. `mobile/docs/store-release-one-app.md`
§5.2 is a summary of this page — if the two ever disagree, this one wins.

**Who does what.** Every step below needs either a Google account that can
create Firebase projects or an authenticated `eas-cli` session (`npx eas-cli
whoami`). Claude has neither, and will not attempt either: creating accounts
and handling credential files are operator actions. Claude *can* make the
`app.config.js` edit in step 3 once you tell it which delivery route you
picked, and can write the changelog and PR around it. Everything else on this
page is Richard, by hand.

---

## Why it was worth fixing the reporting first (ANDROID-VIS.1, mig 565)

`expo-notifications`' `getExpoPushTokenAsync()` throws on Android without FCM
credentials. `mobile/lib/push-register.js` swallows that failure by design —
reporting must never break the surface that triggered it — and, until mig 565,
the swallow took the **entire device registration** with it, because
`device_tokens` was keyed by the push token (`NOT NULL`). Result, measured
against prod on 2026-08-24: **13 iOS rows, zero Android rows ever**, while
Android staff were signing in every week. Android was invisible to push (which
needs this runbook) *and* to the staff-device / geofence-permission report
(which did not).

Mig 565 separated the two. The device now registers under a `device_key` with
`expo_push_token` NULL, so it shows up on `/settings/notifications/health` with
its platform, app version, last-seen and background-location permission today.
**When you finish this runbook, nothing needs migrating or backfilling:** the
first time `getExpoPushTokenAsync()` succeeds on a device, the token is written
into that device's *existing* row, and every sender picks it up on the next
send. Senders already filter `expo_push_token IS NOT NULL`, so a device that
has not yet been rebuilt simply stays skipped rather than counted as a failure.

---

## What you actually need

Two separate credentials. They are not interchangeable and both are required:

| | What it is | Where it lives | Secret? |
|---|---|---|---|
| **`google-services.json`** | Client config (Firebase project id, app id, API key). Lets the **device** register with FCM. | Baked into the Android binary at **build** time. | Not really — it can be extracted from any published APK. But this repo is **public**, so still do not commit it (see step 3). |
| **FCM V1 service-account key** | A Google service-account private key. Lets **Expo's servers** send to FCM on our behalf. | Uploaded to EAS. Never in the repo. | **Yes. Real secret.** Treat like a password. |

Fixed values you will be asked for:

- Android package: **`com.un1tdublin.crm`** (`android.package` in `mobile/app.config.js`)
- EAS project: **`6256a4d8-03ff-4898-9d47-b4de6c9c20e1`** (`extra.eas.projectId`)
- Build profile that ships to Play: **`production`** (`mobile/eas.json`)

---

## Step 1 — Firebase project + Android app

1. <https://console.firebase.google.com> → **Add project** (or open the
   existing one if a Repset/UN1T project already exists — check before
   creating a second; two projects for one package is the classic way to end
   up uploading a service-account key that does not match the
   `google-services.json` in the binary).
2. Google Analytics is **not** required. Skip it unless you want it.
3. Inside the project: **Add app → Android**.
   - *Android package name*: `com.un1tdublin.crm` — must match **exactly**, or
     the device's FCM registration fails at runtime with no useful error.
   - *App nickname*: `Repset` (cosmetic).
   - *Debug signing certificate SHA-1*: **leave blank.** It is only needed for
     Google Sign-In / Dynamic Links, neither of which this app uses.
4. Download **`google-services.json`**. Keep the file; do not paste its
   contents into chat, a ticket, or a commit.

## Step 2 — confirm FCM V1 is on, and mint the service-account key

1. Project settings → **Cloud Messaging**. Confirm **Firebase Cloud Messaging
   API (V1)** is *Enabled*. If it shows a "Manage API in Google Cloud Console"
   link with the API disabled, enable it there and come back.
   - Ignore the **Cloud Messaging API (Legacy)** row entirely. Google shut the
     legacy server-key path down in 2024; Expo uses V1. A legacy server key
     uploaded here does nothing.
2. Project settings → **Service accounts** → **Generate new private key** →
   confirm. A `.json` downloads.
   - This is the secret one. Delete it from `~/Downloads` once step 4 has
     accepted it.

## Step 3 — get `google-services.json` into the build

`mobile/app.config.js` has an `android` block today (`package`,
`blockedPermissions`, `adaptiveIcon`) and **no `googleServicesFile` key at
all** — that is the gap. Pick one of two routes:

**Route A — EAS file secret (recommended, because this repo is public).**

```
cd mobile
npx eas-cli env:create --name GOOGLE_SERVICES_JSON --type file \
  --value ./path/to/google-services.json --visibility secret \
  --environment production
```

then the config edit:

```js
android: {
  package: 'com.un1tdublin.crm',
  googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
  // …existing keys unchanged
},
```

EAS materialises the secret as a file on the build worker and sets the env var
to its path. Local `expo prebuild` / dev builds fall back to a
`mobile/google-services.json` you keep on disk and **git-ignore**.

**Route B — commit the file.** Drop it at `mobile/google-services.json`, set
`googleServicesFile: './google-services.json'`, commit. Simpler, and the file
is not a true secret — but it publishes our Firebase project id and API key in
a public repo, and there is no reason to. Only take this route if the EAS
secret proves painful.

Either way, **add `mobile/google-services.json` to `.gitignore` under Route
A**, next to the existing `mobile/keys/` entry.

## Step 4 — upload the service-account key to EAS

Run from a checkout whose `mobile/app.config.js` **contains the HealthKit
plugin** (post-P2 `main` qualifies). This is the standing rule at the top of
`store-release-one-app.md`: EAS capability-sync reads the app config of the
CWD, and running from a pre-merge tree has already un-ticked HealthKit on the
Apple App ID twice.

```
cd mobile
npx eas-cli credentials
```

→ **Android** → **production** → **Google Service Account** → *"Manage your
Google Service Account Key for Push Notifications (FCM V1)"* → **Set up a new
key** → point it at the JSON from step 2.

Verify with `npx eas-cli credentials` again: the Android production profile
should now list an FCM V1 service-account key.

## Step 5 — a NEW BINARY is required (and this is the part people get wrong)

`google-services.json` is consumed by the Gradle `google-services` plugin at
**build** time. It cannot arrive over the air. Nothing in step 3 or 4 reaches a
single installed phone until a new Android build ships through Play.

```
cd mobile && npm ci && npx eas-cli build --platform android --profile production
```

Plain `npm ci` — **never** `--legacy-peer-deps` against this lockfile (it
prunes 13 peer entries; OTATREE.1).

Then upload manually: `eas.json`'s `submit.production` block has an **`ios`
key only**, so there is no `eas submit` path for Android here. Follow
`store-release-one-app.md` §5.3 — download the `.aab`, Play Console → Internal
testing → smoke-test (R8/ProGuard is on, so reflection breakage only surfaces
in a minified build) → promote to Production with a staged rollout.

### Does `runtimeVersion` have to bump? **No — and it should not.**

The task brief assumed it would, so this is worth being exact about. The rule
in `app.config.js` is "bump on every future **native change**", and this repo
has twice decided what that means for a Gradle/manifest-level change with no
new native module:

- **1.3.2** — Android manifest fix (`blockedPermissions` dropping
  `RECORD_AUDIO`). Comment: *"Manifest-level → needs this native build; no
  JS/native API change, so runtimeVersion stays '1.3.0'."*
- **ANDROID-R8** — enabling R8 + resource shrinking. Comment: *"NATIVE change
  → new EAS Build, not OTA-able; runtimeVersion stays put (the JS↔native
  interface is unchanged, so existing lanes still match)."*

Adding `googleServicesFile` is the same shape: it changes what the binary
contains, not what JS may call. `expo-notifications` is already in the 2.3.0
binary and its API does not change. So:

- **`version`** → bump (e.g. `2.3.0` → `2.3.1`) for the Play release.
  `appVersionSource: 'remote'` means EAS owns `versionCode`.
- **`runtimeVersion`** → **leave at `2.3.0`.** Bumping it would fork the OTA
  lane and freeze **every existing install — iOS included** — off updates
  until each user installs a new binary from their store. That is a real cost
  paid for nothing: 2.3.0 is the public lane carrying ~1,100 member devices.

⚠️ `mobile/app.config.js` is an **OTA publish path**, so the `npm run
version:patch` commit that bumps `version` publishes an update to the 2.3.0
lane at 100% the moment it lands on `main`. Expected, but know it is happening.

## Step 6 — verify

1. Install the new build on a real Android device (internal testing track) and
   sign in as staff. Accept the notification prompt (Android 13+ asks).
2. `/settings/notifications/health` → that device should now show a platform
   and app version **and** be push-reachable. Before this runbook it appeared
   there token-less (that is ANDROID-VIS.1 working); after it, `sendPush`
   stops skipping it.
3. Send one: **Settings → Notifications → send a test push**, or the
   "App update available" nudge on the device-health page.
4. Confirm in the DB that the row filled in rather than duplicating:

```sql
select platform, device_key is not null as has_key,
       expo_push_token is not null as has_token,
       app_version, last_seen_at
from device_tokens order by last_seen_at desc;
```

   One row per device. An Android row that flipped `has_token` from false to
   true **without** gaining a sibling row is the proof that the `device_key`
   identity did its job.

---

## Troubleshooting

- **Token still throws on Android after the new build.** The package name in
  `google-services.json` does not match `com.un1tdublin.crm`, or the build
  predates step 3. Check the Firebase app entry, then confirm the build you
  installed is newer than the config change.
- **Token acquires, push never lands.** That is the *other* credential — step
  4. `npx eas-cli credentials` → Android → production must list an FCM V1 key,
  and it must belong to the **same Firebase project** as the
  `google-services.json` in the binary.
- **Push lands on the tester's phone and nobody else's.** Not an FCM problem —
  that is the unregistered-`sendPush`-category trap in `CLAUDE.md`: an
  unregistered `notify_<category>` resolves **false** for every role but
  `master`. Send categoryless, or register the key.
- **iOS unaffected throughout.** None of this touches APNs.
