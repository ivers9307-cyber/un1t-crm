-- APPROVALS-PERCAT.1 (mig 378) — approvals_inbox is now a DERIVED web
-- permission (any-of-six), no longer a stored grant. Strip the inert key
-- from the two grant blobs. Data-only, forward-only, idempotent.
-- locations.features.approvals_inbox is intentionally left untouched — it
-- remains the location feature gate for the aggregator inbox.

update profile_locations
   set permissions = permissions - 'approvals_inbox'
 where permissions ? 'approvals_inbox';

update location_role_permissions
   set permissions = permissions - 'approvals_inbox'
 where permissions ? 'approvals_inbox';
