// mobile/targets/widgets/WhatNeedsMeWidget.swift
// WIDGET.1 Task 12 — What Needs Me's view + timeline.
//
// medium shows the three bySource counts (approvals/mail/inbox), each
// under its own column; small shows ONLY the summed total — never the
// per-source breakdown, per spec (three columns don't survive that width
// legibly, and the total is the one number that can't be misread). Reads
// GET /api/home-queue/count (Phase 1, src/lib/home-queue.js's
// getHomeQueueCounts) — the SAME assembler the old sidebar badge polled,
// now scoped to this device's widget credential.
//
// 15–30 MINUTE TIMELINE FLOOR: 20 minutes is the fixed point inside that
// range — frequent enough that a studio checking once an hour never sees
// hour-old numbers, infrequent enough that the same studio's widget on
// several staff phones doesn't turn into several requests every few
// minutes against a route the app already polls elsewhere. Task 13's push
// handler reloads sooner when a real change is likely; this is the
// backstop that guarantees a bound on staleness even if a push is missed,
// not the primary path.
//
// 🔴 DEGRADED SURFACING IS THE POINT OF THIS FILE, NOT AN AFTERTHOUGHT:
// getHomeQueueCounts substitutes 0 for any source it could not check and
// lists that source's name in `degraded` — the route deliberately does
// NOT fold that into a confident total (see that function's own doc
// comment: "an unknown contributor must not silently read as a known
// zero" is the sibling assembleHomeQueue's wording; getHomeQueueCounts
// applies the identical posture to the per-source counts this widget
// reads). A tile that rendered `bySource.mail == 0` as an ordinary,
// confident zero when `degraded` names "mail" would be re-deriving a
// confidence the server explicitly declined to state — exactly what this
// extension is built never to do. Every degraded source renders as "—",
// visually distinct from a genuine, muted "0" (see `zeroOrDash` below),
// and the small tile's total gets a "+" suffix — the same "more than
// what's shown" idiom src/lib/home-queue.js's own `queueCountLabel`
// already uses elsewhere in this app for an undercount, so this reads as
// a familiar convention rather than an invented one.

import WidgetKit
import SwiftUI

// MARK: - Status

/// Why an entry doesn't hold a confident set of counts. Distinct from
/// `degraded` (a PARTIAL, per-source gap in an otherwise-successful
/// response) — this is "the request itself didn't get a usable answer at
/// all", which needs different wording: a missing/revoked credential
/// means "go fix this in the app", where a bare network hiccup means
/// "nothing to do, it'll retry itself".
private enum FetchStatus: Equatable {
    case ok
    /// No studio configured — the ORDINARY state of a freshly placed
    /// widget, since `studio` is Optional (Apple requires every
    /// `WidgetConfigurationIntent` parameter to be; WhatNeedsMeIntents.swift).
    case notConfigured
    /// `WidgetAPIError.noCredential` — this studio's widget credential is
    /// no longer stored on this device (the app removed it, or it was
    /// never finished being set up).
    case credentialMissing
    /// Server answered 401/403 — the credential is still stored on-device
    /// but the SERVER no longer honours it (revoked from elsewhere).
    case credentialRevoked
    /// Any other transport or server failure — transient, not a
    /// configuration problem; the next scheduled refresh may simply work.
    case unreachable
}

// MARK: - Entry

struct WhatNeedsMeEntry: TimelineEntry {
    let date: Date
    let studioId: String
    let studioName: String
    let approvals: Int
    let mail: Int
    let inbox: Int
    /// Subset of {"approvals","mail","inbox"} the server could NOT check
    /// this round — see this file's header. Each name's own count above is
    /// the server's substituted 0, not a real measurement.
    let degradedSources: Set<String>
    /// Whether this DEVICE holds any widget credential at all — see the
    /// identical field on `StudioControlsEntry` for why the not-configured
    /// copy has to tell "never set up" and "no studio picked" apart.
    let anyCredentialStored: Bool
    fileprivate let status: FetchStatus

    var total: Int { approvals + mail + inbox }
}

// MARK: - Provider

