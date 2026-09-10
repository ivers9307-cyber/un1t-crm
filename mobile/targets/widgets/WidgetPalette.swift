// mobile/targets/widgets/WidgetPalette.swift
// WIDGET.1 Tasks 11/12 — the app's own tokens, verbatim from the plan's
// design section, not an invented widget-specific palette: ink ground
// (#131316), raised surface (#1C1C21), volt accent (#D6FF3D), muted text
// (~#8A8A93). Shared by both widget kinds so Studio Controls and What
// Needs Me read as one system rather than two independently-tinted
// extensions.
//
// 🔴 Volt is the EARNED/LIT accent only. The one place either widget uses
// it is the door button's armed state (StudioControlsWidget.swift) — the
// two-tap window is a real "this is now live" state, not a routine one.
// Every quiet/informational state in both widgets — a zero count, "not
// set up", "couldn't check" — stays on `muted` or `text`, never `volt`.
// Grep for `WidgetPalette.volt` before adding a new usage; if the state
// being styled is informational rather than "about to act", it's the
// wrong token.

import SwiftUI

enum WidgetPalette {
    static let ink = Color(widgetHex: 0x13_13_16)
    static let surface = Color(widgetHex: 0x1C_1C_21)
    static let volt = Color(widgetHex: 0xD6_FF_3D)
    static let muted = Color(widgetHex: 0x8A_8A_93)
    // Not one of the four named tokens — the plan's palette names a ground,
    // a surface, an accent and a muted tone, but every glyph/label that
    // isn't muted still needs SOME foreground color against `ink`/`surface`.
    // Off-white rather than pure white so it sits comfortably next to
    // `surface` without looking like a fifth, uninvited accent.
    static let text = Color(widgetHex: 0xF2_F2_F0)
}

private extension Color {
    /// `0xRRGGBB` → Color. SwiftUI has no built-in hex initializer; this
    /// keeps the palette above as literal, greppable hex rather than
    /// hand-converted RGB fractions that would drift silently from the
    /// spec's own hex if anyone hand-edited one component.
    init(widgetHex hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}

/// Shared by both widgets' "nothing to render normally" states — not
/// configured, credential missing/revoked, or a transient fetch failure.
/// One look for all of them (per-case wording is the caller's job) so an
/// operator who sees this text in either tile recognizes the same "this
/// needs your attention in the app, not a tap here" register.
struct WidgetStatusMessage: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(WidgetPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
