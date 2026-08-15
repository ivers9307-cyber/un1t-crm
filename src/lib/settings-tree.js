// SETTINGS.2g Task 3 — the settings tree: the seven-group structure that
// replaces the flat card grid on /settings (src/app/settings/page.js).
// Data-only module (mirrors src/lib/nav-items.js's split of "what's in the
// nav" from "how it renders") so the structure is a testable policy
// contract (settings-tree.test.js) instead of markup baked into the page.
//
// Gate vocabulary reuses the sidebar's (src/components/Sidebar.jsx
// `matches()`), extended with `roles` for the settings family's
// hardcoded-role pages (ADMIN_ROLES/MANAGER_ROLES/bespoke role lists —
// the sidebar itself has never needed an arbitrary role array, only the
// two legacy `masterOnly`/`masterOrOwnerOnly` booleans):
//   - { permission: 'key' }        — hasPermission(user, 'key')
//   - { anyPermission: ['a','b'] } — any one of the listed keys
//   - { roles: ['owner','master'] } — user.role is one of these (the
//     ACTIVE-LOCATION role, same field every gated sub-page itself reads)
//   - { masterOnly: true }         — user.profileRole === 'master' ||
//     user.role === 'master' (identical formula to Sidebar.jsx's
//     `masterOnly`, so a user impersonating a non-master will not see a
//     masterOnly row — same as they don't see masterOnly sidebar entries)
//   - { openToAll: true }          — visible to anyone who reached
//     /settings at all (the page itself already gates on the `settings`
//     permission, so this is not truly public — it's "no additional
//     narrowing")
// settingsRowVisible() below is the shared evaluator; the sidebar's own
// matches() is not reused directly because it's a closure over
// component-local `user`/`hasPerm` inside Sidebar.jsx, not exported.
//
// Row gates document PRODUCT-INTENDED visibility, not always the
// strictest technical requirement the destination page enforces — several
// rows are deliberately NARROWER than their page's own gate (see the
// per-row comments below for which, and why). A row never being LOOSER
// than its destination is what settings-tree.test.js's page-existence +
// gate-presence checks are for; product narrowing is a judgement call
// each row's comment states explicitly.
//
// Locations is NOT a row here. There is no /settings/locations index
// page — the destinations are /settings/locations/[id] (edit, one per
// location) and /settings/locations/new (master-only create). A single
// href can't represent "the list of every location", so — per the
// SETTINGS.2g Task 3 spec — the interactive location list + Add Location
// CTA stays inline inside the Workspace group's render in page.js,
// exactly as it worked before this tree existed, rather than being
// forced into a row shape that doesn't fit it.

import { MANAGER_ROLES, ADMIN_ROLES } from '@/lib/schemas'
import {
  CalendarDays, Tag, Store, LayoutGrid, Trophy, Cable,
  Users, UserPlus, UserCog,
  AtSign, Bell, Bot,
  Plug, Activity, Globe, Phone,
  CreditCard, Gauge,
  Download, KeyRound,
  ShieldCheck, Eye, Fingerprint, Lock,
} from 'lucide-react'

