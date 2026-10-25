// mobile/targets/widgets/DeviceEntity.swift
// WIDGET.1 Task 9 — the per-button device picker for Studio Controls. Calls
// GET /api/widget/devices (Phase 1, src/app/api/widget/devices/route.js)
// using the SELECTED studio's stored credential.
//
// `kind` round-trips as part of the entity id (`"<kind>:<id>"`) because the
// action AppIntents (Task 10) need to know which of the four routes to call
// for a given selected device, and AppIntents persist only what an
// AppEntity's `id` carries — not the whole struct.
//
// 🔴 THE CRUX — SCOPING THE QUERY TO THE CHOSEN STUDIO (found by reading
// AppIntents.swiftinterface for iPhoneOS26.5.sdk, not assumed):
//
// The plan's draft suspected `suggestedEntities()` might need to move to
// `EnumerableEntityQuery` or a `DynamicOptionsProvider` conformance to
// receive studio context. Neither is what the SDK actually wants. The real
// mechanism is `@IntentParameterDependency<Intent>`, a property wrapper
// (iOS 17+) that a `DynamicOptionsProvider` declares against a KEYPATH INTO
// A CONCRETE `WidgetConfigurationIntent` TYPE:
//
//     struct DeviceOptionsProvider: DynamicOptionsProvider {
//         @IntentParameterDependency<StudioControlsConfigurationIntent>(\.$studio)
//         var studioParam
//
//         func results() async throws -> IntentItemCollection<DeviceEntity> {
//             guard let studio = studioParam?.studio else { return .empty }
//             return try await DeviceQuery.buildResult(locationId: studio.id)
//         }
//     }
//
// wired to the intent's own parameter as
// `@Parameter(optionsProvider: DeviceOptionsProvider()) var device: DeviceEntity`.
// `IntentParameter`'s `optionsProvider:` initializer is generic over any
// `AppEntity` — it is not restricted to `AppEnum`-backed entities, so this
// shape is available to a plain server-backed entity like `DeviceEntity`.
//
// THIS IS WHY THE MECHANISM CANNOT BE FINISHED IN THIS FILE: the KeyPath
// `\.$studio` has to name a stored `@Parameter` on a CONCRETE intent type,
// and that intent (`StudioControlsConfigurationIntent`) is Task 10's
// deliverable, not this one's — it does not exist yet, and a generic
// `DeviceOptionsProvider<Intent: WidgetConfigurationIntent>` cannot stand
// in for it, because Swift has no protocol that promises an arbitrary
// `Intent` has a `studio` parameter to key-path into. So: the SDK's clean
// way is real and is documented above verbatim for Task 10 to wire up: it
// must declare the `DeviceOptionsProvider` (or equivalent) itself, once
// `StudioControlsConfigurationIntent` exists, using `DeviceQuery.buildResult
// (locationId:)` below rather than re-deriving the fetch/decode. Do NOT
// treat `DeviceEntity.defaultQuery` (below) as that mechanism — it isn't,
// and can't be, for the reason above.
//
// `DeviceQuery` here is only what `AppEntity` actually requires of
// `defaultQuery`: resolving previously-picked identifiers back to entities
// (`entities(for:)`, e.g. Siri/Shortcuts re-hydrating a stored selection or
// the config sheet redrawing its current summary row) and a
// context-free fallback list. NEITHER of those call sites is handed a
// studio parameter by the protocol — `entities(for:)`'s signature is fixed
// to `([Entity.ID]) -> [Entity]`, nothing else — so both fall back to
// "the first studio this device has minted a credential for" when no
// locationId is available. That is a real limitation of the plain
// `EntityQuery` surface, not a mechanism this file is choosing not to use;
// flagging it here rather than quietly resolving cross-studio devices
// against the wrong studio.
//
// `degraded` IS surfaced, through a mechanism the SDK actually offers:
// `EntityQuery.suggestedEntities()`'s return type is not fixed to a plain
// array — the protocol declares it as `associatedtype Result = [Entity]`,
// a DEFAULT, not a constraint, so a conforming query can instead return
// `IntentItemCollection<DeviceEntity>`, whose `IntentItemSection` carries
// an optional `description: DisplayRepresentation?` the config sheet
// renders as a section header. When the server's `degraded` list is
// non-empty, that description spells out which sources could not be
// checked, rather than silently presenting a short device list as if it
// were the complete one.

