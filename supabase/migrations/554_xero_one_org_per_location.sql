-- XERO-ONE-ORG.3 — make "one location = one Xero organisation" structural.
--
-- Every business in the estate is a separate legal entity, so a tenant bound
-- to two locations files one company's bills into another company's books.
-- That is not hypothetical: three locations sat on the same tenant
-- ("Givers Consultancy LTD") because the OAuth callback took tenants[0], and
-- 101 bills / ~EUR 99k were posted to the wrong entity before anyone noticed.
--
-- #1470 fixed the callback and #1471 fixed the stale caches, but both are
-- application-level. This is the backstop: the database itself now refuses a
-- second location on the same tenant, so the rule survives a future code path
-- that forgets to ask (a bulk importer, a script, a hand-written INSERT).
--
-- It could not be applied until now — the constraint would have failed against
-- the live rows while they shared a tenant. Verified immediately before
-- writing this: SourceIt -> Givers Consultancy, UN1T Stillorgan -> Champ
-- Fitness Ltd, CCF Autos disconnected, and zero tenants shared by two rows.

-- 1. The rule. A named CONSTRAINT rather than a bare unique index so a
--    violation reports something a human can read.
ALTER TABLE xero_connections
  ADD CONSTRAINT xero_connections_tenant_id_unique UNIQUE (tenant_id);

COMMENT ON CONSTRAINT xero_connections_tenant_id_unique ON xero_connections IS
  'XERO-ONE-ORG.3 — one location = one Xero organisation, never shared. Each location is a separate legal entity; two locations on one tenant post one company''s bills into another''s books. Correct a wrong binding with "Change organisation" on the location''s Xero settings card.';

-- 2. The unique constraint creates its own index, so the old non-unique one on
--    the same column is now redundant (and would be flagged as a duplicate).
DROP INDEX IF EXISTS xero_connections_tenant_idx;

-- 3. One-time cleanup: disconnecting a location deleted its xero_connections
--    row but left its cached accounts / contacts / tax rates behind, keyed on
--    location_id (which still exists, so nothing cascaded). CCF Autos'
--    disconnect left 509 such rows. Those ids belong to an org this location
--    is no longer connected to, and if it is later reconnected to a DIFFERENT
--    org they would be offered in the pickers — the same wrong-org failure
--    this whole series is about. The route now purges on disconnect; this
--    clears what earlier disconnects left.
DELETE FROM xero_contacts  WHERE location_id NOT IN (SELECT location_id FROM xero_connections);
DELETE FROM xero_accounts  WHERE location_id NOT IN (SELECT location_id FROM xero_connections);
DELETE FROM xero_tax_rates WHERE location_id NOT IN (SELECT location_id FROM xero_connections);
