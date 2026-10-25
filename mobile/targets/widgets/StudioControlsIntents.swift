// mobile/targets/widgets/StudioControlsIntents.swift
// WIDGET.1 Task 10 — Studio Controls' configuration (studio + up to 4 named
// devices, in order) and its four per-device-kind action AppIntents.
//
// Four SEPARATE optional parameters (device1..device4), not one array —
// WidgetKit's array-of-AppEntity configuration UI does not preserve a
// stable, staff-controlled ORDER the way four named slots do, and the spec
// requires "the first two in configured order" for the small size. Slot
// order IS the order.
//
// door.unlocked audit rows (Phase 1) already carry via:'widget' and the
// widget_token_id — that is the compensating control for every one of the
// four intents below firing directly, with no local confirmation beyond
// the door's own two-tap arm.
//
// 🔴 THE DEPENDENCY WIRING THIS FILE EXISTS TO CLOSE (see DeviceEntity.swift's
// header for the full explanation of why Task 9 could not do this itself):
// `DeviceOptionsProvider` below is the concrete `DynamicOptionsProvider`
// that keys off `StudioControlsConfigurationIntent`'s own `$studio`
// parameter via `@IntentParameterDependency<StudioControlsConfigurationIntent>
// (\.$studio)`. Verified against AppIntents.swiftinterface
// (iPhoneOS26.5.sdk): `IntentParameterDependency<Intent>.wrappedValue` is
// `IntentProjection<Intent>?`, and `IntentProjection` is `@dynamicMemberLookup`
// with `subscript<Value>(dynamicMember: KeyPath<Intent, Value>) ->
// Value.UnwrappedType where Value: _IntentValue` — so `studioParam?.studio`
// reads the CURRENTLY-SELECTED studio out of the in-progress configuration
// sheet, not a cached/first-stored one. Each `device1`...`device4` parameter
// below is wired to ONE SHARED instance of this provider, so all four
// device pickers re-scope together the moment `studio` changes.
//
// Each device picker also has to fall back sanely before a studio is
// picked: `results()` returns `.empty` when `studioParam?.studio` is nil,
// which WidgetKit's configuration UI renders as "no options yet" rather
// than erroring — the studio parameter is declared first and StudioEntity's
// own `suggestedEntities()` (Task 8) means it is very rarely actually nil
// in practice, but the type is Optional and this handles it correctly
// either way.

import AppIntents
import WidgetKit

struct StudioControlsConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Studio Controls"
    static var description = IntentDescription("Choose a studio and up to four devices.")

    // 🔴 OPTIONAL BECAUSE APPLE REQUIRES IT, not because nil is expected:
    // a `WidgetConfigurationIntent` must declare EVERY parameter optional.
    // The App Intents metadata processor says so outright — "Encountered a
    // non-optional type for parameter: … Conformance to the following
    // AppIntent protocols requires all parameter types to be optional:
    // AppIntents.WidgetConfigurationIntent".
    //
    // WIDGET.2 — this shipped NON-optional in 2.4.0 and made both widget
    // kinds unusable for everyone. A freshly placed widget has no studio, so
    // the system could not form a valid configuration at all: the Edit-Widget
    // picker dismissed itself mid-load and the tile fell back to its
    // placeholder, which reads as an empty box. It produces NO crash log, so
    // "no crash reports" is not evidence against it. Confirmed by reading the
    // shipped build's own metadata —
    // widgets.appex/Metadata.appintents/extract.actionsdata carried
    // `"name":"studio","isOptional":false` on BOTH configuration intents
    // while device1…4 correctly carried `true`.
    @Parameter(title: "Studio")
    var studio: StudioEntity?

    @Parameter(title: "Button 1", optionsProvider: DeviceOptionsProvider())
    var device1: DeviceEntity?
    @Parameter(title: "Button 2", optionsProvider: DeviceOptionsProvider())
    var device2: DeviceEntity?
    @Parameter(title: "Button 3", optionsProvider: DeviceOptionsProvider())
    var device3: DeviceEntity?
    @Parameter(title: "Button 4", optionsProvider: DeviceOptionsProvider())
    var device4: DeviceEntity?

    var devicesInOrder: [DeviceEntity] { [device1, device2, device3, device4].compactMap { $0 } }
}

