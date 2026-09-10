// mobile/targets/widgets/WhatNeedsMeIntents.swift
// WIDGET.1 Task 10 — What Needs Me's configuration is JUST the studio
// picker; there is nothing else to configure, since it always shows all
// three sources (Task 11 renders the fixed set; this file only lets staff
// pick which studio's data feeds it).
//
// Named `WhatNeedsMeConfigurationIntent` per the plan document (the file
// this widget kind's `AppIntentConfiguration` — Task 11 — is written
// against), not the shorter `NeedsMeConfigurationIntent` paraphrase; kept
// as the plan's exact identifier so Task 11 needs no rename.

import AppIntents

struct WhatNeedsMeConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "What Needs Me"
    static var description = IntentDescription("Pick a studio to see what needs attention.")

    @Parameter(title: "Studio")
    var studio: StudioEntity
}
