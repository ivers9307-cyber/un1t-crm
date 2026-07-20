# Personal data breach response runbook (SAAS4-C4)

Roles: for tenant gyms' member data, **Champ Fitness Ltd is the
processor** — the affected tenants are the controllers who own the
72-hour DPC clock for their members. For UN1T's own gyms' data, Champ
Fitness Ltd is the controller and owns that clock directly. The DPA
commits us to notifying affected tenant controllers **without undue
delay, target 48 hours** from awareness.

## 1. Detect & confirm (hour 0)

Signals: error tracker / sentinel alerts, `tenant_cron_health`
anomalies, Supabase auth/logs, a report from staff or a tenant.
Confirm it is a personal-data breach (confidentiality, integrity or
availability of personal data) vs an operational outage. Start a
timestamped incident note immediately — the record of "when we became
aware" matters legally.

## 2. Contain (hours 0–4)

Do the least destructive thing that stops the bleed, in this order of
preference: rotate the exposed credential (service-role key rotation
runbook in `docs/INFRA_BACKLOG.md` #5) · suspend the affected surface
(tenant suspend route; `tenant_domains.active=false`; disable the
integration row) · Vercel rollback to a known-good deploy. Preserve
evidence before destroying anything (PITR point, log exports).

## 3. Assess scope (hours 2–24)

Use what already exists: `audit_events` (who touched what, IP/UA),
`email_sends` / message tables (what left the platform), per-tenant
`usage_events` (anomalous AI calls), Supabase auth logs (logins),
`glofox_sync_runs`. Answer per tenant: whose members, which data
categories, what window, ongoing or stopped. Special-category exposure
(member-app module tenants only) escalates severity.

## 4. Notify (within 48h of awareness; earlier is better)

- **Affected tenant controllers** — via their `ops_alert_emails`
  (org_settings) and direct contact: what happened, categories and
  approximate counts, likely consequences, measures taken, our contact
  point. They decide their DPC (72h from THEIR awareness — our notice
  starts it) and data-subject notifications; assist on request.
- **Where Champ Fitness Ltd is controller** (UN1T's own gyms): assess
  Article 33 — notify the DPC within 72 hours unless the breach is
  unlikely to result in risk; notify data subjects if high risk
  (Article 34). DPC breach portal: forms.dataprotection.ie.
- Do not speculate in notices; supplement in phases as facts firm up.

### Tenant notice template

> Subject: Security incident affecting [Gym] member data — notice from
> your platform provider
>
> On [date/time] we became aware of [summary]. Data involved:
> [categories], approximately [n] of your members, window [from–to].
> We have [containment]. Likely consequences: [assessment]. We
> recommend [actions]. As controller you may need to notify the Data
> Protection Commission within 72 hours of this notice; we will
> provide any further information you need. Contact:
> privacy@un1tdublin.com. We will update you by [time].

## 5. Recover & close

Rotate remaining secrets, restore service, verify with the
cross-tenant harness and `/admin/health`. Post-incident record (kept
with the incident note): timeline, root cause, data assessment, who
was notified when, remediation items → issues/backlog. Article 33(5)
requires documenting the breach **even when no DPC notification was
required** — file the record regardless.