struct WhatNeedsMeProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WhatNeedsMeEntry {
        WhatNeedsMeEntry(date: Date(), studioId: "", studioName: "", approvals: 0, mail: 0, inbox: 0, degradedSources: [], anyCredentialStored: false, status: .notConfigured)
    }

    func snapshot(for configuration: WhatNeedsMeConfigurationIntent, in context: Context) async -> WhatNeedsMeEntry {
        await fetch(configuration: configuration)
    }

    func timeline(for configuration: WhatNeedsMeConfigurationIntent, in context: Context) async -> Timeline<WhatNeedsMeEntry> {
        let entry = await fetch(configuration: configuration)
        let next = Calendar.current.date(byAdding: .minute, value: 20, to: Date()) ?? Date().addingTimeInterval(20 * 60)
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func fetch(configuration: WhatNeedsMeConfigurationIntent) async -> WhatNeedsMeEntry {
        // WIDGET.2 — `studio` is Optional per Apple's WidgetConfigurationIntent
        // rule (WhatNeedsMeIntents.swift); "" is precisely the not-configured
        // state the `guard` below already keys off, so nil needs no new branch.
        let studioId = configuration.studio?.id ?? ""
        let studioName = configuration.studio?.name ?? ""
        // Local UserDefaults read, no network — same shape as Studio Controls'.
        let anyCredentialStored = !WidgetAPI.storedStudios().isEmpty

        func entry(approvals: Int = 0, mail: Int = 0, inbox: Int = 0, degraded: Set<String> = [], status: FetchStatus) -> WhatNeedsMeEntry {
            WhatNeedsMeEntry(date: Date(), studioId: studioId, studioName: studioName, approvals: approvals, mail: mail, inbox: inbox, degradedSources: degraded, anyCredentialStored: anyCredentialStored, status: status)
        }

        guard !studioId.isEmpty else { return entry(status: .notConfigured) }

        do {
            let json = try await WidgetAPI.call(path: "/api/home-queue/count", locationId: studioId)
            guard let data = json["data"] as? [String: Any],
                  let bySource = data["bySource"] as? [String: Any] else {
                return entry(status: .unreachable)
            }
            let degraded = Set((data["degraded"] as? [String]) ?? [])
            return entry(
                approvals: bySource["approvals"] as? Int ?? 0,
                mail: bySource["mail"] as? Int ?? 0,
                inbox: bySource["inbox"] as? Int ?? 0,
                degraded: degraded,
                status: .ok
            )
        } catch WidgetAPIError.noCredential {
            return entry(status: .credentialMissing)
        } catch WidgetAPIError.server(let status, _, _) where status == 401 || status == 403 {
            return entry(status: .credentialRevoked)
        } catch {
            // Covers WidgetAPIError.transport and every other
            // WidgetAPIError.server status (5xx, or an unexpected 4xx) —
            // all transient from this tile's point of view. `error` itself
            // is discarded: there is no on-tile surface for it (no button,
            // no log console), and this mirrors every action AppIntent in
            // StudioControlsIntents.swift already discarding theirs via
            // `try?` for the same reason.
            return entry(status: .unreachable)
        }
    }
}

// MARK: - Views

struct WhatNeedsMeWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: WhatNeedsMeEntry

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
        switch entry.status {
        case .notConfigured:
            // Same split as Studio Controls (see that file for the full
            // reason): Edit Widget can only offer studios already minted on
            // this device, so a phone with no credential has to be sent to
            // the app instead of to an empty picker.
            WidgetStatusMessage(text: entry.anyCredentialStored
                ? "Add this widget's studio in Edit Widget."
                : "Open Repset → More → Widgets to set this up.")
        case .credentialMissing:
            WidgetStatusMessage(text: "This studio's access was removed. Reopen Repset to reconnect.")
        case .credentialRevoked:
            WidgetStatusMessage(text: "Access was revoked. Reopen Repset to reconnect.")
        case .unreachable:
            WidgetStatusMessage(text: "Couldn't check just now.")
        case .ok:
            if family == .systemSmall {
                smallBody
            } else {
                mediumBody
            }
        }
    }

    // MARK: small — total only

    private var smallBody: some View {
        let hasGap = !entry.degradedSources.isEmpty
        return VStack(alignment: .leading, spacing: 4) {
            Text(hasGap ? "\(entry.total)+" : "\(entry.total)")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                // A zero total is still a real, confident answer here
                // (nothing degraded, nothing pending) — muted, per spec,
                // same as every zero elsewhere on this tile, not hidden.
                .foregroundStyle(entry.total == 0 && !hasGap ? WidgetPalette.muted : WidgetPalette.text)
            Text(hasGap ? "needs you · partial" : "needs you")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(WidgetPalette.muted)
        }
    }

    // MARK: medium — three columns

    private var mediumBody: some View {
        HStack(spacing: 18) {
            statColumn("Approvals", entry.approvals, degraded: entry.degradedSources.contains("approvals"))
            statColumn("Mail", entry.mail, degraded: entry.degradedSources.contains("mail"))
            statColumn("Inbox", entry.inbox, degraded: entry.degradedSources.contains("inbox"))
        }
    }

    private func statColumn(_ label: String, _ count: Int, degraded: Bool) -> some View {
        VStack(spacing: 4) {
            // 🔴 Never the same glyph for "confirmed zero" and "couldn't
            // check" — a dash is neither a number nor an absence; it reads
            // as "unknown", which is the honest answer for a degraded
            // source. A genuine zero always renders as the digit "0".
            Text(degraded ? "—" : "\(count)")
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle((count == 0 || degraded) ? WidgetPalette.muted : WidgetPalette.text)
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(WidgetPalette.muted)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Widget

struct WhatNeedsMeWidget: Widget {
    let kind: String = "WhatNeedsMe"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: WhatNeedsMeConfigurationIntent.self, provider: WhatNeedsMeProvider()) { entry in
            WhatNeedsMeWidgetView(entry: entry)
        }
        .configurationDisplayName("What Needs Me")
        .description("Approvals, mail and inbox counts for one studio.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
