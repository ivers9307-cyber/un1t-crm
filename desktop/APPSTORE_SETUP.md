# Mac App Store + Unlisted Distribution Setup

Step-by-step setup so the `Desktop App Store` CI workflow produces
a signed `.pkg` and uploads it directly to App Store Connect, ready
to ship as an unlisted Mac app under the existing Repset ASC
record.

You only do this once. After the four GitHub secrets are in place,
every workflow run can upload a new build for review.

---

## What you'll end up with

By the end of this guide:

- The Repset app record in ASC has **macOS** added as a
  platform (Universal Purchase — same `com.un1tdublin.crm` bundle
  ID as the iOS app).
- A **Mac App Distribution** certificate exported from Keychain
  as a `.p12` file.
- A **Mac Installer Distribution** certificate exported as a
  separate `.p12` file.
- Four secrets in the un1t-crm GitHub repo:
  - `APPLE_MAS_APP_CERTIFICATE` (base64-encoded App `.p12`)
  - `APPLE_MAS_APP_CERTIFICATE_PASSWORD`
  - `APPLE_MAS_APP_SIGNING_IDENTITY` (App cert Common Name)
  - `APPLE_MAS_INSTALLER_CERTIFICATE` (base64-encoded Installer `.p12`)
  - `APPLE_MAS_INSTALLER_CERTIFICATE_PASSWORD`
  - `APPLE_MAS_INSTALLER_SIGNING_IDENTITY` (Installer cert Common Name)

The existing `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` secrets
are reused for the altool upload step — no changes there.

After setup, the workflow run produces a build that lands in App
Store Connect within ~10 min; from there you select it for the
unlisted version and submit for review.

---

## Why Mac App Store rather than Developer ID DMG?

| | App Store | Developer ID DMG |
|---|---|---|
| Distribution | ASC unlisted link | Hosted DMG |
| Notarisation queue | Bypassed (App Store has its own pipeline) | Required — and currently jammed for our team |
| Sandbox | Mandatory | Optional |
| Auto-update | Handled by App Store | Self-managed via Tauri updater plugin |
| First-time review | 24-48h, then same-day | Same-day notarisation when Apple's queue is healthy |
| Gatekeeper | Always clean | Clean if notarised + stapled |

We're on the App Store path because the Developer ID notarisation
queue stalled for >15 h on first-time submissions for this account
and we don't want our distribution gated on Apple's backend mood.

The Developer ID workflows (`desktop-build.yml`,
`desktop-finalize.yml`) stay in the repo as a fallback. If we ever
need a non-App-Store distribution path again, they're ready to go.

---

## Step 1 — Add macOS as a platform on the Repset ASC record

The iOS app already exists at App Store Connect with bundle ID
`com.un1tdublin.crm`. Universal Purchase lets one record cover
both iOS and macOS binaries.

1. Visit <https://appstoreconnect.apple.com/apps>.
2. Click into **Repset** (the existing iOS app record).
3. Top-left, look for the platform switcher / *Add Platform*
   button. Choose **macOS**.
4. Apple asks you to confirm Universal Purchase. Confirm.
5. The macOS platform now appears alongside iOS. Both share the
   same bundle ID, app name, primary category, and unlisted
   distribution status.

Note: the existing unlisted-distribution approval applies to the
ASC record, not a specific platform. The macOS platform inherits
it automatically — you don't have to re-apply.

You'll set macOS-specific metadata (description, Mac screenshots,
etc.) once you upload the first build in Step 7.

---

## Step 2 — Generate a Mac App Distribution certificate

This is a different certificate from the Developer ID Application
cert used by the DMG workflows.

1. Go to <https://developer.apple.com/account/resources/certificates/list>.
2. Click the **+** button (top-right) to add a new certificate.
3. Under **Software**, choose **Mac App Distribution**.
   Click *Continue*.
4. Upload the same Certificate Signing Request you generated for
   the Developer ID cert — CSRs are reusable. If you don't have
   one to hand, generate a fresh one:
   - Keychain Access → Certificate Assistant → Request a
     Certificate from a Certificate Authority…
   - Saved to disk, Continue.
