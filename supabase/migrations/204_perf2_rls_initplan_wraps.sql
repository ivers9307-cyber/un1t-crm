-- 204_perf2_rls_initplan_wraps.sql
--
-- PERF.2.E — wrap auth.uid() in a scalar sub-select on the 9 RLS
-- policies the Supabase advisor still flags as auth_rls_initplan.
--
-- An un-wrapped auth.uid() in a policy predicate is re-evaluated once
-- PER ROW. Wrapping it as (select auth.uid()) lets Postgres hoist it
-- into an InitPlan — evaluated once per query. Same fix PERF.1
-- (mig 162) applied to 8 policies; these 9 are on tables added since.
-- Semantics are unchanged — only evaluation timing.
--
-- ALTER POLICY (not DROP/CREATE) so each policy keeps its identity.

begin;

-- audit_events --------------------------------------------------------
alter policy "audit_events_select_master_owner" on public.audit_events
  using (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid())
        and p.role = any (array['master'::text, 'owner'::text])
    )
  );

-- fte_expense_claims --------------------------------------------------
alter policy "fte_expense_claims_read" on public.fte_expense_claims
  using (
    profile_id = (select auth.uid())
    or exists (
      select 1 from profiles p
      where p.id = (select auth.uid()) and p.role = 'master'::text
    )
    or exists (
      select 1 from profile_locations pl
      where pl.profile_id = (select auth.uid())
        and pl.location_id = fte_expense_claims.location_id
        and pl.role = 'owner'::text
    )
  );

-- fte_expense_items ---------------------------------------------------
alter policy "fte_expense_items_read" on public.fte_expense_items
  using (
    exists (
      select 1 from fte_expense_claims c
      where c.id = fte_expense_items.claim_id
        and (
          c.profile_id = (select auth.uid())
          or exists (
            select 1 from profiles p
            where p.id = (select auth.uid()) and p.role = 'master'::text
          )
          or exists (
            select 1 from profile_locations pl
            where pl.profile_id = (select auth.uid())
              and pl.location_id = c.location_id
              and pl.role = 'owner'::text
          )
        )
    )
  );

-- invoices_queue ------------------------------------------------------
alter policy "inbound_invoices_read" on public.invoices_queue
  using (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid()) and p.role = 'master'::text
    )
    or exists (
      select 1 from profile_locations pl
      where pl.profile_id = (select auth.uid())
        and pl.location_id = invoices_queue.location_id
        and pl.role = 'owner'::text
    )
  );

-- policies ------------------------------------------------------------
alter policy "policies_admin_write" on public.policies
  using (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid())
        and (p.role = 'master'::text or p.role = 'owner'::text)
    )
  )
  with check (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid())
        and (p.role = 'master'::text or p.role = 'owner'::text)
    )
  );

-- policy_versions -----------------------------------------------------
alter policy "policy_versions_admin_write" on public.policy_versions
  using (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid())
        and (p.role = 'master'::text or p.role = 'owner'::text)
    )
  )
  with check (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid())
        and (p.role = 'master'::text or p.role = 'owner'::text)
    )
  );

-- policy_views --------------------------------------------------------
alter policy "policy_views_insert_own" on public.policy_views
  with check (profile_id = (select auth.uid()));

alter policy "policy_views_select_own_or_admin" on public.policy_views
  using (
    profile_id = (select auth.uid())
    or exists (
      select 1 from profiles p
      where p.id = (select auth.uid())
        and (p.role = 'master'::text or p.role = 'owner'::text)
    )
  );

alter policy "policy_views_update_own" on public.policy_views
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

commit;
