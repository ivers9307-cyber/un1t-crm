# Repset — Mac shell

A native Mac app that wraps the web CRM at `crm.repset.ie` in a
WKWebView window. Lives in the dock, persists the user's session
across launches, and distributes through the **Mac App Store** as an
unlisted app alongside the existing iOS app (Universal Purchase on
`com.un1tdublin.crm`).

This is **Phase 2** of the studio-devices initiative — see
[`../docs/STUDIO_DEVICES_DESIGN.md`](../docs/STUDIO_DEVICES_DESIGN.md)
for the full design.

## What this is

A thin [Tauri 2](https://v2.tauri.app/) shell. The "app" is the
existing web CRM; the shell just provides the native window, the
dock icon, and single-instance behaviour. There's no application
code in here — un1t-crm is the application.

The shell runs in the macOS App Sandbox (mandatory for App Store
distribution). Its `entitlements.plist` requests only outbound
network access (to talk to crm.repset.ie) and print. No file
access, no camera, no microphone — the embedded web app inherits
the standard WKWebView surface.

Why Tauri instead of Electron:

- Bundle size: ~10MB vs Electron's ~120MB.
- Uses the system WKWebView, so the rendered web app picks up macOS
  native form controls + scrollbars + fonts. Looks like a Mac app,
  not a Chrome window.
- The Rust core is rock-solid for the small native surface
  (window management, auto-update, deep-link, autostart).

## How to ship a build (CI — App Store, the supported path)

You don't need Rust, Tauri, or Xcode on your laptop. The
**Desktop App Store** GitHub Actions workflow compiles the shell
on macos-latest, signs it with the Mac App Distribution +
Installer certs, wraps it in a `.pkg`, and uploads it directly to
App Store Connect for review.

To trigger:

- Actions tab on GitHub → *Desktop App Store* → *Run workflow* →
  *main* → *Run workflow*.

The workflow doesn't auto-fire on `desktop/**` pushes — App Store
builds count against Apple's review queue, so they're deliberate.

When the run finishes (~8-12 min cold, 4-6 min cached) the build
will appear in App Store Connect under the Repset macOS
platform within ~10 min of upload. From there:

1. Select the build for the version you want to ship.
2. Submit for review.
3. Once approved (typically 24-48 h first time, 12-24 h on
   updates), share the unlisted App Store link with the studio
   team. They install via Mac App Store like any other app.

### One-time setup

The workflow depends on six App Store GitHub secrets plus the
Universal Purchase wiring in ASC. See
[`APPSTORE_SETUP.md`](./APPSTORE_SETUP.md) for the step-by-step
Apple Developer portal + Keychain + ASC + GitHub secrets
walkthrough.

## Fallback: non-App-Store DMG distribution

The `Desktop build` + `Desktop finalize` workflows are still in
the repo for the outside-the-App-Store distribution path
(Developer ID + notarisation, downloaded DMG). See
[`SIGNING_SETUP.md`](./SIGNING_SETUP.md) for that path's setup.

We're not using this path right now because Apple's notarisation
queue stalled for >15 h on first-time submissions for our
Developer ID. If the queue health recovers and we ever want a
non-App-Store channel (e.g. for a beta build that skips review),
the workflows are ready.

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

Produces `src-tauri/target/release/bundle/dmg/Repset_*.dmg`.
Same unsigned status as the CI build. Don't ship an unsigned DMG to
the studio Macs once we're past initial testing; let the CI workflow
build it once signing is wired up.

## Plugins

The shell uses a single Tauri plugin:

- **`tauri-plugin-single-instance`** — opening the app twice focuses
  the existing window instead of launching a second one. Important
  for a dock app: clicking the dock icon a second time should not
  spawn a duplicate session.

The `tauri-plugin-autostart` and `tauri-plugin-updater` plugins
were removed in STUDIO-MAC.8. App Store sandbox forbids launch-agent
registration (autostart) and App Store policy forbids self-updating
apps (the App Store handles updates itself).

For auto-launch behaviour on the reception Mac: add Repset to
**System Settings → General → Login Items** manually. We may add
this back later via Apple's `SMAppService` API, which is the
sandbox-compatible way to register login items.

## Auth + session

The Mac shell uses the same Supabase auth + cookie session as the
web CRM. WKWebView persists cookies across launches in its own
sandboxed data container at
`~/Library/Containers/com.un1tdublin.crm/Data/Library/WebKit/`. The
shell's configured boot URL is
`https://crm.repset.ie/studio-login`
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
