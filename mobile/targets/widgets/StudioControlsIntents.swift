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

    @Parameter(title: "Studio")
    var studio: StudioEntity

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
        // 🔴 LEFT OPEN, DELIBERATELY (per Task 10's instructions — do not
        // silently resolve this): whether `perform()` should return as soon
        // as WidgetAPI.call's request is ACCEPTED, or keep blocking until
        // UniFi confirms the door actually opened, is a real fork with
        // different code on each branch — and it turns on a round-trip
        // latency measurement against deployed Phase 1 that has not been
        // taken yet (WidgetAPI.swift's own `call` doc comment flags the
        // same gap). What's built above is the plain, uncontroversial
        // middle: it sends the request and awaits the ONE response the
        // route returns, no fire-and-forget, no separate polling loop.
        //   - If the measured latency is short, this shape is very likely
        //     already the right answer and nothing needs to change.
        //   - If it is not, the fix is NOT to stop awaiting — `try?`
        //     already swallows a slow-but-eventually-successful call's
        //     error path with no user feedback either way — the fix is to
        //     make the FIRST tap's response ("armed") return immediately
        //     (already true above) and have the SECOND tap fire the
        //     request without blocking the button's visual return, reading
        //     the actual outcome back on the widget's next timeline tick
        //     instead of from this function's return value. That rewrite
        //     touches this function and Task 11's timeline provider
        //     together and is out of scope here.
    }
}

struct ToggleAcIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle AC"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Device ID") var deviceId: String
    @Parameter(title: "Turning On") var turningOn: Bool

    init() {}
    init(locationId: String, deviceId: String, turningOn: Bool) {
        self.locationId = locationId
        self.deviceId = deviceId
        self.turningOn = turningOn
    }

    func perform() async throws -> some IntentResult {
        let path = turningOn
            ? "/api/studio-management/ac/devices/\(deviceId)/turn-on"
            : "/api/studio-management/ac/devices/\(deviceId)/turn-off"
        _ = try? await WidgetAPI.call(path: path, locationId: locationId, method: "POST")
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct TogglePlugIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Plug"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Device ID") var deviceId: String
    @Parameter(title: "Turning On") var turningOn: Bool

    init() {}
    init(locationId: String, deviceId: String, turningOn: Bool) {
        self.locationId = locationId
        self.deviceId = deviceId
        self.turningOn = turningOn
    }

    func perform() async throws -> some IntentResult {
        _ = try? await WidgetAPI.call(
            path: "/api/shelly/devices/\(deviceId)/toggle",
            locationId: locationId,
            method: "POST",
            body: ["state": turningOn ? "on" : "off"]
        )
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct ToggleSpeakerIntent: AppIntent {
    static var title: LocalizedStringResource = "Play/Pause Speaker"
    static var isDiscoverable: Bool = false

    @Parameter(title: "Studio") var locationId: String
    @Parameter(title: "Player ID") var playerId: String
    // "play" | "pause" — the widget button toggles by its OWN last-known
    // state (what Task 11's timeline last rendered), not a live query
    // issued from inside this intent.
    @Parameter(title: "Action") var action: String

    init() {}
    init(locationId: String, playerId: String, action: String) {
        self.locationId = locationId
        self.playerId = playerId
        self.action = action
    }

    func perform() async throws -> some IntentResult {
        // An unknown player_id answers 404 `not_found`; a stale group_id
        // answers 409 `regrouped`. WidgetAPIError.server(status:message:code:)
        // carries both `code` and the server's own `message` distinctly —
        // deliberately not conflated here or anywhere downstream. `try?`
        // still discards the outcome for this direct-fire button (matching
        // the other three intents in this file); Task 11's timeline is
        // where a surfaced error, if ever added, would need to read that
        // `code` back out rather than pattern-matching `message` text.
        _ = try? await WidgetAPI.call(
            path: "/api/sonos/control",
            locationId: locationId,
            method: "POST",
            body: ["player_id": playerId, "action": action]
        )
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
