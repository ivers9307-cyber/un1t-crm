// mobile/targets/widgets/RepsetWidgets.swift
// WIDGET.1 — one extension, two widget kinds. A single WidgetBundle is the
// standard WidgetKit shape for "more than one widget from one extension" —
// there is no reason for these to be two separate Xcode targets, since
// they share WidgetAPI.swift, StudioEntity.swift, DeviceEntity.swift and
// WidgetPalette.swift, and the same App Group.

import WidgetKit
import SwiftUI

@main
struct RepsetWidgets: WidgetBundle {
    var body: some Widget {
        StudioControlsWidget()
        WhatNeedsMeWidget()
    }
}
