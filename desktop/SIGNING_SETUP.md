# Signing + Notarising the Mac DMG

Step-by-step setup so the CI workflow produces a signed and
notarised DMG that opens on any Mac without the right-click →
Open Gatekeeper dance.

You only do this once. After the six GitHub secrets are in place,
every workflow run automatically signs + notarises.

---

## What you'll end up with

By the end of this guide:

- A **Developer ID Application** certificate exported from Keychain
  as a `.p12` file.
- An **app-specific password** for the Apple ID account that owns
  the developer membership.
- Six secrets in the un1t-crm GitHub repo:
  - `APPLE_CERTIFICATE` (base64-encoded `.p12`)
  - `APPLE_CERTIFICATE_PASSWORD` (the password you set on the
    `.p12` during export)
  - `APPLE_SIGNING_IDENTITY` (the cert's Common Name)
  - `APPLE_ID` (your Apple ID email)
  - `APPLE_PASSWORD` (the app-specific password — NOT your normal
    Apple ID password)
  - `APPLE_TEAM_ID` (the 10-character team identifier)

The next workflow run after these are added will produce a
signed + notarised DMG. Members of the studio can just download
it and double-click.

---

## Step 1 — Confirm you have an Apple Developer Program membership

You almost certainly already have this (the iOS Repset app needs
it), but to check:

1. Visit <https://developer.apple.com/account>.
2. Sign in with your Apple ID.
3. You should see "Membership" in the sidebar with a status of
   "Active." If not, you'll need to enrol (~$99/year).

Note your **Team ID** while you're there — it's listed under
"Membership details." It's a 10-character alphanumeric string like
`A1B2C3D4E5`. You'll need this for one of the GitHub secrets.

---

## Step 2 — Generate a Developer ID Application certificate

This is a DIFFERENT certificate from the one your iOS app uses.
iOS apps are signed with an "Apple Distribution" cert; Macs that
distribute outside the App Store need "Developer ID Application."

1. Go to <https://developer.apple.com/account/resources/certificates/list>.
2. Click the **+** button (top-right) to add a new certificate.
3. Under **Software**, choose **Developer ID Application**.
   Click *Continue*.
4. It asks for a Certificate Signing Request (CSR). To generate one:
   - Open **Keychain Access** on your Mac.
   - Menu: **Keychain Access → Certificate Assistant → Request a
     Certificate from a Certificate Authority…**
   - Email: your Apple ID email.
   - Common Name: leave as the default (your name).
   - CA Email: leave blank.
   - Choose **Saved to disk**, then **Continue**.
   - Save the resulting `CertificateSigningRequest.certSigningRequest`
     file somewhere you can find it.
5. Back in the browser, upload that CSR file. Click *Continue*.
6. Download the resulting `.cer` file. Double-click it to install
   it in your Keychain.

---

## Step 3 — Export the certificate as a `.p12`

1. Open **Keychain Access** again.
2. In the left sidebar, choose **login** → **My Certificates**.
3. Find the certificate named **Developer ID Application: <your name>
   (<TEAMID>)**. Expand it — there should be a private key nested
   underneath.
4. Right-click the certificate (not the private key). Choose
   **Export "Developer ID Application: …"**.
5. Save it as `repset-signing.p12`.
6. When prompted for a password, **set a strong password** and
   write it down — this is `APPLE_CERTIFICATE_PASSWORD` later.
7. macOS will prompt for your login password to permit the export.

You now have a `.p12` file you'll upload to GitHub secrets in
Step 5.

While you're here, also note the certificate's **Common Name** —
it's the full string `Developer ID Application: <Name> (<TEAMID>)`.
Click the certificate and look at the **Common Name** field. Copy
that whole string exactly — that's `APPLE_SIGNING_IDENTITY` later.

---

## Step 4 — Create an app-specific password for notarisation

Apple's `notarytool` (which the workflow calls to submit the
signed DMG for notarisation) authenticates via an **app-specific
password**. This is NOT your normal Apple ID password.

1. Go to <https://appleid.apple.com/account/manage>.
2. Sign in.
3. Under **Sign-In and Security**, click **App-Specific
   Passwords**.
4. Click **Generate an app-specific password**.
5. Label it something memorable — e.g. `Repset notarytool`.
6. Apple shows you the password ONCE in the format
   `abcd-efgh-ijkl-mnop`. Copy it now — you can't see it again.

That's `APPLE_PASSWORD` later.

---

## Step 5 — Encode the `.p12` for GitHub

GitHub secrets are text-only, so the binary `.p12` has to be
base64-encoded before you paste it in. Open Terminal and run:

```bash
base64 -i ~/Downloads/repset-signing.p12 | pbcopy
```

This puts the base64 string on your clipboard. (Replace the path
if you saved the `.p12` somewhere else.)

---

## Step 6 — Add the six secrets to GitHub

1. Go to <https://github.com/ivers9307-cyber/un1t-crm/settings/secrets/actions>.
   (Settings → Secrets and variables → Actions.)
