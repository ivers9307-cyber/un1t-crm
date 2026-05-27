# CF Studio — Mac shell

A native Mac app that wraps the web CRM at `crm.un1tdublin.com` in a
WKWebView window. Lives in the dock, persists the user's session
across launches, supports auto-launch on boot, and ships as a signed
+ notarised DMG with auto-update.

This is **Phase 2** of the studio-devices initiative — see
[`../docs/STUDIO_DEVICES_DESIGN.md`](../docs/STUDIO_DEVICES_DESIGN.md)
for the full design.

## What this is

A thin [Tauri 2](https://v2.tauri.app/) shell. The "app" is the
existing web CRM; the shell just provides the native window, the
dock icon, single-instance behaviour, auto-launch, and the updater
mechanism. There's no application code in here — un1t-crm is the
application.

Why Tauri instead of Electron:

- Bundle size: ~10MB vs Electron's ~120MB.
- Uses the system WKWebView, so the rendered web app picks up macOS
  native form controls + scrollbars + fonts. Looks like a Mac app,
  not a Chrome window.
- The Rust core is rock-solid for the small native surface
  (window management, auto-update, deep-link, autostart).

## How to get a DMG (CI — the supported path)

You don't need Rust, Tauri, or Xcode on your laptop. The
**Desktop build** GitHub Actions workflow compiles the shell on
macos-latest and uploads the DMG as a downloadable artefact.

To trigger a build:

- **Automatic** — any push to `main` that touches `desktop/**`.
- **On demand** — go to the Actions tab on GitHub →
  *Desktop build* → *Run workflow*.

When the run finishes (~5–8 min cold, ~2–3 min cached), open the
run page, scroll to *Artifacts*, and download `cf-studio-mac-<run#>`.
That zip contains the universal DMG (works on both Apple Silicon
and Intel Macs).

The DMG is **signed + notarised** once the six `APPLE_*` secrets
are configured on the repo (see
[`SIGNING_SETUP.md`](./SIGNING_SETUP.md) for the one-time setup —
step-by-step Apple Developer portal + Keychain + GitHub secrets
walkthrough). Until those secrets are added, the workflow falls
back to producing an unsigned DMG which requires the right-click →
*Open* dance to bypass Gatekeeper on first launch.

## Local development (optional — if you already have Rust)

If you do have Rust on your machine and want hot-reload while
editing the shell:

```bash
cd desktop
npm install
npm run dev
```

If `cargo` isn't installed, install it once with rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

The first run takes 3–8 minutes (Tauri pulls + compiles all Rust
deps). Subsequent runs are seconds.

For local development against a local Next.js dev server, edit
`src-tauri/tauri.conf.json`'s `app.windows[0].url` to
`http://localhost:3000`.

## Production build (locally, if you want)

```bash
npm run build
```

Produces `src-tauri/target/release/bundle/dmg/CF Studio_*.dmg`.
Same unsigned status as the CI build. Don't ship an unsigned DMG to
the studio Macs once we're past initial testing; let the CI workflow
build it once signing is wired up.

## Plugins

The shell uses three Tauri plugins:

- **`tauri-plugin-single-instance`** — opening the app twice focuses
  the existing window instead of launching a second one. Important
  for a dock app: clicking the dock icon a second time should not
  spawn a duplicate session.
- **`tauri-plugin-autostart`** — registers the shell as a login
  item that launches at boot. Suits the always-on reception Mac.
  The user can disable this from System Settings → General →
  Login Items.
- **`tauri-plugin-updater`** — periodic check against a JSON
  manifest at `crm.un1tdublin.com/desktop/updater.json`. Pubkey
  pinned in `tauri.conf.json`; private key lives in CI secrets only.

## Auth + session

The Mac shell uses the same Supabase auth + cookie session as the
web CRM. WKWebView persists cookies across launches in its own data
directory under `~/Library/WebKit/CF Studio/`. The shell's
configured boot URL is `https://crm.un1tdublin.com/studio-login`
(set in `src-tauri/tauri.conf.json` →
`app.windows[0].url`), so paired Macs always land at the PIN entry
pad. Combined with the studio-device PIN-auth foundation from
Phase 0 ([STUDIO-PIN.1/2/3](../docs/STUDIO_DEVICES_DESIGN.md#phase-0)),
the typical flow is:

1. Master pairs the Mac at `/admin/studio-devices` (one-time).
2. Mac shell launches into `/studio-login` (the PIN entry page).
3. Staff enters their 4-digit PIN.
4. Cookie minted; navigates to the staffer's `home_screen_path`.
5. After 5 min idle, the lock overlay covers the UI until PIN
   re-entry.

No new auth code in the shell itself.

## What this PR does NOT include

- Code-signing / notarisation pipeline (separate PR — needs Apple
  Developer ID + CI secrets configured).
- CI workflow for automatic DMG builds on every `main` merge.
- Updater manifest signing key generation.
- App icon (`src-tauri/icons/*.png` — needs design assets).

Each is a follow-on PR.

## Structure

```
desktop/
├── README.md             # this file
├── package.json          # Node side; thin — just the tauri CLI
├── src/
│   └── index.html        # loader (immediately navigates to the prod URL)
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json   # window + plugin config
    ├── icons/            # app icon variants (TBD)
    └── src/
        └── main.rs       # Rust entry — single-instance + plugins
```
