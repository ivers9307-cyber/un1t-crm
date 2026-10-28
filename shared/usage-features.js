// USAGE.1 — the app usage feature registry: one list of feature keys shared
// by the phone app, the web CRM, the ingest route and the report.
//
// A screen is recorded as a FEATURE KEY only. The path never leaves the
// device: a path can carry a contact, booking or invoice id, and the design
// (docs/superpowers/specs/2026-10-26-app-usage-design.md) promises staff
// that the record never says which record they looked at.
//
// Phone and web share a key wherever they are the same job (Contacts on the
// phone and on the web are both `contacts`), so the report can show one
// feature row with a phone/web split. Paths are resolved by longest prefix,
// segment-aware (`/contacts` matches `/contacts` and `/contacts/…`, never
// `/contactsfoo`). An unmapped path is `other`; the coverage test
// (tests/usage-features-coverage.test.js) makes a new top-level route
// decide its key.

export const USAGE_FEATURES = Object.freeze([
  { key: 'home', label: 'Home' },
  { key: 'dashboard', label: 'Dashboards' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'inbox', label: 'WhatsApp and Instagram' },
  { key: 'email', label: 'Email' },
  { key: 'campaigns', label: 'Campaigns and marketing' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'schedule', label: 'Rota' },
  { key: 'checklists', label: 'Checklists' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'expenses', label: 'Expenses and receipts' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'orders', label: 'Orders and offers' },
  { key: 'cars', label: 'Cars' },
  { key: 'events', label: 'Events' },
  { key: 'races', label: 'Races' },
  { key: 'challenges', label: 'Challenges' },
  { key: 'live', label: 'Live heart rate' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'policies', label: 'Policies' },
  { key: 'staff', label: 'Staff' },
  { key: 'controls', label: 'Studio controls' },
  { key: 'tv', label: 'TVs and presentations' },
  { key: 'timer', label: 'Timer' },
  { key: 'assistant', label: 'Assistant' },
  { key: 'issues', label: 'Issues' },
  { key: 'radar', label: 'Radar' },
  { key: 'settings', label: 'Settings' },
  { key: 'account', label: 'My account' },
  { key: 'platform', label: 'Platform console' },
  { key: 'other', label: 'Other' },
].map((f) => Object.freeze(f)))

const KEYS = new Set(USAGE_FEATURES.map((f) => f.key))
const LABELS = new Map(USAGE_FEATURES.map((f) => [f.key, f.label]))

export function isUsageFeature(key) {
  return typeof key === 'string' && KEYS.has(key)
}

export function usageFeatureLabel(key) {
  return LABELS.get(key) || LABELS.get('other')
}

// Web paths (Next.js App Router, route groups already stripped by
// usePathname). Hubs (/sales, /money, /team …) are landing pages, filed under
// the hub's main job.
const WEB_PREFIXES = [
  ['/', 'home'],
  ['/dashboard', 'dashboard'],
  ['/portfolio', 'dashboard'],
  ['/contacts', 'contacts'],
  ['/sales', 'contacts'],
  ['/members', 'contacts'],
  ['/pipeline', 'pipeline'],
  ['/activities', 'tasks'],
  ['/communications', 'campaigns'],
  ['/communications/inbox', 'inbox'],
  ['/communications/mail', 'email'],
  ['/communications/tickets', 'email'],
  ['/marketing', 'campaigns'],
  ['/automations', 'campaigns'],
  ['/bookings', 'bookings'],
  ['/schedule', 'schedule'],
  ['/team', 'schedule'],
  ['/checklists', 'checklists'],
  ['/operations', 'checklists'],
  ['/maintenance', 'maintenance'],
  ['/approvals', 'approvals'],
  ['/card-receipts', 'expenses'],
  ['/invoices', 'invoices'],
  ['/money', 'invoices'],
  ['/accounting', 'accounting'],
  ['/orders', 'orders'],
  ['/offer-sales', 'orders'],
  ['/class-fees', 'orders'],
  ['/cars', 'cars'],
  ['/events', 'events'],
  ['/hyrox', 'races'],
  ['/challenges', 'challenges'],
  ['/achievements', 'challenges'],
  ['/pulse', 'live'],
  ['/live', 'live'],
  ['/contracts', 'contracts'],
  ['/policies', 'policies'],
  ['/settings/staff', 'staff'],
  ['/studio-management', 'controls'],
  ['/studio-management/timer', 'timer'],
  ['/tv-displays', 'tv'],
  ['/presentations', 'tv'],
  ['/issues', 'issues'],
  ['/settings', 'settings'],
  ['/account', 'account'],
  ['/admin', 'platform'],
  ['/api-docs', 'platform'],
]

// Phone paths (Expo Router usePathname: groups stripped, the (tabs) index is
// '/'). Folder screens and tab screens share their first segment.
const PHONE_PREFIXES = [
  ['/', 'home'],
  ['/dashboard', 'dashboard'],
  ['/studio', 'dashboard'],
  ['/contacts', 'contacts'],
  ['/pipeline', 'pipeline'],
  ['/tasks', 'tasks'],
  ['/whatsapp', 'inbox'],
  ['/instagram', 'inbox'],
  ['/email', 'email'],
  ['/bookings', 'bookings'],
  ['/schedule', 'schedule'],
  ['/checklists', 'checklists'],
  ['/maintenance', 'maintenance'],
  ['/approvals', 'approvals'],
  ['/expenses', 'expenses'],
  ['/card-receipts', 'expenses'],
  ['/invoices', 'invoices'],
  ['/accounting', 'accounting'],
  ['/orders', 'orders'],
  ['/cars', 'cars'],
  ['/events', 'events'],
  ['/race', 'races'],
  ['/races', 'races'],
  ['/hyrox', 'races'],
  ['/contracts', 'contracts'],
  ['/policies', 'policies'],
  ['/staff', 'staff'],
  ['/controls', 'controls'],
  ['/ac', 'controls'],
  ['/doors', 'controls'],
  ['/shelly', 'controls'],
  ['/sonos', 'controls'],
  ['/tv', 'tv'],
  ['/timer', 'timer'],
  ['/assistant', 'assistant'],
  ['/issues', 'issues'],
  ['/radar', 'radar'],
  ['/settings', 'settings'],
  ['/location-features', 'settings'],
  ['/customise-bar', 'settings'],
  ['/more', 'settings'],
  ['/impersonate', 'platform'],
]

function sortByLength(table) {
  return [...table].sort((a, b) => b[0].length - a[0].length)
}

const WEB_SORTED = sortByLength(WEB_PREFIXES)
const PHONE_SORTED = sortByLength(PHONE_PREFIXES)

function resolve(sorted, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return 'other'
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  for (const [prefix, key] of sorted) {
    if (prefix === '/') {
      if (path === '/') return key
      continue
    }
    if (path === prefix || path.startsWith(prefix + '/')) return key
  }
  return 'other'
}

export function featureForWebPath(pathname) {
  return resolve(WEB_SORTED, pathname)
}

export function featureForPhonePath(pathname) {
  return resolve(PHONE_SORTED, pathname)
}

// For the coverage test.
export const _USAGE_PREFIXES = Object.freeze({ web: WEB_PREFIXES, phone: PHONE_PREFIXES })