5. Download the resulting `.cer`. Double-click to install it in
   your Keychain.

While you're on this page, note the certificate's **Common Name**.
It will be something like:

    3rd Party Mac Developer Application: <Your Name> (<TEAMID>)

Copy that whole string — it's `APPLE_MAS_APP_SIGNING_IDENTITY`
later.

---

## Step 3 — Generate a Mac Installer Distribution certificate

The `.pkg` wrapping the `.app` needs its own signature, separate
from the .app itself.

1. Same certificates page: click **+** again.
2. Under **Software**, choose **Mac Installer Distribution**.
   Click *Continue*.
3. Upload the same CSR. Continue.
4. Download the `.cer`. Double-click to install in Keychain.

Its Common Name looks like:

    3rd Party Mac Developer Installer: <Your Name> (<TEAMID>)

That's `APPLE_MAS_INSTALLER_SIGNING_IDENTITY` later.

---

## Step 4 — Export both certificates as `.p12` files

For each of the two certs:

1. Open **Keychain Access**.
2. Left sidebar: **login** → **My Certificates**.
3. Find the cert (expand it — there should be a private key
   nested underneath).
4. Right-click the certificate (not the private key). Choose
   **Export "3rd Party Mac Developer …"**.
5. Save as:
   - `repset-mas-app.p12` for the App Distribution cert
   - `repset-mas-installer.p12` for the Installer Distribution
     cert
6. Set a strong password and write it down. These are
   `APPLE_MAS_APP_CERTIFICATE_PASSWORD` and
   `APPLE_MAS_INSTALLER_CERTIFICATE_PASSWORD` respectively. They
   can be the same password if you prefer.
7. macOS will prompt for your login password to permit the export.

---

## Step 5 — Encode both `.p12`s for GitHub

GitHub secrets are text-only, so the binary `.p12` files have to
be base64-encoded. In Terminal:

```bash
base64 -i ~/Downloads/repset-mas-app.p12 | pbcopy
```

Paste that into the `APPLE_MAS_APP_CERTIFICATE` secret in the next
step. Then:

```bash
base64 -i ~/Downloads/repset-mas-installer.p12 | pbcopy
```

Paste into `APPLE_MAS_INSTALLER_CERTIFICATE`.

---

## Step 6 — Add the six secrets to GitHub

1. Go to <https://github.com/ivers9307-cyber/un1t-crm/settings/secrets/actions>.
2. **New repository secret** for each row below. Copy the values
   exactly — no extra whitespace, no quotes.

| Secret name                            | Value |
|----------------------------------------|-------|
| `APPLE_MAS_APP_CERTIFICATE`            | base64 of `repset-mas-app.p12` |
| `APPLE_MAS_APP_CERTIFICATE_PASSWORD`   | export password from Step 4 |
| `APPLE_MAS_APP_SIGNING_IDENTITY`       | App cert Common Name: `3rd Party Mac Developer Application: <Name> (<TEAMID>)` |
| `APPLE_MAS_INSTALLER_CERTIFICATE`      | base64 of `repset-mas-installer.p12` |
| `APPLE_MAS_INSTALLER_CERTIFICATE_PASSWORD` | export password from Step 4 |
| `APPLE_MAS_INSTALLER_SIGNING_IDENTITY` | Installer cert Common Name: `3rd Party Mac Developer Installer: <Name> (<TEAMID>)` |

The pre-existing `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`
secrets are reused — you don't need to recreate them.

---

## Step 7 — Trigger the App Store workflow

<https://github.com/ivers9307-cyber/un1t-crm/actions/workflows/desktop-appstore.yml>
→ *Run workflow* → *main* → *Run workflow*.

The run goes through:

1. Build the universal `.app` (unsigned)
2. Sign the `.app` with the Mac App Distribution cert +
   sandbox entitlements
