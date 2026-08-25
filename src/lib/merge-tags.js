// K3 — the ONE list of email merge tags, and which of them an operator is
// offered in the editors.
//
// WHY THIS FILE EXISTS
// `applyMergeTags()` in src/lib/postmark.js is what actually substitutes tags
// at send time. The operator-facing lists that advertise them were hand-copied
// into three places — the Unlayer `mergeTags` config in CampaignEditor.jsx, the
// "Merge Tags" reference panel further down the same file, and the Unlayer
// config in TemplateEditor.jsx — and drifted. Five tags that substitute
// perfectly well were absent from the reference panel and from TemplateEditor
// ({{last_name}}, {{phone}}, {{pipeline_stage}}, {{lead_status}},
// {{glofox_passcode}}), so an operator had no way to discover them; the
// docblock over applyMergeTags had drifted the other way and omitted three it
// does substitute. Nothing failed loudly — a tag you never learn about is just
// personalisation you never use.
//
// So the substitution set lives here, the editors render from here, and
// merge-tags.test.js asserts this list and applyMergeTags() agree in BOTH
// directions. Adding a tag to applyMergeTags without adding it here fails CI.
//
// `offered: false` means the tag substitutes but is deliberately kept out of
// the pickers, with the reason stated. That is a decision, not an oversight —
// the whole point of this file is that the difference is visible.

/**
 * Every tag `applyMergeTags()` substitutes.
 *   tag         — the literal, exactly as written in an email body
 *   name        — short label for the Unlayer merge-tag dropdown
 *   description — one line for the reference panel
 *   offered     — shown in the editors' pickers
 *   why         — required when offered is false
 */
export const MERGE_TAGS = Object.freeze([
  { tag: '{{first_name}}', name: 'First Name', description: "Contact's first name", offered: true },
  { tag: '{{last_name}}', name: 'Last Name', description: "Contact's last name", offered: true },
  { tag: '{{name}}', name: 'Full Name', description: "Contact's full name", offered: true },
  { tag: '{{email}}', name: 'Email', description: "Contact's email", offered: true },
  { tag: '{{phone}}', name: 'Phone', description: "Contact's phone number", offered: true },
  { tag: '{{pipeline_stage}}', name: 'Pipeline Stage', description: 'Their stage in the pipeline', offered: true },
  { tag: '{{location_name}}', name: 'Location', description: 'Your location name', offered: true },
  { tag: '{{unsubscribe_url}}', name: 'Unsubscribe', description: 'Unsubscribe link', offered: true },
  { tag: '{{preference_url}}', name: 'Preferences', description: 'Preference centre link', offered: true },
  { tag: '{{current_year}}', name: 'Year', description: 'Current year', offered: true },
  {
    tag: '{{booking_token}}',
    name: 'Booking Token',
    description: 'Prefills the booking form — append to your /start link as ?c={{booking_token}}',
    offered: true,
  },

  // ── substitutes, deliberately not offered ─────────────────────────
  {
    tag: '{{lead_status}}',
    name: 'Lead Status',
    description: 'Their stage in the pipeline (deprecated)',
    offered: false,
    // Deprecated alias of {{pipeline_stage}} — both read
    // contacts.pipeline_stage_slug (CLASSIFY.2). It stays in
    // applyMergeTags so email bodies written before the rename keep
    // rendering, but advertising it would seed new copies of a name we
    // are trying to retire.
    why: 'deprecated alias of {{pipeline_stage}}; kept substituting for old bodies only',
  },
  {
    tag: '{{glofox_passcode}}',
    name: 'Glofox Passcode',
    description: 'One-time Glofox passcode',
    offered: false,
    // Only non-empty for a contact CRM has just minted a Glofox account
    // for (glofox-push.js writes contacts.glofox_passcode). It is a
    // welcome-sequence tag: in a broadcast to a general audience it
    // renders empty for almost everyone, which reads as a broken email.
    why: 'only populated right after CRM creates a Glofox account — welcome sequence only, empty in a broadcast',
  },
])

/** The tags an operator is offered, in display order. */
export const OFFERED_MERGE_TAGS = Object.freeze(MERGE_TAGS.filter((t) => t.offered))

/** Shape for Unlayer's `mergeTags` editor config. */
export const UNLAYER_MERGE_TAGS = Object.freeze(
  OFFERED_MERGE_TAGS.map((t) => Object.freeze({ name: t.name, value: t.tag })),
)

/** Shape for the reference panel: [tag, description] pairs. */
export const MERGE_TAG_REFERENCE = Object.freeze(
  OFFERED_MERGE_TAGS.map((t) => Object.freeze([t.tag, t.description])),
)
