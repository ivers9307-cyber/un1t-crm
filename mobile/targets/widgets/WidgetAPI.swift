// mobile/targets/widgets/WidgetAPI.swift
// WIDGET.1 — the extension's ONLY network surface. Every AppIntent and
// TimelineProvider in this target calls through here. It reads a token from
// the App Group (written by mobile/lib/widget-bridge.js — see that file's
// header for the storage key contract) and calls exactly one route; it
// makes no authorization decisions of its own, mirroring mobile/lib/api.js
// on the RN side and the "extension renders and calls, never decides"
// exit-gate rule this whole plan is built around.
//
// Every route below answers the repo's standard envelope, but "standard"
// is not "uniform": most nest their payload under `data`
// (home-queue/count, widget/devices, the AC turn-on/off routes), some do
// not (sonos/control answers `{success, groups}`; shelly toggle answers
// `{success, device, applied, ...}`; unlock answers bare `{success: true}`
// on success). `call()` deliberately returns the raw top-level dictionary
// rather than assuming a `data` key exists — callers dig out whatever
// shape their own route actually returns. What IS uniform, and what this
// file leans on, is `{success: false, error: <string>, code?: <string>}`
// on failure.

import Foundation

// WIDGET.1 — the App Group the app and its widget extension share.
//
// 🔴 KNOWN GAP, not silently accepted: mobile/app.config.js's
// `ios.entitlements` comment is explicit that this id is env-switched IN
// LOCKSTEP with the bundle identifier — LEGACY_APP=1 builds
// (com.un1tdublin.crm) declare `group.com.un1tdublin.crm.widgets`, the
// public build (ie.repset.app) declares `group.ie.repset.widgets` — and
// mobile/lib/widget-bridge.js resolves it at RUNTIME from
// Constants.expoConfig for exactly that reason ("a hard-coded id would
// make the bridge open a group the legacy app does not hold"). This
// extension has no JS runtime and no Constants to read, and
// @bacons/apple-targets only mirrors the App Group into the GENERATED
// entitlements plist per build flavour — it does not template this Swift
// source, which is the same file on disk for both builds. So the literal
// below is correct for the public ie.repset.app build only; a
// LEGACY_APP=1 widget would carry an entitlements file for
// `group.com.un1tdublin.crm.widgets` while this code asks
// UserDefaults(suiteName:) for a DIFFERENT group it is not entitled to —
// which reads back empty, not an error, so storedStudios() would silently
// return [] on that build. Confirmed there is no public iOS API to read a
// process's own entitlements back (SecTaskCopyValueForEntitlement exists
// in the Security framework binary but ships with no iOS header — using
// it undeclared is private-API territory, not a fix worth making for
// this). The real fix is a companion change to
// mobile/targets/widgets/expo-target.config.js (inject the resolved
// App Group into this target's Info.plist from `_config`, then read it
// here via Bundle.main) — out of scope for this file; flagged for
// whoever wires the legacy build's widget rather than fixed here.
/// The App Group this build is actually entitled to.
///
/// The Swift source is byte-identical across both builds, but the App Group is
/// NOT: the plugin mirrors an env-switched id into each flavour's generated
/// entitlements (`group.ie.repset.widgets` for ie.repset.app,
/// `group.com.un1tdublin.crm.widgets` for com.un1tdublin.crm). A hard-coded
/// literal is therefore correct for exactly one of the two, and the legacy
/// widget would silently read an empty container — the same defect the JS side
/// avoids by resolving from the manifest.
///
/// `containerURL(forSecurityApplicationGroupIdentifier:)` returns nil for a
/// group the process is not entitled to, so asking the filesystem which one we
/// hold is a public-API way to get the right answer in both builds. (The
/// entitlement can also be read directly via SecTaskCopyValueForEntitlement,
/// but that symbol ships with no public iOS header — declaring it by hand is
/// private-API use and an App Store rejection risk. Not worth it for this.)
///
/// Ordered most-likely-first; the list is short and both entries are real.
let APP_GROUP: String = {
    let candidates = [
        "group.ie.repset.widgets",
        "group.com.un1tdublin.crm.widgets",
    ]
    let fm = FileManager.default
    for id in candidates
    where fm.containerURL(forSecurityApplicationGroupIdentifier: id) != nil {
        return id
    }
    // Nothing resolved: the entitlement is missing or misconfigured. Return the
    // public id so behaviour is defined — UserDefaults(suiteName:) will hand
    // back nil and the widget renders its "not set up" state, which is the
    // right failure for a container we cannot open.
    return candidates[0]
}()

// REPSET-P6.S2 mirror — mobile/app.config.js's `extra.apiBaseUrl` resolves
// EXPO_PUBLIC_API_BASE_URL first and falls back to this same literal. The
// extension has no Expo/JS runtime to read that override from (Constants
// is a JS-runtime API), so a staging override never reaches the widget —
// acceptable per Task 7's own note: this repo's mobile app only ever
// points at production or an ad-hoc Vercel preview, never a long-lived
// staging widget deployment. One base URL is correct for BOTH iOS builds:
// the legacy (com.un1tdublin.crm) and public (ie.repset.app) bundles talk
// to the same crm.repset.ie API — only the App Group above splits by
// build, never the API host.
let API_BASE = "https://crm.repset.ie"