3. Wrap it in a `.pkg` signed with the Installer cert
4. Validate against App Store rules locally (catches most
   rejection causes before upload)
5. Upload to App Store Connect via `altool`

Expected runtime: 8-12 min cold, 4-6 min with a warm Cargo cache.
The `altool` upload step is sometimes the slowest because of the
package size — be patient.

The run summary surfaces the next steps once upload succeeds.

---

## Step 8 — Submit for review in App Store Connect

1. Visit <https://appstoreconnect.apple.com/apps>, click into CF
   Studio, switch to the **macOS** platform.
2. Wait 5-15 min for Apple's automated processing of the upload
   to finish — the build appears under **TestFlight → Builds**
   when it's done. Status starts as *Processing*; refresh until
   it flips to *Ready to Submit*.
3. Create the App Store version you want to ship (e.g. 1.0.0).
   Fill in the macOS-specific metadata:
   - Description (can match iOS)
   - Mac screenshots: 2880×1800 (or any of Apple's accepted
     sizes). Screenshot the running Mac app from one of the
     reception studios once we have a build installed.
   - Support URL
   - Privacy policy URL (reuse <https://crm.repset.ie/privacy>)
4. Select the uploaded build for this version.
5. **Submit for Review**. Because the app record is already
   approved for unlisted distribution, the macOS platform
   inherits that — the build won't be discoverable through
   App Store search; only users with the unlisted link can find
   it.
6. First-time review for a new platform is typically 24-48 h.
   Subsequent updates usually clear in 12-24 h.

When the version goes live, ASC shows the unlisted link
(`https://apps.apple.com/...`) — share that with the reception
team and they install via the Mac App Store like any other app.

---

## Troubleshooting

**`codesign: errSecAuthFailed` or `unable to build chain`**

The App or Installer cert isn't in the keychain at sign time. The
workflow's "Set up signing keychain" step had an import failure.
Most common cause: the `APPLE_MAS_*_CERTIFICATE_PASSWORD` secret
doesn't match the `.p12` export password.

**`The application does not include sandbox entitlement`**

The entitlements file wasn't passed to `codesign`, or
`com.apple.security.app-sandbox` was set to false. Check the
"Embedded entitlements" output in the Sign step — sandbox should
be `1` (true).

**`altool` returns `Unauthorized`**

`APPLE_PASSWORD` is the regular Apple ID password instead of an
app-specific one. Generate a fresh app-specific password at
<https://appleid.apple.com/account/manage> → Sign-In and Security
→ App-Specific Passwords, then update the GitHub secret. (You may
already have one from the DMG signing setup — reuse it.)

**`altool` rejects with `Invalid Provisioning Profile`**

Mac App Store doesn't strictly require a provisioning profile for
distribution builds, but if your cert / bundle ID combination
doesn't match an App ID record on the developer portal, Apple
sometimes returns this as a generic error. Visit
<https://developer.apple.com/account/resources/identifiers/list>,
confirm `com.un1tdublin.crm` is registered as an App ID with
**Mac** capability enabled.

**Build "Ready to Submit" but I don't see the macOS platform tab in ASC**

Universal Purchase isn't enabled. Revisit Step 1 — the macOS
platform has to be explicitly added to the existing iOS app
record.

**Review rejected for missing `NSPrintInfo` or similar**

Apple's reviewer requires you declare any system permission usage
in `Info.plist`. The current shell only uses outbound network +
print (both declared in entitlements.plist). If a reviewer wants
a usage description string for either, edit
`desktop/src-tauri/Info.plist` to add the relevant `NS…UsageDescription`
key and resubmit.

---

## What this does NOT enable

This setup is for the **Mac App Store** distribution path only.
It produces a `.pkg` uploaded to ASC and installed via the App
Store on the end user's Mac.

If you ever want a non-App-Store DMG distribution again (e.g. for
a beta channel without going through review), the
`desktop-build.yml` + `desktop-finalize.yml` workflows are still
in the repo. See [`SIGNING_SETUP.md`](./SIGNING_SETUP.md) for that
path's setup.
