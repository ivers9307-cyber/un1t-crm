// mobile/targets/widgets/StudioControlsWidget.swift
// WIDGET.1 Task 11 — Studio Controls' view + timeline.
//
// NO NETWORK CALL IN THIS PROVIDER. Which buttons exist and what they're
// named comes entirely from `configuration.devicesInOrder`
// (StudioControlsIntents.swift, Task 10) — the picker already resolved
// those against /api/widget/devices when the operator built the
// configuration. Re-fetching here would be exactly the kind of
// re-deciding this extension is built to avoid; the timeline's only job
// is to render what configuration already settled, plus the one thing
// that genuinely changes between config edits: the door's own armed/
// disarmed state (see below).
//
// medium shows every configured button (up to 4); small shows the FIRST
// TWO in configured order, per spec — so the operator controls which two
// survive by ordering the config sheet, not by which kind of device they
// are. large is not shipped (`.supportedFamilies` below omits it).
//
// RELOAD POLICY: `.never` is the steady state — content changes only when
// the operator re-edits the widget (an automatic WidgetKit reload on
// config change, not a timer) or a button's own AppIntent calls
// `WidgetCenter.shared.reloadAllTimelines()` after it fires. The ONE
// exception is a currently-armed door (see `ArmDoorWindow` below): that
// needs to revert its own look the instant its 3-second window closes,
// which a static `.never` entry can't do on its own.

import WidgetKit
import SwiftUI

// MARK: - Armed-door window

/// Reads the SAME App-Group timestamp `ArmState` (StudioControlsIntents.swift,
/// Task 10) writes on the door's first tap — `armed_until_<deviceId>`, a
/// Unix timestamp. Deliberately reimplemented here rather than adding an
/// accessor to `ArmState` itself: `ArmState`'s own methods
/// (`arm`/`isArmed`/`disarm`) answer "is it armed right now", which is all
/// Task 10's `UnlockDoorIntent` ever needed. This provider needs something
/// `ArmState` doesn't expose — the exact expiry — so it can schedule a
/// SECOND timeline entry at that precise moment and have the button revert
/// to disarmed on its own, without a fresh `reloadAllTimelines()` call. The
/// storage contract (key format, Unix-timestamp encoding) is already
/// documented at `ArmState`'s declaration; this is a read-only second
/// reader of the same contract, not a competing writer.
private func doorArmedUntil(_ deviceId: String) -> Date? {
    guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return nil }
    let raw = defaults.double(forKey: "armed_until_\(deviceId)")
    guard raw > 0 else { return nil }
    let until = Date(timeIntervalSince1970: raw)
    return until > Date() ? until : nil
}

// MARK: - Entry

struct StudioControlsEntry: TimelineEntry {
    let date: Date
    let studioId: String
    let studioName: String
    let devices: [DeviceEntity]
    /// `rawId`s of doors currently inside their 3-second arm window, AS OF
    /// `date` — not "right now" when the view happens to render, so a
    /// cached/redrawn entry stays internally consistent with its own
    /// timestamp.
    let armedDoorIds: Set<String>
    /// A local (UserDefaults, no network) read of whether this studio's
    /// widget credential is still stored on-device. `false` means either
    /// this studio was removed from the app, or the widget was never
    /// finished being set up — the view can't tell those two apart from
    /// this alone, and per Task 11's brief both get the same defined
    /// look (see `StudioControlsWidgetView`).
    let credentialPresent: Bool
    /// `rawId`s of non-door devices we currently BELIEVE are on/playing —
    /// `ToggleState.isOn` (StudioControlsIntents.swift) read AS OF `date`,
    /// same "local read, no network" shape as `credentialPresent` above.
    /// This is the last state THIS WIDGET sent, not a live read of the
    /// device — see `ToggleState`'s header for why that can drift.
    let toggledOnIds: Set<String>
}

// MARK: - Provider