import AppIntents

struct DeviceEntity: AppEntity {
    let id: String        // "<kind>:<id>", e.g. "door:d1", "speaker:RINCON_1"
    let label: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Device"
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(label)") }

    static var defaultQuery = DeviceQuery()

    var kind: String { String(id.split(separator: ":", maxSplits: 1).first ?? "") }
    var rawId: String { String(id.split(separator: ":", maxSplits: 1).last ?? "") }
}

struct DeviceQuery: EntityQuery {
    func entities(for identifiers: [DeviceEntity.ID]) async throws -> [DeviceEntity] {
        // Re-derive labels from the live list rather than trusting whatever
        // Siri/Shortcuts cached — a renamed or removed device must not
        // silently keep its stale label in the config sheet. No studio is
        // available here (see file header) — falls back to the first
        // stored studio, same fallback `suggestedEntities()` below uses.
        let all = try await Self.fetchAll()
        return all.filter { identifiers.contains($0.id) }
    }

    /// Context-free fallback only — see file header. The real, studio-scoped
    /// list the configuration sheet shows comes from Task 10's dependent
    /// `DynamicOptionsProvider`, not from this method.
    func suggestedEntities() async throws -> IntentItemCollection<DeviceEntity> {
        try await Self.buildResult(locationId: nil)
    }

    /// Fetches `GET /api/widget/devices` for `locationId` (or the first
    /// stored studio when nil — see file header) and returns the raw
    /// entities with no additional filtering: the server already applied
    /// every gate (UNIFI-DOORS-SCOPE, AC-ROLE.1, the studio_management /
    /// device_control split) and this extension re-derives nothing.
    static func fetchAll(locationId: String? = nil) async throws -> [DeviceEntity] {
        let studio = locationId ?? WidgetAPI.storedStudios().first?.locationId
        guard let studio else { return [] }
        let json = try await WidgetAPI.call(path: "/api/widget/devices", locationId: studio)
        guard let data = json["data"] as? [String: Any],
              let devices = data["devices"] as? [[String: Any]] else { return [] }
        return devices.compactMap { d in
            guard let kind = d["kind"] as? String,
                  let rawId = d["id"] as? String,
                  let label = d["label"] as? String else { return nil }
            return DeviceEntity(id: "\(kind):\(rawId)", label: label)
        }
    }

    /// Shared by `suggestedEntities()` here and by Task 10's dependent
    /// options provider — the one place that turns the server's
    /// `{ devices, degraded }` envelope into what the config sheet shows,
    /// so both call sites surface `degraded` identically rather than one
    /// of them quietly dropping it.
    static func buildResult(locationId: String?) async throws -> IntentItemCollection<DeviceEntity> {
        let studio = locationId ?? WidgetAPI.storedStudios().first?.locationId
        guard let studio else { return .empty }
        let json = try await WidgetAPI.call(path: "/api/widget/devices", locationId: studio)
        guard let data = json["data"] as? [String: Any],
              let rawDevices = data["devices"] as? [[String: Any]] else { return .empty }
        let devices: [DeviceEntity] = rawDevices.compactMap { d in
            guard let kind = d["kind"] as? String,
                  let rawId = d["id"] as? String,
                  let label = d["label"] as? String else { return nil }
            return DeviceEntity(id: "\(kind):\(rawId)", label: label)
        }
        let degraded = (data["degraded"] as? [String]) ?? []
        let sectionTitle: LocalizedStringResource = degraded.isEmpty
            ? "Devices"
            : "Devices (could not check: \(degraded.joined(separator: ", ")))"
        return IntentItemCollection(sections: [
            IntentItemSection(sectionTitle, items: devices)
        ])
    }
}