/// The studio-scoped device picker DeviceEntity.swift's header documents and
/// defers to Task 10. Keyed to `StudioControlsConfigurationIntent.$studio`
/// specifically — this is why it lives in this file rather than
/// DeviceEntity.swift, which cannot name a concrete configuration intent
/// without creating an import cycle back to this one.
struct DeviceOptionsProvider: DynamicOptionsProvider {
    @IntentParameterDependency<StudioControlsConfigurationIntent>(\.$studio)
    var studioParam

    func results() async throws -> IntentItemCollection<DeviceEntity> {
        guard let studio = studioParam?.studio else { return .empty }
        // Delegates to the SAME fetch/decode/degraded-surfacing helper
        // `DeviceQuery.suggestedEntities()` uses for its context-free
        // fallback, so a degraded source reads identically on both paths
        // (DeviceEntity.swift, Task 9's `buildResult(locationId:)`).
        return try await DeviceQuery.buildResult(locationId: studio.id)
    }
}

/// Shared arm-window bookkeeping for the door's two-tap. Keyed per device id
/// so two different door buttons (unlikely, but the config allows it) never
/// share one arm state.
///
/// 🔴 WHERE THE ARM STATE LIVES, AND WHY: an `AppIntent`'s `perform()` runs
/// in a fresh, short-lived process instance each time a widget button is
/// tapped — there is no persistent object graph between one tap and the
/// next the way `doors/index.jsx`'s `useState` has across renders of a
/// mounted screen. The only storage that survives across separate
/// `perform()` invocations AND is visible to whichever process redraws the
/// tile afterwards is the App Group's `UserDefaults(suiteName: APP_GROUP)`
/// — the same container `WidgetAPI` already reads credentials from. A
/// timestamp (arm expiry) is written there on the first tap and read back
/// on the second; `WidgetCenter.reloadAllTimelines()` after arming is what
/// makes the tile's own timeline provider (Task 11) notice the armed state
/// and relabel the button before the second tap ever happens. This mirrors
/// doors/index.jsx's `setTimeout(() => setArmed(false), 3000)` window
/// exactly, just with the timer expressed as a deadline read at question-time
/// (`Date() < until`) rather than a scheduled callback — an extension has no
/// live run loop to fire a callback on once `perform()` returns.
enum ArmState {
    private static func key(_ deviceId: String) -> String { "armed_until_\(deviceId)" }

    static func arm(_ deviceId: String) {
        UserDefaults(suiteName: APP_GROUP)?.set(
            Date().addingTimeInterval(3).timeIntervalSince1970,
            forKey: key(deviceId)
        )
    }

    static func isArmed(_ deviceId: String) -> Bool {
        guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return false }
        let until = defaults.double(forKey: key(deviceId))
        guard until > 0 else { return false }
        return Date().timeIntervalSince1970 < until
    }

    static func disarm(_ deviceId: String) {
        UserDefaults(suiteName: APP_GROUP)?.removeObject(forKey: key(deviceId))
    }
}

struct UnlockDoorIntent: AppIntent {
    static var title: LocalizedStringResource = "Unlock Door"
    static var isDiscoverable: Bool = false // fired only from a widget button, never Siri/Shortcuts search

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Door ID") var doorId: String
    @Parameter(title: "Door Name") var doorName: String

    init() {}
    init(locationId: String, doorId: String, doorName: String) {
        self.locationId = locationId
        self.doorId = doorId
        self.doorName = doorName
    }