struct StudioControlsProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> StudioControlsEntry {
        StudioControlsEntry(date: Date(), studioId: "", studioName: "", devices: [], armedDoorIds: [], credentialPresent: false, toggledOnIds: [])
    }

    func snapshot(for configuration: StudioControlsConfigurationIntent, in context: Context) async -> StudioControlsEntry {
        buildEntry(at: Date(), configuration: configuration)
    }

    func timeline(for configuration: StudioControlsConfigurationIntent, in context: Context) async -> Timeline<StudioControlsEntry> {
        let now = Date()
        let devices = configuration.devicesInOrder

        // Doors currently mid-arm, each with its own exact expiry — ArmState
        // is keyed per device id (Task 10's own comment on that type), so
        // more than one configured door CAN be independently armed at once.
        let doorExpiries: [(id: String, until: Date)] = devices
            .filter { $0.kind == "door" }
            .compactMap { device in
                doorArmedUntil(device.rawId).map { (device.rawId, $0) }
            }

        let current = buildEntry(at: now, configuration: configuration, armedDoorIds: Set(doorExpiries.map(\.id)))

        guard !doorExpiries.isEmpty else {
            return Timeline(entries: [current], policy: .never)
        }

        // One follow-up entry per distinct expiry, dropping that door from
        // the armed set as its own window closes — so a door tapped once
        // and then left alone reverts to its disarmed look on its own,
        // with no second `reloadAllTimelines()` needed for the common
        // "armed, then the operator walked away" case.
        var entries = [current]
        var remaining = Set(doorExpiries.map(\.id))
        for (id, until) in doorExpiries.sorted(by: { $0.until < $1.until }) {
            remaining.remove(id)
            entries.append(buildEntry(at: until, configuration: configuration, armedDoorIds: remaining))
        }
        let lastExpiry = doorExpiries.map(\.until).max() ?? now
        return Timeline(entries: entries, policy: .after(lastExpiry))
    }

    private func buildEntry(
        at date: Date,
        configuration: StudioControlsConfigurationIntent,
        armedDoorIds: Set<String> = []
    ) -> StudioControlsEntry {
        let studioId = configuration.studio.id
        // Local UserDefaults read, same as `armedDoorIds`/`credentialPresent`
        // above — NOT a network call, so this doesn't violate this file's
        // own "no network call in this provider" rule. `ToggleState` never
        // holds an entry for a door, so the `kind != "door"` filter is
        // belt-and-braces, not load-bearing.
        let toggledOnIds = Set(
            configuration.devicesInOrder
                .filter { $0.kind != "door" && ToggleState.isOn($0.rawId) }
                .map(\.rawId)
        )
        return StudioControlsEntry(
            date: date,
            studioId: studioId,
            studioName: configuration.studio.name,
            devices: configuration.devicesInOrder,
            armedDoorIds: armedDoorIds,
            credentialPresent: WidgetAPI.token(forLocation: studioId) != nil,
            toggledOnIds: toggledOnIds
        )
    }
}

// MARK: - Views

/// One button: a glyph over the device's own name (per spec — a button
/// names a specific device, never a generic kind label). Armed doors swap
/// both the glyph and the label, and take the ONE volt usage in this
/// widget — see WidgetPalette.swift's header on why nothing else does.
private struct StudioControlsButton: View {
    let device: DeviceEntity
    let locationId: String
    let armed: Bool
    /// Whether we BELIEVE this device is currently on/playing — from
    /// `entry.toggledOnIds`, itself `ToggleState.isOn` (StudioControlsIntents.swift):
    /// the last state THIS WIDGET sent, not a live read of the device.
    /// Meaningless (and unused) for "door", which has its own armed/
    /// disarmed look below.
    let isOn: Bool

    private var symbolName: String {
        switch device.kind {
        case "door": return armed ? "lock.open.fill" : "lock.fill"
        case "ac": return "snowflake"
        // Not "poweroutlet.type.b.fill" (Type B is a US/Japan socket) —
        // this app is Dublin-only (BS 1363 / "Type G"), and a generic plug
        // glyph reads correctly everywhere rather than showing the wrong
        // country's outlet shape. Filled when we believe it's on, outline
        // when off — both are real, standard SF Symbols (iOS 16+).
        case "plug": return isOn ? "powerplug.fill" : "powerplug"
        // ⏸/▶ per the signed-off mockup — filled play/pause, no separate
        // "off" glyph the way plug/AC have, since a speaker only has two
        // states to begin with.
        case "speaker": return isOn ? "pause.fill" : "play.fill"
        default: return "questionmark.circle"
        }
    }

    private var displayLabel: String {
        // The only re-labelling this view does — everything else renders
        // exactly the name the operator chose in the config sheet,
        // unmodified, per spec ("every button names a specific device").
        (device.kind == "door" && armed) ? "Tap to confirm" : device.label
    }

