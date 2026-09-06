-- HOST-CONSENT.1 — a host's Postmark stream must never be one of the server's
-- shared streams. `broadcast` is UN1T's own marketing stream; putting a host
-- on it re-creates the shared-suppression-list coupling mig 588 removed.
-- Belt for the zod refine in /api/hosts/[id] (braces: a direct SQL write).
alter table event_hosts drop constraint if exists event_hosts_postmark_stream_id_check;
alter table event_hosts add constraint event_hosts_postmark_stream_id_check
  check (
    postmark_stream_id is null
    or (postmark_stream_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
        and postmark_stream_id not in ('broadcast', 'outbound', 'inbound'))
  );