    func perform() async throws -> some IntentResult {
        // Two-stage arm→fire, same 3s window as doors/index.jsx. The FIRST
        // tap only arms; the SECOND tap (within the window) fires. This is a
        // UI affordance only — server-side re-authorisation on every call is
        // the actual gate (studio_management + the per-user door allowlist,
        // src/app/api/studio-management/unlock/route.js), same as every
        // other intent in this file. Nothing here re-checks or caches
        // authorisation; the extension renders and calls, it never decides.
        guard ArmState.isArmed(doorId) else {
            ArmState.arm(doorId)
            WidgetCenter.shared.reloadAllTimelines()
            return .result()
        }
        ArmState.disarm(doorId)
        _ = try? await WidgetAPI.call(
            path: "/api/studio-management/unlock",
            locationId: locationId,
            method: "POST",
            body: ["door_id": doorId, "door_name": doorName]
        )
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
        // RESOLVED 2026-09-10 by measurement: keep awaiting the response.
        //
        // POST /api/studio-management/unlock round-trips in about **3 seconds**
        // on a real device against deployed Phase 1 (the route fans out to
        // UniFi Access synchronously). Awaiting is the right shape, for a
        // reason that is easy to get backwards:
        //
        // Fire-and-forget from an extension is NOT the safer option. When the
        // system reclaims an extension process it cancels that process's
        // in-flight URLSession requests — so a "fire and return immediately"
        // unlock can simply never reach the server, silently, while the button
        // reports success. A slow unlock that works beats a fast one that
        // sometimes does nothing, especially when someone is at a door.
        //
        // Server-side accept-and-queue would genuinely cut the round trip, but
        // it moves the failure somewhere nobody is looking: a queued unlock
        // that fails afterwards leaves the same person at the same door with a
        // button that already said yes.
        //
        // So: await, with WidgetAPI's timeout set BELOW the system budget (6s,
        // twice the measured typical) so a slow call fails visibly instead of
        // taking the whole process down with it.
        //
        // 🔴 The one observation that reopens this: if the device pass shows
        // the extension being KILLED mid-unlock rather than returning a
        // timeout, the answer is NOT a shorter timeout here — below ~4s a
        // normal unlock starts failing. It is to make the unlock route answer
        // on UniFi's ACK rather than on full confirmation, cutting the round
        // trip instead of racing it.
    }
}

/// Last-known on/off (or playing/paused) state THIS WIDGET last SENT for a
/// device — one bool per device id, in the SAME App Group container and
/// the SAME per-device-id keying scheme as `ArmState` above, for the same
/// reason: `perform()` runs in a fresh process per tap, so the only thing
/// durable enough to carry a belief from one tap to the next (and out to
/// whichever process redraws the tile afterwards) is `UserDefaults(suiteName:
/// APP_GROUP)`.
///
/// 🔴 THIS IS OPTIMISTIC LOCAL STATE, NOT DEVICE TRUTH — say so here rather
/// than let a comment imply otherwise. Nothing in this file ever asks the
/// Sonos player, the Shelly plug, or the AC unit what it is actually doing;
/// Studio Controls' timeline is built to make ZERO network calls
/// (StudioControlsWidget.swift's header), and none of the three action
/// routes below is a stateless toggle the SERVER could resolve instead —
/// `POST /api/shelly/devices/{id}/toggle` takes an explicit `state` from
/// the caller despite its name, `POST /api/sonos/control` has no
/// `playpause` action, and AC is two separate `turn-on`/`turn-off` routes.
/// So the moment someone flips a device from the wall switch, the Sonos
/// app, or the CRM panel, this store goes stale: the widget still believes
/// whatever IT last sent, the next tap sends what IT believes is the
/// opposite, and that can land as a no-op against the device's REAL
/// state — which reads to the operator as "I tapped Play/Pause and
/// nothing happened," i.e. a broken button, when really the belief is
/// just out of date. Two real fixes if that proves to bite often enough:
///   1. A genuine stateless toggle server-side (a `playpause`/`toggle`
///      action) — the server talks to the device directly and always
///      knows, so the widget never has to guess.
///   2. State added to `GET /api/widget/devices` plus turning Studio
///      Controls' timeline into one that actually fetches on refresh —
///      a bigger change, since that route and this timeline are both
///      deliberately state-free/network-free today.
/// Until one of those lands, "the last thing we sent" is the best
/// available approximation — chosen over "the last thing we RENDERED"
/// specifically so a failed send (see `isOn`'s caller below) never moves
/// the belief.
enum ToggleState {
    private static func key(_ deviceId: String) -> String { "toggle_on_\(deviceId)" }