    /// Non-door devices dim their glyph/label when we believe they're off,
    /// so the belief this button will act on is visible at a glance —
    /// deliberately NOT `WidgetPalette.volt`, which is reserved for the
    /// door's genuinely-armed state (see that palette's own header on why
    /// nothing else should reach for it). AC has no distinct on/off glyph
    /// (no reliable SF Symbol pair for it), so this dimming is the ONLY
    /// visual cue its toggle state gets.
    private var glyphColor: Color {
        guard device.kind != "door" else { return WidgetPalette.text }
        return isOn ? WidgetPalette.text : WidgetPalette.muted
    }

    @ViewBuilder
    private var badge: some View {
        VStack(spacing: 6) {
            Image(systemName: symbolName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(armed ? WidgetPalette.ink : glyphColor)
                .frame(width: 40, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(armed ? WidgetPalette.volt : WidgetPalette.surface)
                )
            Text(displayLabel)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(armed ? WidgetPalette.volt : glyphColor)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity)
    }

    var body: some View {
        switch device.kind {
        case "door":
            Button(intent: UnlockDoorIntent(locationId: locationId, doorId: device.rawId, doorName: device.label)) { badge }
                .buttonStyle(.plain)
        case "ac":
            // Fires ToggleAcIntent with no direction of its own — the
            // intent reads ToggleState (StudioControlsIntents.swift) and
            // sends the opposite of what THIS WIDGET last sent, not a
            // hard-coded "on". `isOn` above is this same belief, read
            // separately here purely to render the badge.
            Button(intent: ToggleAcIntent(locationId: locationId, deviceId: device.rawId)) { badge }
                .buttonStyle(.plain)
        case "plug":
            // Same shape as "ac" above.
            Button(intent: TogglePlugIntent(locationId: locationId, deviceId: device.rawId)) { badge }
                .buttonStyle(.plain)
        case "speaker":
            // Same shape as "ac"/"plug" above — the approved mockup's ⏯
            // behaviour. See ToggleState's header (StudioControlsIntents.swift)
            // for why this is an optimistic belief, not a live read of
            // what Sonos is actually doing.
            Button(intent: ToggleSpeakerIntent(locationId: locationId, playerId: device.rawId)) { badge }
                .buttonStyle(.plain)
        default:
            // An unrecognised kind (a future device type the server started
            // returning before this extension knew about it) renders, but
            // isn't wired to any action — the extension never guesses which
            // route an unknown kind would need.
            badge
        }
    }
}

struct StudioControlsWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StudioControlsEntry

    private var visibleDevices: [DeviceEntity] {
        family == .systemSmall ? Array(entry.devices.prefix(2)) : entry.devices
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(WidgetPalette.ink, for: .widget)
    }

    @ViewBuilder
    private var header: some View {
        // Shown whenever we know which studio this tile belongs to, even
        // in an error state below — "which studio is this" is useful
        // information on its own, independent of whether its data loaded.
        if !entry.studioName.isEmpty {
            Text(entry.studioName)
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(WidgetPalette.muted)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var content: some View {
        if entry.studioId.isEmpty {
            // Placeholder/gallery preview, or (defensively) a genuinely
            // unconfigured intent — see this file's header on why a
            // required `@Parameter` with no stored studios can still reach
            // here. Same wording as What Needs Me's equivalent state.
            WidgetStatusMessage(text: "Add this widget's studio in Edit Widget.")
        } else if !entry.credentialPresent {
            WidgetStatusMessage(text: "This studio's access was removed. Reopen Repset to reconnect.")
        } else if entry.devices.isEmpty {
            WidgetStatusMessage(text: "No devices chosen yet. Edit this widget to add up to four.")
        } else {
            HStack(alignment: .top, spacing: 14) {
                ForEach(visibleDevices, id: \.id) { device in
                    StudioControlsButton(
                        device: device,
                        locationId: entry.studioId,
                        armed: entry.armedDoorIds.contains(device.rawId),
                        isOn: entry.toggledOnIds.contains(device.rawId)
                    )
                }
            }
        }
    }
}

// MARK: - Widget

struct StudioControlsWidget: Widget {
    let kind: String = "StudioControls"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: StudioControlsConfigurationIntent.self, provider: StudioControlsProvider()) { entry in
            StudioControlsWidgetView(entry: entry)
        }
        .configurationDisplayName("Studio Controls")
        .description("Fire your studio's music, plugs, AC and door.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
