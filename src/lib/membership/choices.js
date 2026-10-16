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
  // The KEY is the mig 717 CHECK value; the LABEL is tenant-neutral copy
  // (this select is staff-visible in every tenant, and nothing says UN1T —
  // Wave 1's whole point). When src/lib/membership/sources/un1t.js lands,
  // its `label` must equal this one (source.test.js pins registered labels).
  Object.freeze({
    key: 'un1t',
    label: 'Built-in memberships',
    hint: 'Memberships run inside this platform, with no external system. Coming soon.',
    registered: false,
  }),
  // UN1TSYNC.5 — Hatch Street's gym platform. Registered (src/lib/membership/
  // sources/un1t-online.js); its label must equal that provider's, which
  // source.test.js pins. 'un1t' above stays reserved for built-in memberships.
  Object.freeze({
    key: 'un1t_online',
    label: 'un1t.online',
    hint: 'Members, subscriptions, payments and bookings are read from un1t.online every 15 minutes. Connect it on the un1t.online tab.',
    registered: true,
  }),
])

export const NOT_AVAILABLE_YET_LABEL = 'not available yet'

/**
 * The `warning` PUT /api/locations/[id]/membership-source carries when a
 * switch to 'none' left an active Glofox registry row in place (the switch
 * never deletes a credential). Here, not in the route, so the card imports
 * it without importing server code.
 */
export const GLOFOX_CREDENTIALS_KEPT = 'glofox_credentials_kept'
