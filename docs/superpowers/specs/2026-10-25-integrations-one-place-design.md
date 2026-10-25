# Integrations in one place — design (INTEGONE.1)

**Date:** 2026-10-25 · **Owner:** Richard Ivers · **Status:** approved in chat, building

## Intent

Richard: *"I want everything related to integrations and all its features to live in one location."*

`/settings/integrations-hub` (INTEG-B1/B4) is already the front door: the account menu's
Integrations item, the Settings index row and the bare per-location Integrations tab all
land there. But the hub was built as a dashboard with thin connect/disconnect drawers, and
every drawer ends in an "Advanced settings" link back to the old per-location tab
(`/settings/locations/<id>?tab=<provider>`, `LocationIntegrations.jsx`). Three things exist
*only* on that old tab (un1t.online, Payments, Membership source) and the heavy per-provider
config (Xero accounts/contacts sync, WhatsApp studio controls, climate device table, BCA
document slots, Glofox trainer/membership maps) never moved. Integration health, the
organisation's WhatsApp numbers and the Zoom phone directory sit on three more pages.

After this change the hub is the **only** integrations surface. Nothing it opens links back
out to another settings page for "the rest of" an integration.

## Goals

1. Every per-location integration's full configuration is reachable and editable from the hub,
   in a drawer, with no "Advanced settings" escape hatch.
2. The per-location Integrations tab is gone. Every URL that used to open it redirects into the
   hub with the right drawer open.
3. Integration health, the organisation's WhatsApp numbers and the Zoom phone directory are views
   inside the hub; their old URLs redirect.
4. No change to any route that writes credentials, no change to any send/routing path. This is a
   UI consolidation.

## Non-goals / anti-goals

- No redesign of the tab components themselves. They are **hosted**, not rewritten (the Phase 1
  pattern that already hosts `AdsIntegrationTab` and `ConnectionsSection` inline).
- No new mutation routes. One new **read** route only (below).
- No change to Shelly (`/automations/shelly`, a device-control surface under Automations —
  the hub keeps its card + Open link; `docs/BACKLOG.md` records why), the Public status page
  (member-facing wording, not an integration), Webhook dead letters (an ops queue) or Service
  credentials (platform-level, master). These stay where they are. **Richard's call to revisit.**
- Anti-goal: widening who can see a credential. The drawer receives exactly what the old page
  prop carried — `toClientLocation(row)` (AC keys replaced by `has_*`, every other secret masked,
  `bca_config` intact) — and nothing more.

## Constraints (house rules that bite here)