2. Click **New repository secret** for each of the six below.
   Copy the values exactly — no extra whitespace, no quotes.

| Secret name                  | Value |
|------------------------------|-------|
| `APPLE_CERTIFICATE`          | The base64 string from Step 5 (paste from clipboard) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` in Step 3 |
| `APPLE_SIGNING_IDENTITY`     | The cert's Common Name from Step 3: `Developer ID Application: <Name> (<TEAMID>)` |
| `APPLE_ID`                   | Your Apple ID email |
| `APPLE_PASSWORD`             | The app-specific password from Step 4 (format `abcd-efgh-ijkl-mnop`) |
| `APPLE_TEAM_ID`              | The 10-character Team ID from Step 1 |

---

## Step 7 — Trigger a build

The desktop pipeline is split into **two** workflows:

1. **Desktop build** — compiles, signs the `.app`, and submits it
   to Apple's notarisation queue. Exits in 5–10 min regardless of
   how busy Apple is.
2. **Desktop finalize** — waits for Apple to accept the
   submission, staples the ticket, packages a signed + notarised
   DMG. Run manually after the build finishes.

The split exists because first-time submissions on a fresh
Developer ID can sit in Apple's queue for 30–60+ min, and we
don't want a single workflow holding a `macos-latest` minute for
that long. After a few successful notarisations on this account
the typical wait drops to 1–5 min, but the split stays — it's
strictly cheaper to retry.

### Run the build workflow

Either:

- **On demand**: <https://github.com/ivers9307-cyber/un1t-crm/actions/workflows/desktop-build.yml>
  → *Run workflow* → *main* → *Run workflow*.
- **By pushing**: any commit to `main` that touches `desktop/**`
  fires it automatically.

When the run finishes, open its summary panel — you'll see the
notarisation submission UUID and the build run id. Copy the
**run id** (the numeric id at the end of the run's URL, e.g.
`.../actions/runs/12345678901` → `12345678901`).

### Run the finalize workflow

Go to <https://github.com/ivers9307-cyber/un1t-crm/actions/workflows/desktop-finalize.yml>
→ *Run workflow* → *main*. Paste the build run id into
`build_run_id` and hit *Run workflow*.

Finalize will:

- Pull the signed `.app` and submission UUID from the build run
- Wait on Apple's notarisation result (up to 60 min before timing
  out)
- Staple the notarisation ticket onto the `.app`
- Package a fresh DMG containing the stapled `.app`
- Sign the DMG, submit it for its own notarisation pass, staple it
- Upload the final DMG + stapled `.app` as artefacts

Download the artefact from the finalize run page. Open the DMG —
it should launch without the right-click → Open dance.

If finalize times out waiting on Apple, just rerun it with the
same `build_run_id`. `notarytool wait` returns instantly once
Apple has finished processing the submission.

---

## Troubleshooting

**`The signature is invalid` or `Code signing failed`**
- The `.p12` and the password don't match. Re-export from Keychain
  (Step 3) and update both secrets.
- Make sure `APPLE_SIGNING_IDENTITY` is the EXACT Common Name —
  including the `: ` separator and the parenthesised Team ID.

**`notarytool` returns `Invalid Credentials`**
- `APPLE_PASSWORD` is the regular Apple ID password instead of the
  app-specific one. Generate an app-specific password (Step 4)
  and update the secret.

**`The hardened runtime is not enabled`**
- Tauri 2 enables this automatically for macOS bundles. If you see
  this error, the workflow probably hasn't picked up the
  `APPLE_SIGNING_IDENTITY` secret — check the secret name spelling
  matches exactly (case-sensitive).

**`Could not find an Apple ID configured`**
- One of `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` is missing
  from repo secrets. Check the spelling — these are case-sensitive.

**The build succeeds but the DMG still says "unidentified developer"**
- Notarisation submission probably timed out / failed silently.
  Check the workflow log for the "Notarising" step output —
  notarytool prints a UUID and a status. If status is `Invalid`,
  run `xcrun notarytool log <uuid> --apple-id <email> --password <app-pw> --team-id <teamid>`
  locally to see Apple's specific complaint.

---

## What this enables

Once the six secrets are in place, every DMG produced by the
workflow is **signed + notarised**. Practical effects:

- macOS Gatekeeper opens it like any commercial app — no warning,
  no right-click dance.
- The shell can phone home to Apple's revocation servers and
  silently refuse to launch if the certificate is ever revoked.
- The auto-update flow (next PR) works end-to-end, because
  Tauri's updater requires the running app to be signed.

## What this does NOT enable

This is signing + notarisation for distribution OUTSIDE the App
Store. The DMG is hosted by us, the user downloads it from a known
URL, and macOS trusts it because Apple has notarised it. The Mac
shell never goes through App Review.

If you ever decide to put Repset on the Mac App Store (a
fundamentally different distribution path), you'd need a
"Mac App Store Distribution" certificate and a separate App
Store Connect record — out of scope here.
