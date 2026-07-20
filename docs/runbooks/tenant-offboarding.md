# Tenant offboarding runbook (SAAS4-P4)

Settled policy (Richard, 2026-07-19): **suspend → export → 60 days retention → delete.**
Suspension is reversible and instant; deletion is manual, master-run, and final.

## 1. Suspend (day 0)

```
POST /api/admin/orgs/<org_id>/suspend        # master session
```

One call flips the org **and all its locations** inactive, which every existing
`active = true` filter then enforces: staff lose the locations from their
location lists, the loop-over-locations crons (glofox-sync, data-quality,
cap notices) skip them, and admin surfaces hide them. Reversible at any time:

```
DELETE /api/admin/orgs/<org_id>/suspend      # unsuspend
```

Also, separately:

- **Park the hostname:** set `tenant_domains.active = false` for the org's rows
  (`PATCH /api/admin/tenant-domains/<id>`) — the subdomain falls through to the
  CRM auth gate without losing the config.
- **Plans/wallets:** end the location's plan assignment on the plans track
  (`/admin/plans`); wallets stop resetting for inactive locations.

## 2. Export (during the retention window)

The DPA's return-of-data obligation. Per contact, the DSAR bundle:

```
GET /api/contacts/<id>/export                # full JSON bundle per member
```

For the org-level bundle, run per-table CSV pulls scoped by the org's
location ids (contacts, contact_preferences, consent_log, email_sends,
bookings, activities, notes, whatsapp_* , instagram_*, invoices_queue).
Deliver via a private storage bucket + signed URL (7-day expiry), never email.

## 3. Delete (day 60+, manual, master-run)

There is deliberately **no delete endpoint**. Deletion is a supervised SQL
session via the Supabase MCP against the un1t-crm project, in this order:

1. Re-confirm: org suspended ≥60 days; export delivered and acknowledged.
2. Snapshot: note the PITR point / take a manual backup first.
3. Delete the org's **locations** one at a time:
   `DELETE FROM locations WHERE id = '<loc>';`
   — nearly every tenant table cascades from `location_id`
   (`ON DELETE CASCADE`); tables with `SET NULL` (e.g. usage_events)
   retain anonymous rows by design.
4. Delete org-keyed rows: `org_settings`, `tenant_domains`, `api_keys`,
   `chooser_settings` (per-org row), then `DELETE FROM organizations WHERE id = …;`
5. Storage: remove the org's path-prefixed objects in each bucket
   (branding, inbound-invoices, contractor-invoices, …).
6. Auth users: deactivate/delete the org's staff in Supabase Auth if they
   hold no other org assignments.
7. Verify: the SAAS-10 cross-tenant harness fixtures still pass; the org id
   returns nothing across `/api` list surfaces.
8. Log it: keep the export-delivery note + deletion date in the audit trail
   (an `audit_events` row is written by hand: category `admin`,
   action `org_delete`).

## Notes

- Stripe: cancel the org's subscription on the billing track **before**
  step 3 (no dunning against a deleted tenant).
- `usage_events` / `usage_rollups_daily`: location FK is `SET NULL` /
  `CASCADE` respectively — aggregate financial history stays, per-tenant
  attribution goes. That is intentional (spend accounting survives).
