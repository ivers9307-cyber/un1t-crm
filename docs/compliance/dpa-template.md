# Data Processing Agreement — template (SAAS4-C4)

> **DRAFT for solicitor review.** Items marked **[SOLICITOR]** are legal
> judgment calls, not defaults. Settled inputs baked in (Richard,
> 2026-07-19): processor entity = **Champ Fitness Ltd**; health data is
> bound to the member-app (Pulse) module; offboarding = suspend →
> export → 60-day retention → deletion.

**Parties.** This DPA forms part of the master services agreement (the
"Agreement") between **Champ Fitness Ltd** ("Processor", the platform
operator) and the customer identified in the Agreement ("Controller",
the gym operator). It applies to personal data the Processor processes
on the Controller's behalf in providing the platform.

## 1. Subject matter, duration, nature and purpose

- **Subject matter:** operation of the gym-management platform (CRM,
  bookings, communications, billing support) for the Controller's
  locations.
- **Duration:** the term of the Agreement plus the 60-day
  post-termination retention window (clause 10).
- **Nature and purpose:** hosting, storage, transmission, automated
  messaging (email/SMS/WhatsApp/Instagram), AI-assisted replies where
  the Controller enables them, and reporting — always on the
  Controller's documented instructions, which the Agreement and the
  platform's settings constitute.

## 2. Categories of data subjects and data

- **Data subjects:** the Controller's members, leads, event attendees,
  and website visitors; the Controller's staff users.
- **Personal data:** identity and contact details; membership, booking
  and attendance records; message content and history; marketing
  preferences and consent records (including IP/user-agent
  proof-of-consent); payment records (never full card numbers).
- **Special categories:** none on standard plans. Where the Controller
  enables the member-app module, health and fitness data (PAR-Q
  responses, body-composition results, heart-rate data) is processed
  solely within that module; the Controller is responsible for its
  Article 9 basis (normally explicit consent). **A Controller without
  the module has no special-category data on the platform.**

## 3. Controller obligations

The Controller warrants it has a lawful basis for the processing it
instructs, provides required privacy notices to its members (the
platform serves a templated notice at the Controller's domain once its
legal identity is configured), and is responsible for the accuracy of
data it or its members submit.

## 4. Processor obligations

The Processor shall: process only on documented instructions (including
regarding international transfers); ensure persons authorised to
process are bound by confidentiality; implement the technical and
organisational measures in Annex A; assist the Controller with data
subject requests (clause 8) and Articles 32–36 obligations; make
available information reasonably necessary to demonstrate compliance;
and allow audits per clause 9.

## 5. Subprocessors

General authorisation. The current register is published at
`/legal/subprocessors` and incorporated by reference. The Processor
gives at least **30 days' notice** of new subprocessors handling the
Controller's member data; the Controller may object on reasonable
data-protection grounds, and if no workaround is agreed may terminate
the affected service without penalty **[SOLICITOR: termination scope]**.
The Processor remains liable for its subprocessors' performance.

## 6. International transfers

Primary processing and storage occur in the EU (Ireland). Where a
subprocessor processes personal data outside the EEA (see the
register), transfers rely on the European Commission's Standard
Contractual Clauses or an applicable adequacy mechanism (including the
EU-US Data Privacy Framework where certified).

## 7. Security (summary — detail in Annex A)

Encryption in transit and at rest; tenant isolation enforced in the
application layer with database row-level security as defence in depth
and a continuously-run cross-tenant regression harness; role-based
access control with per-location permissions; audited administrative
access; monitoring with per-tenant health alerting; point-in-time
database recovery.

## 8. Data subject rights

The platform provides the Controller self-service tooling: per-member
subject-access export (full JSON bundle) and erasure (hard delete with
message redaction). The Processor forwards any request it receives
directly to the Controller without undue delay and does not respond to
it save on the Controller's instruction.

## 9. Audit

The Processor provides audit information on request no more than once
per year **[SOLICITOR: cadence and cost allocation]**, and permits
audits by the Controller or its mandated auditor subject to reasonable
notice, confidentiality, and non-disruption terms.

## 10. Return and deletion

On termination: the account is suspended (service stops, data intact);
the Controller may take its export during a **60-day** retention
window; after the window the Processor deletes the Controller's
personal data from production systems, retaining only anonymised
aggregates (e.g. de-attributed usage accounting) and records the
Processor must keep by law.

## 11. Personal data breach

The Processor notifies the Controller **without undue delay** after
becoming aware of a personal data breach affecting the Controller's
data — target within **48 hours** — with the information Article 33(3)
requires, supplemented as it becomes available (process:
`docs/runbooks/breach-response.md`). The Controller remains responsible
for its own notifications to the DPC and to data subjects.

## 12. Liability **[SOLICITOR]**

Liability allocation and caps per the Agreement. **[SOLICITOR: whether
the Agreement cap applies to data-protection liability, carve-outs,
and insurance requirements.]**

---

### Annex A — Technical and organisational measures **[maintained]**

- EU-hosted managed Postgres (encryption at rest) and TLS everywhere.
- Application-layer tenant scoping on every route; DB row-level
  security as defence in depth; automated cross-tenant regression
  tests and a location-scoping CI gate on every change.
- RBAC with per-location roles/permissions; master actions audited
  (IP + user agent) in an append-only audit log.
- Secrets in platform-managed configuration; per-tenant integration
  credentials stored per location; no credentials in code.
- Monitoring: global and per-tenant cron heartbeats, connection-health
  checks, spend metering with operator alerting.
- Backups: daily, with point-in-time recovery enabled.
- Personnel: access on a need-to-operate basis under confidentiality.