export const SETTINGS_TREE = [
  {
    id: 'workspace',
    label: 'Workspace',
    rows: [
      {
        id: 'holidays',
        label: 'Bank holidays',
        href: '/settings/holidays',
        description: 'Public holidays for this location, highlighted on the schedule — plus any custom closures.',
        icon: CalendarDays,
        // Mirrors the page's own gate exactly (MANAGER_ROLES).
        gate: { roles: MANAGER_ROLES },
      },
      {
        id: 'class-categories',
        label: 'Class categories',
        href: '/settings/class-categories',
        description: 'Tag each class cardio / strength / conditioning — powers the post-class report comparisons.',
        icon: Tag,
        // Mirrors the page's own gate exactly (MANAGER_ROLES).
        gate: { roles: MANAGER_ROLES },
      },
      {
        id: 'hosts',
        label: 'Event hosts',
        href: '/settings/hosts',
        description: 'Third-party organisers paid directly for their events via Stripe Connect — connect their account and set the per-ticket booking fee.',
        icon: Store,
        // Mirrors the page's own gate exactly (ADMIN_ROLES — money-handling,
        // matches the /api/hosts backend gate). Old grid placed this under
        // its own "Events" section; SETTINGS.2g Task 3 folds it into
        // Workspace (org-level operational config) rather than keeping a
        // one-row section.
        gate: { roles: ADMIN_ROLES },
      },
      // Master tools. PLACEMENT DECISION: Workspace, not Security. These
      // three are general platform administration (feature matrix,
      // achievements catalogue, service credentials) rather than
      // account-security surfaces — the Security group here is scoped to
      // audit/access/auth (audit log, access history, 2FA, SSO), so
      // bundling /admin/integrations' credentials store in there would
      // blur that group's theme. The old page.js grid put "Master tools"
      // as the very first section on the page; Workspace being the first
      // group in this tree is the closest match to that precedent.
      {
        id: 'admin-hub',
        label: 'Admin',
        href: '/admin',
        description: 'Feature matrix, audit log, achievements, and integrations in one hub.',
        icon: LayoutGrid,
        // NOTE: /admin's own page gate is slightly WIDER than masterOnly —
        // it also admits non-master holders of certain Studio-Management
        // child permissions (STUDIO-GROUP.1). The row gate here is
        // intentionally narrower (masterOnly), matching the old page.js
        // grid's "Master tools" section, which only ever rendered for
        // `user.role === 'master' || user.impersonatingFrom`. A
        // permission-holding non-master who needs /admin's child surfaces
        // reaches them via their OWN dedicated nav entries elsewhere, not
        // through this shortcut.
        gate: { masterOnly: true },
      },
      {
        id: 'admin-achievements',
        label: 'Achievements',
        href: '/admin/achievements',
        description: 'Manage the achievements catalogue members unlock.',
        icon: Trophy,
        gate: { masterOnly: true },
      },
      {
        id: 'admin-integrations',
        label: 'Platform integrations',
        href: '/admin/integrations',
        description: 'Master-only credentials store for platform-level service integrations.',
        icon: Cable,
        gate: { masterOnly: true },
      },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    rows: [
      {
        id: 'staff',
        label: 'Team members',
        href: '/settings/staff',
        description: 'Searchable list of every team member. Filter by status, role, location, or name.',
        icon: Users,
        // Mirrors the page's own gate exactly (hasPermission 'settings').
        gate: { permission: 'settings' },
      },
      {
        id: 'staff-new',
        label: 'Add staff',
        href: '/settings/staff/new',
        description: 'Create a new team member and set their location + permission access.',
        icon: UserPlus,
        // Mirrors the page's own gate exactly: master OR owner (NOT the
        // wider ADMIN_ROLES/MANAGER_ROLES — head_coach and manager are
        // excluded, matching StaffForm's location-grant restriction).
        gate: { roles: ['master', 'owner'] },
      },
      {
        id: 'impersonate',
        label: 'View as user',
        href: '/settings/impersonate',
        description: 'Sign in as another user to debug their experience. Every session is audited.',
        icon: UserCog,
        // The page itself stays reachable for a master mid-impersonation
        // (realMasterId falls back to impersonatingFrom.masterId) so they
        // can switch targets or stop. This row's masterOnly gate does NOT
        // carry that exception — same formula as every other masterOnly
        // row/sidebar entry — so it will not show while impersonating a
        // non-master. Accepted: a master mid-impersonation already has the
        // "Stop impersonating" banner as their way back; this row is the
        // discovery path for STARTING a session, not the escape hatch.
        gate: { masterOnly: true },
      },
    ],
  },
  {
    id: 'communications',
    label: 'Communications',
    rows: [
      {
        id: 'email-domain',
        label: 'Email domain',
        href: '/settings/email-domain',
        description: 'Send from your own verified domain on a dedicated mail server — your reputation, your analytics. Add-on.',
        icon: AtSign,
        // Mirrors the page's own gate exactly (hardcoded owner/master).
        gate: { roles: ['owner', 'master'] },
      },
      {
        id: 'notifications',
        label: 'Notification registry',
        href: '/settings/notifications',
        description: 'Every notification the CRM sends — who fires it, who receives it, lead-time config per category.',
        icon: Bell,
        // Mirrors the page's own gate exactly (hasPermission 'settings').
        gate: { permission: 'settings' },
      },
      {
        id: 'customer-agent',
        label: 'Customer agent',
        href: '/settings/customer-agent',
        description: 'The customer-facing WhatsApp / Instagram AI agent — channel connections, behaviour, and the knowledge it answers from. Off by default.',
        icon: Bot,
        // Mirrors the page's own gate exactly (MANAGER_ROLES).
        gate: { roles: MANAGER_ROLES },
      },
      {
        id: 'scoring',
        label: 'Scoring',
        href: '/settings/scoring',
        description: 'How UN1T Points are awarded — per-minute rate for each heart-rate zone, plus participation points for classes with no strap.',
        icon: Trophy,
        // Mirrors the page's own gate exactly (MANAGER_ROLES).
        gate: { roles: MANAGER_ROLES },
      },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    rows: [
      {
        id: 'integrations-hub',
        label: 'Integrations hub',
        href: '/settings/integrations-hub',
        description: 'Every tool your gym connects to — Glofox, Xero, WhatsApp, Instagram, Meta Ads — with health at a glance across your locations. Connect, test, and disconnect from one place.',
        icon: Plug,
        // Mirrors the page's own gate exactly (owner+/master).
        gate: { roles: ['owner', 'master'] },
      },
      {
        id: 'integration-health',
        label: 'Integration health',
        href: '/settings/integration-health',
        description: 'One pane showing whether anything is silently broken — scheduled jobs, the WhatsApp number, and webhook processing, each with a red/amber/green status.',
        icon: Activity,
        // NARROWER than the page's own gate (hasPermission 'settings' —
        // any settings-permission holder can open the URL directly).
        // Carried forward from the old page.js grid, which wrapped this
        // whole Integrations section in `(role === 'owner' || role ===
        // 'master')`. Deliberate: integration health is an
        // owner-operational surface by product intent, matching its
        // siblings in this group.
        gate: { roles: ['owner', 'master'] },
      },
      {
        id: 'status-page',
        label: 'Public status page',
        href: '/settings/status-page',
        description: 'The member-facing status page — edit the wording for each service and state. Members see a plain-language operational / degraded status, never internal detail.',
        icon: Globe,
        // NARROWER than the page's own gate (hasPermission 'settings') —
        // same carried-forward product decision as integration-health above.
        gate: { roles: ['owner', 'master'] },
      },
      {
        id: 'zoom-contacts',
        label: 'Zoom phone directory',
        href: '/settings/integrations/zoom-contacts',
        description: 'The nightly Zoom Phone contact sync — desired-state preview, run history, and rejected-contact diagnostics. Ships dark until the ZOOM_* secrets are set.',
        icon: Phone,
        // The orphan — SETTINGS.2g Task 3 finally links it. VERIFIED the
        // page's own gate: any authenticated user can open the URL (it
        // renders an org-scoped empty shell for non-members of the synced
        // org); write access needs 'integrations_zoom_manage' in that org.
        // This row is gated narrower — owner/master, matching every other
        // row in this group — per the Task 3 spec's explicit instruction
        // ("leave visible to owner/master").
        gate: { roles: ['owner', 'master'] },
      },
    ],
  },
  {
    id: 'billing',
    label: 'Billing & usage',
    rows: [
      {
        id: 'billing',
        label: 'Billing & usage',
        href: '/settings/billing',
        description: 'Your platform plan, usage against allowances, the usage wallet, and invoices — per location.',
        icon: CreditCard,
        // Mirrors the page's own gate exactly (hardcoded owner/master).
        gate: { roles: ['owner', 'master'] },
      },
      {
        id: 'usage',
        label: 'Usage & caps',
        href: '/settings/usage',
        description: 'Month-to-date AI, email, SMS and WhatsApp usage per location, plus optional hard caps that pause Mia or hold campaigns.',
        icon: Gauge,
        // Mirrors the page's own gate exactly (ADMIN_ROLES view tier —
        // the caps SAVE form itself is owner/master, enforced client-side
        // + by the PUT route, not by this row's visibility).
        gate: { roles: ADMIN_ROLES },
      },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    rows: [
      {
        id: 'glofox-import',
        label: 'Glofox import',
        href: '/admin/glofox-import',
        description: 'Interactive Glofox member import + sync history.',
        icon: Download,
        // Mirrors the page's own gate exactly.
        gate: { permission: 'glofox_import' },
      },
      {
        id: 'marketing-import',
        label: 'Preferences import',
        href: '/admin/marketing-import',
        description: 'Bulk import of marketing preferences (consent flags).',
        icon: Download,
        // Mirrors the page's own gate exactly.
        gate: { permission: 'preferences_import' },
      },
      {
        id: 'api-keys',
        label: 'API keys',
        href: '/settings/api-keys',
        description: 'Create and revoke keys for programmatic access (n8n and other integrations).',
        icon: KeyRound,
        // Mirrors the page's own gate exactly (hardcoded owner/master).
        gate: { roles: ['owner', 'master'] },
      },
      {
        id: 'landing-page',
        label: 'Landing page',
        href: '/settings/landing-page',
        description: 'Content + form settings for the public landing pages. The live page stays linked from the Marketing hub.',
        icon: Globe,
        // Mirrors the page's own gate exactly.
        gate: { permission: 'landing_page' },
      },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    rows: [
      {
        id: 'audit-log',
        label: 'Audit log',
        href: '/admin/audit-log',
        description: 'Unified record of authentication events, high-value business actions, and assignment / role changes across the platform.',
        icon: ShieldCheck,
        // Mirrors the page's own gate exactly (page-level master-only,
        // even though the /admin layout itself is relaxed for Studio
        // Management child permissions — STUDIO-GROUP.1).
        gate: { masterOnly: true },
      },
      {
        id: 'access-history',
        label: 'Account access history',
        href: '/account/access-history',
        description: 'See every time a master account has signed in as you.',
        icon: Eye,
        // Mirrors the page's own gate exactly — visible to every
        // authenticated user (trust-and-safety affordance: nobody can be
        // impersonated without being able to verify it later).
        gate: { openToAll: true },
      },
      // Static coming-soon rows. No destination page exists yet — href is
      // null and rendered inert (no Link, no hover affordance). Carried
      // forward verbatim from the old page.js grid's Security card.
      {
        id: 'two-factor-auth',
        label: 'Two-Factor Authentication',
        href: null,
        description: 'Require 2FA for all team members. Coming soon.',
        icon: Fingerprint,
        gate: { openToAll: true },
      },
      {
        id: 'sso',
        label: 'Single Sign-On (SSO)',
        href: null,
        description: 'Connect your identity provider via SAML. Coming soon.',
        icon: Lock,
        gate: { openToAll: true },
      },
    ],
  },
]

// settingsRowVisible(gate, user, hasPerm) — the shared evaluator every row
// is filtered through, both in settings-tree.test.js and in
// src/app/settings/page.js. `hasPerm` is a (key) => boolean predicate —
// callers pass `(key) => hasPermission(user, key)` so this module never
// has to import @/lib/permissions itself (keeps it a pure data + policy
// module, same split nav-items.js/command-palette.js use).
export function settingsRowVisible(gate, user, hasPerm) {
  if (!gate) return false
  if (gate.openToAll) return !!user
  if (gate.masterOnly) return user?.profileRole === 'master' || user?.role === 'master'
  if (gate.roles) return gate.roles.includes(user?.role)
  if (gate.anyPermission) return gate.anyPermission.some((k) => hasPerm(k))
  if (gate.permission) return hasPerm(gate.permission)
  return false
}

// A group is worth rendering only if at least one of its rows is visible
// to the current user — an empty-header group (every row filtered out)
// would just be dead chrome.
export function visibleSettingsTree(user, hasPerm) {
  return SETTINGS_TREE
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => settingsRowVisible(row.gate, user, hasPerm)),
    }))
    .filter((group) => group.rows.length > 0)
}