- Service-role routes bypass RLS: the new read route must `assertLocationAccess` (404) and
  `guardMasterOrOwner` AT the target location (the old page's two gates), and name its columns.
- `check:location-scoping` scans the new route; `guardMasterOrOwner(` is a registered scoping
  helper. Register the route in `src/lib/openapi.js`. `check:route-guards` needs `getCurrentUser`.
- `check:select-columns` resolves every literal column; copy the old page's select strings.
- Public-path allowlists are untouched (every page here is auth-gated).
- `tests/location-settings-target.test.js` and `tests/role-ui-pages.test.js` name
  `LocationIntegrations.jsx`; both need updating when it is deleted.
- No subagent commits (their `Co-Authored-By` trailer is wrong); the reviewer commits.

## The design

### 1. One read route for the drawer's context

`GET /api/integrations/hub/locations/[id]` (session only; owner at that location or master).

Returns, under `{ success, data }`, exactly what `/settings/locations/[id]/page.js` assembles
today for `LocationIntegrations`:

```
location               toClientLocation(row)           // select('*') then shape, as the page does
xeroConnection         the 15-column xero_connections row or null
xeroReadFailed         boolean (CHANNELREAD.1: a failed read is never "not connected")
sampleBcaCar           one car row or null (only when features.bca_submit)
membershipSource       membershipSourceState(db, id)
hasUn1tOnlineConnection boolean (count of active un1t_online channel_connections; a failed count → true)
viewer: {
  isMaster, isOwnerOrMaster, ownsWhatsAppHere, canSwitchWhatsApp, canManageNumbers
}
```

The `viewer` flags are the five role expressions `LocationIntegrations.jsx` computes
(`user.role === 'master'`, `hasRoleAtLocation(user, id, ['owner'])`, `hasRoleAtLocation(user,
id, ADMIN_ROLES)`, `isOrgAdmin(user, location.organization_id)`), computed server-side so the
drawer never reasons about roles. Move the assembly into `src/lib/integrations-hub-location.js`
(`loadHubLocationContext(db, user, locationId)`) so the route and a test share it, and so the
old page's identical reads can be deleted rather than duplicated.

### 2. The drawer hosts the full tab per card

`IntegrationsHubDrawer` fetches the context when it opens (`loading` → `error` with Try again →
body). Body per `cardKey`:

| cardKey | hosted component | props |
|---|---|---|
| `glofox` | `GlofoxIntegrationTab` | `location, canEdit=isOwnerOrMaster` |
| `un1t-online` | `Un1tOnlineIntegrationTab` | `location, canEdit=isOwnerOrMaster` |
| `membership-source` | `MembershipSourceCard` | `locationId, membershipSource, canEdit=isOwnerOrMaster` |
| `payments` | `PaymentsIntegrationTab` | `location, canEdit=isOwnerOrMaster` |
| `xero` | `XeroIntegrationTab` | `location, connection, readFailed` |
| `whatsapp` | `WhatsAppIntegrationTab` | `location, canEdit=ownsWhatsAppHere, canManageNumbers, canSwitch, onChanged` |
| `instagram` | `ConnectionsSection` (unchanged) | |
| `ads` | `AdsIntegrationTab` (unchanged) | |
| `unifi` | `UnifiIntegrationTab` | `location, canEdit=isMaster` |
| `climate` | `AcDevicesIntegrationTab` | `location, canEdit=isOwnerOrMaster, canManage=isMaster` |
| `bca` | `BcaIntegrationTab` | `location, canEdit=isMaster, sampleCar` |
| `whatsapp-numbers` | `OrgWhatsAppNumbers` (org-level; stage 3) | `organizationId, organizationName, locations` |

Deleted from the drawer: `IntegrationCredForm` + its `PROVIDER_SPECS`, `XeroPanel`,
`WhatsAppPanel`, `TAB_KEY`, `DEEP_LINK_LABEL`, the footer deep link. The Xero
connect/reconnect inside `XeroLocationCard` must keep bouncing back to the hub: pass
`return_to=/settings/integrations-hub?manage=xero&location=<id>` (the return-to allowlist
matches on path, so the query passes). `XeroCallbackNotice` already renders on the hub page.

`onChanged` semantics stay: a save inside a hosted tab calls the drawer's `onChanged`, which
refetches `/api/integrations/hub` so the card chips re-grade. Tabs that `router.refresh()`
today keep doing so — the hub page is `force-dynamic`, so a refresh re-renders the cards.

### 3. New cards, and URL-driven drawers

- **Payments** card (per location, owner+/master): status from
  `settings.payments.provider`/`stripe_connected_account_id` exactly as the old tab dot; Manage
  opens `payments`.
- **Membership source** card (per location, owner+/master): the state from `membershipSourceState`
  (`none | configured | unconfigured | unknown`) with the source name; Manage opens
  `membership-source`. Sits first in the tier-1 column, since Glofox/un1t.online hang off it.
- **un1t.online** card: its Open becomes Manage → `un1t-online`.
- The hub reads `?manage=<cardKey>&location=<id>` (and `?view=…`, stage 3) on mount and opens
  that drawer; the assembler's `locationTabHref` becomes `hubManageHref(locationId, cardKey)`
  returning that URL. Closing the drawer clears the params (`router.replace`).
- A `manage` the viewer cannot open (card not rendered for them) is ignored, not an error.

### 4. Retiring the old tab

- `/settings/locations/[id]`: drop the Integrations tab from the strip, the
  `LocationIntegrations` import and the five reads only it needed. Any request with
  `?section=integrations` or `?tab=<x>` redirects to
  `/settings/integrations-hub?manage=<card>&location=<id>` where `<card>` maps the old tab key
  (`ac-devices → climate`; every other key is the same; unknown → no `manage`).
- Delete `LocationIntegrations.jsx` and its five test files. Their tab-visibility assertions
  (who sees Xero/Payments/Ads/un1t.online/WhatsApp/AC/BCA) are already answered by the hub
  assembler's row gates and the drawer's server-side `viewer` flags; port the ones that still say
  something (the un1t.online offer rules, the AC `has_sensibo_key` presence rule, the Xero
  read-failed state) onto the context route test or the drawer test.
- Repoint every producer of the old URL: `src/lib/membership/state-for-page.js`,
  `ConnectionsSection.jsx` Manage link, `CustomerAgentClient.jsx` Instagram link,
  `XeroCallbackNotice.jsx` comment, `/api/xero/callback` default redirect, the Stripe Connect
  `returnUrl`/`settingsUrl` (`?manage=payments&location=<id>&stripe=return`), `XeroIntegrationTab`'s
  ReadFailedNote href, `BcaIntegrationTab`/`XeroLocationCard` comments. `src/lib/xero/return-to.js`
  keeps the hub in its allowlist; the `LOCATION_TAB_RE` branch can go once no producer remains
  (its test updated).
- `docs/architecture/INTEGRATIONS.md` lines that name `?tab=xero` are updated.

### 5. The other three pages become hub views (stage 3)

- **Health:** `/settings/integrations-hub?view=health` renders the body of
  `/settings/integration-health` as a client panel (`IntegrationHealthPanel`) fetching
  `/api/integrations/health?location_id=<id>` for the hub's selected location (the scope picker;
  default the active location). The route gains an optional `location_id` guarded by
  `assertLocationAccess` (404). `/settings/integration-health` redirects to the hub view.
  Gate note: the health page admitted any `settings` holder; the hub is owner+/master. The
  Settings tree already hid the row from non-owners "by product intent" — this makes the page
  match the row.
