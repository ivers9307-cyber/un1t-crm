// mobile/targets/widgets/expo-target.config.js
// WIDGET.1 — the WidgetKit extension target. Function form so the bundle
// identifier and the App Group both follow the SAME env-driven main config
// mobile/app.config.js already resolves (LEGACY_APP=1 switches the whole app
// between ie.repset.app and com.un1tdublin.crm; this target's id follows
// without any new env var).
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'widgets',
  displayName: 'Repset Widgets',
  // Interactive widget buttons (Button(intent:)) need iOS 17+. Pinned
  // explicitly rather than left at the package's own 18.0 default so this
  // widget stays installable on iOS 17 devices — do not remove this line to
  // "match the default"; the default is a moving target across package
  // versions and this floor is a deliberate choice.
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'AppIntents'],
  // An EMPTY entitlements object, not an absent key. @bacons/apple-targets@5.0.0
  // only runs its "sync app groups with main app" step when `entitlements` is
  // present at all (see node_modules/@bacons/apple-targets/build/with-widget.js
  // — the whole App Group merge is inside `if (entitlementsJson)`); omitting
  // the key entirely skips it and the target gets NO entitlements file and NO
  // CODE_SIGN_ENTITLEMENTS setting, verified empirically via `expo prebuild`.
  // Leave this object empty (no application-groups key of our own) so the
  // plugin fills it in from mobile/app.config.js's ios.entitlements.
  entitlements: {},
})
