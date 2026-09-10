// mobile/targets/widgets/StudioEntity.swift
// WIDGET.1 Task 8 — the studio picker. Backs BOTH widget kinds'
// configuration: Studio Controls uses it to scope its device picker
// (DeviceEntity.swift, Task 9); What Needs Me's configuration is only
// this. Reads ONLY the App-Group-stored list of studios this device has
// already minted a widget credential for (WidgetAPI.storedStudios()) — no
// network call, so the config sheet opens instantly and works with the
// extension's process alone. A studio that has not been minted from the
// app (Task 5) simply cannot appear here — that IS the mint flow's job,
// not this picker's.
//
// 🔴 DEVIATIONS FROM THE PLAN'S DRAFT (found by the compiler against
// iPhoneOS26.5.sdk, arm64-apple-ios17.0 — see the plan's own Task 8/9
// preamble, which flagged this file's shape as unverified):
//
//   - The plan's draft typechecks AS WRITTEN. `static var
//     typeDisplayRepresentation` and `static var defaultQuery` both
//     satisfy `AppEntity`'s `{ get }` requirements as plain stored
//     `var`s — no `let` was required. (`TypeDisplayRepresentation` and
//     `DisplayRepresentation` both conform to `ExpressibleByStringLiteral`
//     in this SDK, so the `"Studio"` / `"\(name)"` literals resolve
//     directly — confirmed by reading AppIntents.swiftinterface, not
//     assumed.)
//   - `EntityQuery.suggestedEntities()` DOES live on the bare `EntityQuery`
//     protocol in this SDK (it is a required member with a default
//     implementation in a protocol extension) — no `EnumerableEntityQuery`
//     or `DynamicOptionsProvider` conformance was needed to write it here.
//     `EntityQuery` already refines `DynamicOptionsProvider` itself, so
//     the conformance the plan worried about is inherited, not bolted on.
//   - `PersistentlyIdentifiable.persistentIdentifier` (required by both
//     `AppEntity`'s `AppValue` parent and by `EntityQuery` itself) has a
//     default implementation in AppIntents — nothing to add here.
//
// The one substantive change from the plan's draft: `StudioQuery.init()`
// is required by the `EntityQuery` protocol (`init()` with no arguments) —
// the plan's draft left it to the implicit memberwise initializer, which
// only exists for a truly empty struct. `StudioQuery` stays empty here for
// exactly that reason; don't add stored properties to it without also
// adding an explicit `init()`.

import AppIntents

struct StudioEntity: AppEntity {
    let id: String          // locationId
    let name: String        // locationName, for display

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Studio"
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    static var defaultQuery = StudioQuery()
}

struct StudioQuery: EntityQuery {
    func entities(for identifiers: [StudioEntity.ID]) async throws -> [StudioEntity] {
        WidgetAPI.storedStudios()
            .filter { identifiers.contains($0.locationId) }
            .map { StudioEntity(id: $0.locationId, name: $0.locationName) }
    }

    func suggestedEntities() async throws -> [StudioEntity] {
        WidgetAPI.storedStudios().map { StudioEntity(id: $0.locationId, name: $0.locationName) }
    }
}
