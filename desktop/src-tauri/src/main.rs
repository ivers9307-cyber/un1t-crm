// STUDIO-MAC.1 — CF Studio Mac shell entry point.
//
// Wraps crm.un1tdublin.com in a native macOS window via Tauri 2. The
// shell does five things:
//
//   1. Loads the web CRM in a WKWebView window sized for desk use.
//   2. Single-instance: launching the bundle a second time focuses
//      the existing window rather than spawning a duplicate session.
//   3. Auto-launches at boot (when the user opts in via System
//      Settings → Login Items, or programmatically via the autostart
//      plugin's API).
//   4. Checks for updates against a signed manifest at
//      crm.un1tdublin.com/desktop/updater.json and prompts the user
//      to install.
//   5. Persists cookies / localStorage across launches automatically
//      — WKWebView writes them to its own app-scoped data directory
//      under ~/Library/WebKit/CF Studio/, so the Supabase session +
//      the studio_session PIN cookie (STUDIO-PIN.3) survive a
//      restart.
//
// No application logic in here. The web CRM is the application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

fn main() {
    tauri::Builder::default()
        // Single-instance: opening the app twice focuses the existing
        // window. The closure runs when a second instance launches
        // (e.g. user double-clicks the dock icon or a `cfstudio://`
        // deep-link fires).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        // Auto-launch at boot. Defaults to disabled — the master
        // enables it for shared studio Macs from a one-line shell
        // command at install time. (We surface a UI toggle for this
        // in a follow-on PR.)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Updater. Pubkey + endpoints live in tauri.conf.json; this
        // line just wires the plugin into the Tauri Manager so the
        // app's JS can call `check()` / `download_and_install()`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            // No setup work — the window is declared in
            // tauri.conf.json and Tauri instantiates it for us.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CF Studio");
}