    /// Defaults to `false` (off/paused) when nothing has been sent yet, so
    /// a never-tapped button's first tap always turns ON — per Task 10's
    /// instructions, the overwhelmingly common gym-floor action.
    static func isOn(_ deviceId: String) -> Bool {
        UserDefaults(suiteName: APP_GROUP)?.bool(forKey: key(deviceId)) ?? false
    }

    static func setOn(_ deviceId: String, _ on: Bool) {
        UserDefaults(suiteName: APP_GROUP)?.set(on, forKey: key(deviceId))
    }
}

struct ToggleAcIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle AC"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Device ID") var deviceId: String

    init() {}
    init(locationId: String, deviceId: String) {
        self.locationId = locationId
        self.deviceId = deviceId
    }

    func perform() async throws -> some IntentResult {
        // Toggle by OUR OWN last-SENT state (`ToggleState` above) — read
        // fresh here, at perform() time, not trusted from a value the view
        // captured when the button was drawn.
        let turningOn = !ToggleState.isOn(deviceId)
        let path = turningOn
            ? "/api/studio-management/ac/devices/\(deviceId)/turn-on"
            : "/api/studio-management/ac/devices/\(deviceId)/turn-off"
        if (try? await WidgetAPI.call(path: path, locationId: locationId, method: "POST")) != nil {
            // Write the new belief ONLY on success — a thrown/failed call
            // (offline, timeout, non-2xx) must leave the stored value
            // exactly as it was, or one network blip permanently inverts
            // this button: every future tap would keep sending the same
            // action instead of alternating.
            ToggleState.setOn(deviceId, turningOn)
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct TogglePlugIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Plug"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Device ID") var deviceId: String

    init() {}
    init(locationId: String, deviceId: String) {
        self.locationId = locationId
        self.deviceId = deviceId
    }

    func perform() async throws -> some IntentResult {
        let turningOn = !ToggleState.isOn(deviceId)
        if (try? await WidgetAPI.call(
            path: "/api/shelly/devices/\(deviceId)/toggle",
            locationId: locationId,
            method: "POST",
            body: ["state": turningOn ? "on" : "off"]
        )) != nil {
            // Success only — see ToggleAcIntent's identical comment above.
            ToggleState.setOn(deviceId, turningOn)
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct ToggleSpeakerIntent: AppIntent {
    static var title: LocalizedStringResource = "Play/Pause Speaker"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Player ID") var playerId: String

    init() {}
    init(locationId: String, playerId: String) {
        self.locationId = locationId
        self.playerId = playerId
    }

    func perform() async throws -> some IntentResult {
        // The widget button toggles by its OWN last-SENT state
        // (`ToggleState` above, read fresh at perform() time) — NOT a live
        // query issued from inside this intent to ask Sonos what it is
        // actually doing right now, and NOT the value the view happened
        // to render when the button was drawn. See ToggleState's header
        // for why this is an approximation, not device truth.
        let willPlay = !ToggleState.isOn(playerId)
        // An unknown player_id answers 404 `not_found`; a stale group_id
        // answers 409 `regrouped`. WidgetAPIError.server(status:message:code:)
        // carries both `code` and the server's own `message` distinctly —
        // deliberately not conflated here or anywhere downstream. `try?`
        // still discards the outcome for this direct-fire button (matching
        // the other two intents in this file); Task 11's timeline is
        // where a surfaced error, if ever added, would need to read that
        // `code` back out rather than pattern-matching `message` text.
        if (try? await WidgetAPI.call(
            path: "/api/sonos/control",
            locationId: locationId,
            method: "POST",
            body: ["player_id": playerId, "action": willPlay ? "play" : "pause"]
        )) != nil {
            // Success only — see ToggleAcIntent's identical comment above.
            ToggleState.setOn(playerId, willPlay)
        }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