- **Organisation WhatsApp numbers:** the WhatsApp card header gets **Organisation numbers**
  (org admins only, `canManageBilling`-style flag from the page: `isOrgAdmin` for the card's
  org) opening the `whatsapp-numbers` drawer hosting `OrgWhatsAppNumbers`.
  `/settings/whatsapp-numbers` redirects to `?manage=whatsapp-numbers`; `ORG_NUMBERS_PAGE`
  (`src/lib/org-whatsapp-numbers-page.js`) is repointed so every existing link follows.
- **Zoom phone directory:** `?view=zoom` renders the existing page's content (its data loads in
  the hub page server-side when `view=zoom`, same reads as the page, same org-scoping); the old
  page redirects. Its `Controls.jsx` is reused as-is.
- `src/lib/settings-tree.js`: the Integrations group keeps **Integrations hub** (description
  widened to name health, numbers and Zoom), **Public status page** and **Webhook dead letters**;
  the `integration-health` and `zoom-contacts` rows go. `tests` on the tree updated.

## What is left to the builder

- Exact drawer width/scroll for the heavy tabs (WhatsApp is ~700 lines of cards; the drawer
  already body-scrolls; widen to `max-w-2xl` if a hosted table needs it).
- Loading/error skeleton inside the drawer (reuse `ReadFailedNote`'s wording; Try again refetches).
- Where `XeroCallbackNotice` renders once the tab is hosted (it renders on the hub page already;
  do not render it twice).
- Test shape: RTL for the drawer (hosted component mounts with the right props, the fetch URL,
  error state), vitest for the context lib and route (gates, column lists, viewer flags).

## Stages

1. Context route + lib; drawer hosts all tabs; Payments + Membership source cards; un1t.online
   Manage; `?manage=&location=` support; thin panels deleted. (Opus)
2. Old tab retired: page redirect, deletions, every producer repointed, return-to, docs. (Opus)
3. Health / org numbers / Zoom views + redirects; settings tree. (Sonnet)
4. Reviewer: CI mirror, `next build`, changelog entry, PR.