let STUDIOS_KEY = "repset_widget_studios"

/// Mirrors mobile/lib/widget-bridge.js's `StoredStudioCredential` — same
/// field names, same JSON shape, so JSONDecoder reads what
/// storeWidgetCredential() wrote with no translation layer to drift.
struct StoredStudio: Codable, Identifiable {
    var id: String { locationId }
    let locationId: String
    let locationName: String
    let tokenId: String
    let token: String

    enum CodingKeys: String, CodingKey {
        case locationId, locationName, tokenId, token
    }
}

enum WidgetAPIError: Error {
    /// No stored credential for this locationId — the widget was removed
    /// from its studio, or never configured.
    case noCredential
    /// Never reached the server at all (offline, DNS, TLS, or the
    /// `timeoutInterval` below firing before a response arrived).
    case transport(String)
    /// The server answered outside 200...299. `code` is the route's own
    /// machine-readable tag when it sent one (e.g. sonos/control's
    /// `not_found` vs `regrouped` — see the call-site comment below);
    /// `message` is always the server's own `error` string, never
    /// replaced with a generic one, per Task 7's instructions.
    case server(status: Int, message: String, code: String?)
}

enum WidgetAPI {
    /// Every studio this device has minted a widget credential for.
    /// Mirrors mobile/lib/widget-bridge.js's listStoredStudios() — same
    /// key, same JSON shape. Reading this never makes a network call.
    static func storedStudios() -> [StoredStudio] {
        guard let defaults = UserDefaults(suiteName: APP_GROUP),
              let raw = defaults.string(forKey: STUDIOS_KEY),
              let data = raw.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([StoredStudio].self, from: data)) ?? []
    }

    static func token(forLocation locationId: String) -> String? {
        storedStudios().first { $0.locationId == locationId }?.token
    }

    // WIDGET.1 — timeout budget.
    //
    // Neither system time budget this file's callers run under is
    // published by Apple: an interactive widget button's
    // `AppIntent.perform()` and a `TimelineProvider`'s timeline refresh are
    // both time-boxed, and the plan this file implements says so plainly
    // (Task 16's real-device measurement against deployed Phase 1 is
    // still owed). Inheriting URLSession's 60s default would let a single
    // slow request outlive whichever budget is tighter, and when that
    // budget expires the OS does not just cancel the request — it kills
    // the whole extension process, which is a worse failure than this
    // call returning a timeout error the caller can render. 8 seconds is
    // chosen as a conservative middle point: short enough to almost
    // certainly return (or safely fail) before either budget is spent
    // end-to-end even on a gym's ordinary WiFi, long enough that a normal
    // request in flight is not routinely cut off. Revisit this number,
    // not the mechanism, once Task 16's measurement lands — it may need
    // to be shorter specifically for the door-unlock path (see `call`'s
    // doc comment below).
    private static let requestTimeout: TimeInterval = 8

    /// GET or POST `path` against the studio's own widget credential.
    /// `body` is JSON-encoded when present; nil for a GET.
    ///
    /// 🔴 Door-unlock latency is an OWED measurement (needs a real device
    /// against deployed Phase 1 — see the plan's Task 16). Until it lands,
    /// this function is deliberately the plain request/response path only:
    /// it sends the request, awaits the ONE response UnlockDoorIntent's
    /// route (`POST /api/studio-management/unlock`) returns, and resolves
    /// or throws from that — no fire-and-forget return on submission, no
    /// separate block-until-the-door-physically-opens polling loop. Which
    /// of those two shapes the unlock button actually wants is exactly
    /// what the owed measurement decides, and that decision belongs to
    /// Task 10 where UnlockDoorIntent is written, not here. Do not read
    /// this function returning as "the door opened" or "the door
    /// definitely didn't" beyond what the server's own response says.
    static func call(
        path: String,
        locationId: String,
        method: String = "GET",
        body: [String: Any]? = nil
    ) async throws -> [String: Any] {
        guard let token = token(forLocation: locationId) else {
            throw WidgetAPIError.noCredential
        }
        guard let url = URL(string: API_BASE + path) else {
            throw WidgetAPIError.transport("bad URL: \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = requestTimeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            guard let encoded = try? JSONSerialization.data(withJSONObject: body) else {
                throw WidgetAPIError.transport("could not encode request body")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = encoded
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw WidgetAPIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw WidgetAPIError.transport("no HTTP response")
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200...299).contains(http.statusCode) else {
            // Surface the server's own `error` string rather than a
            // generic one — the server writes these in the operator's
            // language deliberately. `code` rides alongside it so a
            // caller can tell apart e.g. sonos/control's 404 `not_found`
            // (unknown player_id) from its 409 `regrouped` (stale
            // group_id) without parsing `message` text — both distinct
            // from each other AND from that route's other 409 codes
            // (`not_connected`, `no_group`, `fixed_volume`, `no_content`),
            // which share the same HTTP status.
            let message = (json?["error"] as? String) ?? "HTTP \(http.statusCode)"
            let code = json?["code"] as? String
            throw WidgetAPIError.server(status: http.statusCode, message: message, code: code)
        }
        return json ?? [:]
    }
}
