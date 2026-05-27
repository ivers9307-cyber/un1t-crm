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

## Local development

You need Rust + Node installed. Then:

```bash
cd desktop
npm install
npm run tauri dev
```

This boots the shell pointing at the production URL
(`https://crm.un1tdublin.com`). For local development against a
local Next.js dev server, edit `src-tauri/tauri.conf.json`'s
`app.windows[0].url` to `http://localhost:3000`.

## Production build

```bash
npm run tauri build
```

Produces `src-tauri/target/release/bundle/dmg/CF Studio_*.dmg`.
**Unsigned** — the signing + notarisation flow is set up separately
via CI (`tauri-action` in a follow-on PR). Don't ship an unsigned DMG
to the studio Macs; macOS Gatekeeper will block it.

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
directory under `~/Library/WebKit/CF Studio/`. Reception staff log
in once and stay logged in — combined with the studio-device
PIN-auth foundation from Phase 0 ([STUDIO-PIN.1/2/3](../docs/STUDIO_DEVICES_DESIGN.md#phase-0)),
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
