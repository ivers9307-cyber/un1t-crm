-- 403_storage_private_bucket_deny.sql
-- Close a storage.objects read-policy gap on private buckets. Several PERMISSIVE
-- policies were each written as `using (bucket_id <> '<own-bucket>')`; because
-- RLS ORs permissive policies, their union evaluated true for every bucket,
-- granting anon/authenticated SELECT on private buckets that should have been
-- default-deny. All legitimate reads use the service-role client (BYPASSRLS) or
-- signed-upload tokens, so restricting anon/authenticated changes nothing for
-- them; public buckets are served via the CDN and are unaffected. Replaces the
-- flawed policies with one consolidated RESTRICTIVE deny across the private
-- buckets (contracts keeps its own scoped authenticated read policies). Applied
-- to prod via Supabase MCP; verified anon can no longer read private buckets.

-- Drop the flawed PERMISSIVE policies (the OR of these was the gap).
drop policy if exists "deny all on company-card-receipts" on storage.objects;
drop policy if exists "deny all on contractor-invoices"   on storage.objects;
drop policy if exists "issue-photos deny-all"             on storage.objects;

-- Drop two always-false (ineffective) PERMISSIVE policies.
drop policy if exists "bca_documents_no_anon"          on storage.objects;
drop policy if exists "bca_documents_no_authenticated" on storage.objects;

-- Fold the two correct single-bucket restrictive denials into one consolidated
-- RESTRICTIVE deny covering every private bucket except contracts.
drop policy if exists "hunted-invoices restrictive deny" on storage.objects;
drop policy if exists "whatsapp-media restrictive deny"  on storage.objects;

create policy "private buckets deny client"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (
    bucket_id not in (
      'inbound-invoices','car-documents','company-card-receipts',
      'contractor-invoices','fte-expense-receipts','issue-photos',
      'consultation-photos','bca-documents','hunted-invoices','whatsapp-media'
    )
  )
  with check (
    bucket_id not in (
      'inbound-invoices','car-documents','company-card-receipts',
      'contractor-invoices','fte-expense-receipts','issue-photos',
      'consultation-photos','bca-documents','hunted-invoices','whatsapp-media'
    )
  );

-- 'contracts' is intentionally excluded; its scoped authenticated SELECT
-- policies remain the sole grant, and anon has no permissive grant after the
-- drops above (default-deny).
