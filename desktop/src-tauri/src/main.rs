// STUDIO-MAC.1 — Repset Mac shell entry point.
//
// Wraps crm.repset.ie in a native macOS window via Tauri 2. The
// shell does three things:
//
//   1. Loads the web CRM in a WKWebView window sized for desk use.
//   2. Single-instance: launching the bundle a second time focuses
//      the existing window rather than spawning a duplicate session.
//   3. Persists cookies / localStorage across launches automatically
//      — WKWebView writes them to its sandboxed data container
//      under ~/Library/Containers/com.un1tdublin.crm/Data/Library/
//      WebKit/, so the Supabase session + the studio_session PIN
//      cookie (STUDIO-PIN.3) survive a restart.
//
// STUDIO-MAC.8 — autostart + updater plugins removed for Mac App
// Store distribution. Reception staff who want Repset to open at
// boot add it to Login Items via System Settings → General → Login
// Items. Updates are delivered through the App Store.
//
// No application logic in here. The web CRM is the application.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Single-instance: opening the app twice focuses the existing
        // window. The closure runs when a second instance launches
        // (e.g. user double-clicks the dock icon or a `repset://`
        // deep-link fires).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .setup(|_app| {
            // No setup work — the window is declared in
            // tauri.conf.json and Tauri instantiates it for us.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Repset");
}
