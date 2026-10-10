// W1.M2 — the membership-source choices a settings UI offers.
//
// CLIENT-SAFE ON PURPOSE: no imports. The registry (./source.js) pulls in
// @/lib/glofox and the service-role client, which must never enter a browser
// bundle, so the select in src/components/settings/MembershipSourceCard.jsx
// reads this list instead. `registered` is a static mirror of
// MEMBERSHIP_SOURCES: src/lib/membership/source.test.js fails the moment the
// two disagree, so registering the un1t provider also means flipping it here
// (and nothing else: the route judges the registry, this only disables the
// option as a courtesy).
//
// Order = the mig 717 CHECK order.
export const MEMBERSHIP_SOURCE_CHOICES = Object.freeze([
  Object.freeze({
    key: 'none',
    label: 'No membership source',
    hint: 'Lead CRM only: pipeline, comms and events. Membership surfaces show "no membership source connected".',
    registered: true,
  }),
  Object.freeze({
    key: 'glofox',
    label: 'Glofox',
    hint: 'Memberships, bookings, credits, invoices and the class schedule come from Glofox. Enter the credentials on the Glofox tab.',
    registered: true,
  }),
  Object.freeze({
    key: 'un1t',
    label: 'UN1T',
    hint: 'The home-grown membership system. Not available yet.',
    registered: false,
  }),
])

export const NOT_AVAILABLE_YET_LABEL = 'not available yet'
