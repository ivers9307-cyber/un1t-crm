-- 626 — RLSACTIVE.1: staff authority at the RLS layer requires an ACTIVE,
-- non-tombstoned profile.
--
-- THE DEFECT
-- ──────────
-- Deactivating staff (profiles.active = false) blocks the app
-- (getCurrentUser(), widgets) and bans the login — EXCEPT when the same auth
-- user is also a gym member's (contacts.user_id) or a host's, where the ban
-- is skipped so the member app keeps working. For those people the Supabase
-- JWT keeps refreshing, and every RLS helper and every inline policy decided
-- from profiles.role / profile_locations / profile_organizations LIVE without
-- looking at active or deleted_at. So a deactivated coach who is also a
-- member could call PostgREST directly (public anon key + their own JWT) and
-- keep reading — and, wherever a policy allows it, writing — studio data as
-- staff. Prod on 21 Sep: 12 active staff logins are also member logins.
-- Tombstones (mig 622) were covered only by accident (role demoted to
-- 'staff', no profile_locations rows), not by design.
--
-- THE RULE THIS FILE MAKES STRUCTURAL
-- ───────────────────────────────────
-- A profiles row is a STAFF login (member-only users have none). Staff
-- authority requires that row to be
--     active IS NOT FALSE AND deleted_at IS NULL
-- — strictly IS NOT FALSE, so a NULL `active` still counts, matching the app
-- (profiles.active is BOOLEAN DEFAULT TRUE, nullable: mig 004:41).
-- private.auth_is_active_staff() is that predicate for the CALLER. The
-- per-row location helpers carry the same predicate text inside their own
-- single EXISTS instead of calling it (see PERFORMANCE); the tests pin the
-- exact text in every helper so the definition cannot drift.
--
-- Membership rows (profile_locations / profile_organizations /
-- email_mailbox_access) are KEPT on deactivation, which is why the location
-- and mailbox helpers are gated too, not only the ones that read
-- profiles.role.
--
-- HELPER CLASSIFICATION (private schema; every one SECURITY DEFINER)
-- ─────────────────────────────────────────────────────────────────
--   helper                               class     what 626 does
--   auth_is_active_staff()               staff     NEW — the predicate
--   auth_is_master()                     staff     + active predicate (same row it already reads)
--   auth_is_in_location(uuid)            staff     one EXISTS on profiles (master OR membership) + predicate
--   auth_is_owner_at(uuid)               staff     one EXISTS on profiles (master OR owner at) + predicate
--   auth_is_admin_at(uuid)               staff     one EXISTS on profiles (master OR owner/manager at) + predicate
--   auth_is_manager_at(uuid)             staff     one EXISTS on profiles (master OR owner/manager/head_coach at) + predicate
--   auth_is_in_organization(uuid)        staff     one EXISTS on profiles (master OR loc member OR org grant) + predicate
--   auth_role()                          staff     NULL (no role) unless the caller is active staff
--   get_user_role(uuid)                  staff     NULL unless THAT user is active staff
--   get_user_role_at(uuid, uuid)         staff     no row unless THAT user is active staff
--   mobile_can_for(uuid, uuid, text)     staff     false unless THAT user is active staff
--   auth_can_view_all_profiles()         staff     + predicate (false for inactive)
--   auth_is_admin_or_head_coach()        staff     + predicate
--   is_owner()                           staff     + predicate (body out-of-band on prod — see mig 549; guarded below)
--   auth_has_mailbox_grant(uuid)         staff     joins profiles + predicate (mailbox grants are kept on deactivation)
--   auth_has_ticket_mailbox_grant(uuid)  staff     joins profiles + predicate
--   auth_is_owner()                      staff     UNCHANGED — delegates to auth_role()
--   auth_is_owner_or_manager()           staff     UNCHANGED — delegates to auth_role()
--   auth_mobile_can(uuid, text)          staff     UNCHANGED — delegates to mobile_can_for(auth.uid(), …)
--   auth_is_manager_at_bridge(uuid)      staff     UNCHANGED — delegates to auth_is_manager_at()
--   auth_can_read_shift_block(uuid,uuid) staff     UNCHANGED — delegates to auth_is_manager_at / auth_is_in_location
--   auth_can_read_shift_assignment(…)    staff*    UNCHANGED — delegates; its `p_profile_id = auth.uid()` branch is
--                                                  the person's OWN published shift (subject, not authority — see
--                                                  OWN-ROW BRANCHES below)
--   auth_contact_id()                    MEMBER    UNCHANGED — contacts.user_id = auth.uid(); a deactivated coach who
--                                                  is a member keeps every member read/write
--   guard_unifi_config_master_only()     neutral   trigger; inherits auth_is_master() (an inactive master can no
--                                                  longer change settings->unifi from a browser; service role still can)
--   guard_at_least_one_master()          neutral   trigger; counts active masters itself (mig 080), untouched
--   refuse_tombstone_access_row(),
--   profiles_tombstone_frozen()          neutral   triggers (mig 622), untouched
--   log_mutation()                       neutral   audit trigger (actor id only), untouched
-- Host authority (host_users) and public/anon access use none of these and
-- are untouched.
--
-- Signatures, return types, LANGUAGE, STABLE, SECURITY DEFINER and each
-- function's `SET search_path` are preserved for every helper EXCEPT
-- is_owner(): its live search_path is 'public' and becomes '' (the new body
-- is fully schema-qualified), and it is declared STABLE (live is STABLE per
-- the 22 Sep read, so expected unchanged). The self-check (4a) compares each
-- helper's prosecdef / provolatile / proconfig / owner / ACL against the
-- values captured at the top of THIS transaction, before any replace, and
-- allows only is_owner()'s documented search_path change.
-- CREATE OR REPLACE keeps the function's OID, owner and ACL (grants), so no
-- GRANT is re-issued for an existing helper — re-granting would change
-- auth_can_view_all_profiles' ACL, which has never been restricted from
-- PUBLIC (P1). auth_is_active_staff() is new: REVOKE ALL FROM PUBLIC, then
-- EXECUTE to anon AND authenticated — the posture its siblings already have
-- on prod (anon executes auth_is_master, auth_is_owner_at,
-- auth_is_manager_at, auth_is_admin_at, auth_is_in_organization,
-- auth_mobile_can, auth_can_view_all_profiles). anon MUST hold it: see NEW
-- BEHAVIOUR.
--
-- INLINE POLICIES — CHANGED (47)
-- ──────────────────────────────
-- Shape of every change: the caller-scoped subquery that reads profiles /
-- profile_locations / profile_organizations gets
--     AND (SELECT private.auth_is_active_staff())
-- appended to its WHERE. Nothing else moves: command, roles (an omitted TO is
-- written as TO public, which is what it meant), PERMISSIVE, every other
-- branch — own-row and member branches stay exactly as they were. The only
-- other edit: a bare auth.uid() in a rewritten policy becomes
-- (SELECT auth.uid()) (CLAUDE.md invariant; semantics identical).
-- The gate is a helper call, not `p.active IS NOT FALSE` inline, on purpose:
-- `authenticated` holds NO SELECT on public.profiles (mig 153b), and an
-- inline column read would need a grant on `active` + `deleted_at` that the
-- role does not have (verify (P5)).
--
--   Read public.profiles inline (15, all from the migrations' net state):
--     profile_compensation      _select _insert _update           (mig 162)
--     password_overrides_audit  password_overrides_audit_master_read (161)
--     policies                  policies_ins _upd _del             (320)
--     policy_versions           policy_versions_ins _upd _del      (320)
--     policy_views              policy_views_select_own_or_admin   (179)
--     audit_events              audit_events_select_master_owner   (180)
--     fte_expense_claims        fte_expense_claims_read            (183)
--     fte_expense_items         fte_expense_items_read             (183)
--     invoices_queue            inbound_invoices_read   (184; table renamed
--                               from inbound_invoices by mig 185; USING
--                               rewritten by mig 204's ALTER POLICY — this
--                               file rebuilds it from 204's text)
--   Read profile_locations / profile_organizations for the CALLER (32 more):
--     storage.objects "Owner reads org signed PDFs" (106) · organizations_select (417)
--     contract_templates_write (167) · contracts_read (167) · contracts_insert/_update/_delete (320)
--     landing_page_settings_ins/_upd/_del (320) · org_settings_select/_ins/_upd/_del (320)
--     agent_knowledge_read (320) · glofox_invoices_select, glofox_sync_runs_select,
--     glofox_push_events_select, pipeline_classification_runs_select (162)
--     car_bca_submissions_read_at_location (163) · car_bca_submission_events_read_at_location (165)
--     channel_connections_select, ig_conv_select, ig_msg_select, glofox_memberships_select (242)
--     agent_membership_requests_read (363) · chooser_settings_ins/_upd/_del (414)
--     contract_template_versions_read (446) · zoom_sync_runs_select (491)
--     cancellation_form_links_select (585)
--
-- INLINE POLICIES — LEFT (with reasons)
-- ─────────────────────────────────────
--   staff_allowances_select/_ins/_upd/_del (600): read the TARGET's
--     profile_locations (pl.profile_id = staff_allowances.profile_id); the
--     caller's authority is private.auth_is_manager_at(), gated above.
--   storage.objects "Owners can upload/update/delete branding" (013): the
--     file text reads profiles inline, but prod redefined all three
--     out-of-band to call private.is_owner() (mig 549 header) — gated above.
--     Re-creating them from the file would revert that and drop 'master'.
--     Pre-apply (P3) confirms prod still calls is_owner().
--
-- OWN-ROW BRANCHES — LEFT, deliberately
--   `profile_id = auth.uid()` style branches (own contract, own policy view,
--   own expense claim, own allowance, own time-off, own published shift,
--   "Staff can create own time off") make the person the SUBJECT of the row,
--   not a holder of authority over anyone else. They stay open to a
--   deactivated profile; a follow-up can close them if the owner wants
--   deactivated staff to lose their own history too. The subject-row WRITES
--   an inactive profile still has after 626:
--     contracts_update            own-row branch (profile_id = auth.uid())
--     policy_views_insert_own / policy_views_update_own
--     time_off_requests INSERT ("Staff can create own time off") and the
--     own-pending branch of time_off_requests_update — both closed by mig 625
--     on another branch.
--
-- NEW BEHAVIOUR TO KNOW ABOUT
--   * anon. A policy stores its functions by OID, so evaluating it checks
--     EXECUTE on each function — not USAGE on its schema. Eight tables anon
--     can SELECT on prod (22 Sep) have a TO public policy this file gates:
--     glofox_invoices, glofox_sync_runs, glofox_push_events,
--     pipeline_classification_runs (which called no private function
--     before), and channel_connections, instagram_conversations,
--     instagram_messages, glofox_memberships (which already called
--     auth_is_master(), which anon executes). Without EXECUTE on
--     auth_is_active_staff(), anon would get "permission denied for function
--     auth_is_active_staff" on all eight where it gets an empty set today. So
--     anon is GRANTed EXECUTE: auth.uid() is NULL for anon, the helper returns
--     false, and anon keeps its empty set. profile_compensation (TO public,
--     anon-readable) reads profiles inline, which anon cannot read: it errors
--     for anon today and still does — unchanged.
--   * The 15 profiles-inline policies: if (P5) confirms `authenticated` has
--     no SELECT on profiles, those policies ERROR for every browser/mobile
--     caller today (policy subqueries run with the caller's privileges) and
--     keep doing so — fail-closed either way. They were NOT moved onto
--     SECURITY DEFINER helpers, because that would turn today's errors into
--     live grants — an access expansion outside this PR.
--
-- PERFORMANCE
--   Policies call the location helpers PER ROW with a column argument
--   (contacts_select → auth_is_in_location(location_id); bookings /
--   whatsapp_messages → auth_mobile_can → mobile_can_for; heart_rate_sessions,
--   contact_goals, strap_assignments, …). SECURITY DEFINER SQL functions are
--   never inlined, so a nested call inside them runs once per row. Before 626
--   each per-row call already did auth_is_master() (one nested call + one
--   profiles lookup) + one profile_locations lookup. The rewritten
--   auth_is_in_location / _owner_at / _admin_at / _manager_at /
--   _in_organization / mobile_can_for fold the master check AND the active
--   predicate into ONE EXISTS over profiles by primary key, with the
--   membership EXISTS nested inside it: one profiles lookup + one
--   profile_locations lookup and one fewer nested call per row than before —
--   the active check costs nothing on the hot tables. (The naive shape,
--   `AND private.auth_is_active_staff()` bolted onto the old body, would have
--   added a third lookup and a second nested call per row.)
--   In policies the gate is `(SELECT private.auth_is_active_staff())`: an
--   uncorrelated scalar subquery, planned as an InitPlan and evaluated ONCE per
--   statement even inside a correlated EXISTS (ig_msg_select on
--   instagram_messages is the hot one).
--   auth_role() / get_user_role() wrap their old CASE in one more pk lookup;
--   they are not per-row on any hot table (auth_role is reached only through
--   auth_is_owner() on company_settings).
--   The mailbox helpers join profiles by pk inside their existing EXISTS.
--
-- MASTERS (mig 080)
--   auth_is_master() is false for an inactive master — correct: the 080 guard
--   keeps at least one ACTIVE master, and nothing running as `authenticated`
--   needs an inactive one to be a master. Reactivation is PATCH
--   /api/staff/[id] on createServerClient() (service role, bypasses RLS), and
--   anon/authenticated hold no write grant on profiles at all (mig 622). The
--   080 guard counts `active = TRUE` (strict) while this file treats NULL as
--   active — prod has no NULL `active` row to disagree over (verify (P9)).
--
-- CALLERS OF THE p_user_id HELPERS (checked against the migrations + src/,
-- shared/, mobile/, champ-app; `private` is not exposed by PostgREST, so no
-- `.rpc()` can reach any of them)
--   get_user_role(uuid)       no caller in the net migration state (its mig
--                             036/048 policies were replaced long ago); no app
--                             caller. Verify (P7) on prod.
--   get_user_role_at(uuid,uuid)  no caller anywhere in the migrations; no app
--                             caller. Verify (P7).
--   mobile_can_for(p_uid,…)   one caller: auth_mobile_can(), always with
--                             (SELECT auth.uid()) — so its check lands on the
--                             CALLER. Reaches 21 policies on activities,
--                             bookings, deals, notes, whatsapp_conversations,
--                             whatsapp_messages, whatsapp_templates (3 each):
--                             an inactive staff login now reads/writes none.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only)
-- SAVE THE OUTPUT OF P1 AND P3 BEFORE APPLYING. There is no down-migration:
-- a rollback is a NEW forward migration built from that saved output (P1's
-- functiondef for every helper, P3's qual / with_check / roles / cmd for every
-- policy).
-- ─────────────────────────────────────────────────────────────────────────
-- (P1) The helpers as they are — the rollback recipe:
--
--   SELECT p.oid::regprocedure AS fn, p.prosecdef, p.provolatile, p.proconfig,
--          pg_get_userbyid(p.proowner) AS owner, p.proacl,
--          md5(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', '', 'g')) AS body_norm_md5,
--          pg_get_functiondef(p.oid) AS functiondef
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'private'
--      AND p.proname IN ('auth_can_view_all_profiles','auth_is_admin_at','auth_is_admin_or_head_coach',
--        'auth_is_in_location','auth_is_in_organization','auth_is_manager_at','auth_is_master',
--        'auth_is_owner_at','auth_role','get_user_role','get_user_role_at','mobile_can_for','is_owner',
--        'auth_has_mailbox_grant','auth_has_ticket_mailbox_grant','auth_is_owner','auth_is_owner_or_manager',
--        'auth_mobile_can','auth_is_manager_at_bridge','auth_can_read_shift_block',
--        'auth_can_read_shift_assignment','auth_contact_id','auth_is_active_staff')
--    ORDER BY 1;
--
--   Expected: no auth_is_active_staff row; every row prosecdef = t,
--   provolatile = s, owner = postgres. body_norm_md5 = md5 of the body with
--   `--` comments and ALL whitespace removed; it must equal the same
--   normalisation of the body in the migration that last defined it. Raw
--   (un-normalised) text differs on prod for auth_can_view_all_profiles,
--   auth_is_admin_or_head_coach, auth_mobile_can and mobile_can_for — comment
--   and whitespace drift, verified cosmetic on 22 Sep. ANY normalised
--   mismatch is a STOP: 626 would replace a body that is not the one it was
--   written against.
--     helper                          normalised md5 before 626          (mig)
--     auth_can_view_all_profiles      fe46c690ea4ac1297ebc0b4cec988c43  (105)
--     auth_is_admin_at                3d6eb0863e8213743a4ee750f70a787e  (051)
--     auth_is_admin_or_head_coach     5017b8cb044594706f9cd0bd33053ee3  (109)
--     auth_is_in_location             35958842a2bc5971b35b125cd4e8b87d  (051)
--     auth_is_in_organization         19f6d69b10f8b8d08993f1804a987af5  (417)
--     auth_is_manager_at              a69cf970db6b339194595e4e8b9578bb  (051)
--     auth_is_master                  50b2bd5a39b533ec6e488c3a5bc5f0c7  (051)
--     auth_is_owner_at                78288bdbb7d640f2937f01ab1a9ea556  (051)
--     auth_role                       6246d882befe9a5e548894630dd676d6  (051)
--     get_user_role                   b8c78ee435ad2994c73d655731e8b3ff  (051)
--     get_user_role_at                f42f8bd58670a155deedfddb27ac5318  (051)
--     mobile_can_for                  2a76f31c5d4913960251a0529fd80186  (218)
--     auth_has_mailbox_grant          63a1c56e2e41ec8da147527f96b9500a  (502)
--     auth_has_ticket_mailbox_grant   305735f6284a59b5c46c297c3412c094  (502)
--     is_owner                        (no migration defines it — P2)
--     unchanged by 626:
--     auth_is_owner                   92ca5ec0584e5c84e59ad0cb0af8c8bb  (051)
--     auth_is_owner_or_manager        46d23bb48e43bd37d0ec6f87f4793f30  (051)
--     auth_mobile_can                 590307b91d424da4441cf8d91fde1746  (550)
--     auth_is_manager_at_bridge       0fc4798920a1ba488f2689bb66702710  (618)
--     auth_can_read_shift_block       7d45356ad6b5e4e13e02dee4b63d534b  (614)
--     auth_can_read_shift_assignment  3780e385ebdce9936535c4f966c0f115  (614)
--     auth_contact_id                 cb6b8b766e378301412b3dd16417c79b  (110)
--
-- (P2) is_owner() has no CREATE in any migration (out-of-band; moved to
--      private by mig 549). Read it and confirm it is exactly
--      "profiles.role IN ('owner','master') for auth.uid()":
--   SELECT pg_get_functiondef('private.is_owner()'::regprocedure);
--      626 replaces it with that + the active predicate, LANGUAGE sql STABLE
--      SECURITY DEFINER SET search_path = '' (live: 'public'; the new body is
--      fully qualified). The DO block before the replace refuses (and aborts
--      everything) if the live body reads profile_locations or lacks
--      'owner'/'master'/profiles — but it cannot spot every extra condition,
--      so READ it.
--
-- (P3) Every policy 626 drops + re-creates, as it stands. Expected 47 rows —
--      inbound_invoices_read is on public.invoices_queue (mig 185 renamed the
--      table; mig 204 rewrote its USING):
--   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--     FROM pg_policies
--    WHERE (schemaname, tablename, policyname) IN (
--      ('public','profile_compensation','profile_compensation_select'),('public','profile_compensation','profile_compensation_insert'),
--      ('public','profile_compensation','profile_compensation_update'),('public','password_overrides_audit','password_overrides_audit_master_read'),
--      ('public','policies','policies_ins'),('public','policies','policies_upd'),('public','policies','policies_del'),
--      ('public','policy_versions','policy_versions_ins'),('public','policy_versions','policy_versions_upd'),('public','policy_versions','policy_versions_del'),
--      ('public','policy_views','policy_views_select_own_or_admin'),('public','audit_events','audit_events_select_master_owner'),
--      ('public','fte_expense_claims','fte_expense_claims_read'),('public','fte_expense_items','fte_expense_items_read'),
--      ('public','invoices_queue','inbound_invoices_read'),('storage','objects','Owner reads org signed PDFs'),
--      ('public','organizations','organizations_select'),('public','contract_templates','contract_templates_write'),
--      ('public','contracts','contracts_read'),('public','contracts','contracts_insert'),('public','contracts','contracts_update'),
--      ('public','contracts','contracts_delete'),('public','landing_page_settings','landing_page_settings_ins'),
--      ('public','landing_page_settings','landing_page_settings_upd'),('public','landing_page_settings','landing_page_settings_del'),
--      ('public','glofox_invoices','glofox_invoices_select'),('public','glofox_sync_runs','glofox_sync_runs_select'),
--      ('public','glofox_push_events','glofox_push_events_select'),('public','pipeline_classification_runs','pipeline_classification_runs_select'),
--      ('public','car_bca_submissions','car_bca_submissions_read_at_location'),
--      ('public','car_bca_submission_events','car_bca_submission_events_read_at_location'),
--      ('public','chooser_settings','chooser_settings_ins'),('public','chooser_settings','chooser_settings_upd'),
--      ('public','chooser_settings','chooser_settings_del'),('public','agent_knowledge','agent_knowledge_read'),
--      ('public','channel_connections','channel_connections_select'),('public','instagram_conversations','ig_conv_select'),
--      ('public','instagram_messages','ig_msg_select'),('public','glofox_memberships','glofox_memberships_select'),
--      ('public','agent_membership_requests','agent_membership_requests_read'),('public','org_settings','org_settings_select'),
--      ('public','org_settings','org_settings_ins'),('public','org_settings','org_settings_upd'),('public','org_settings','org_settings_del'),
--      ('public','contract_template_versions','contract_template_versions_read'),('public','zoom_sync_runs','zoom_sync_runs_select'),
--      ('public','cancellation_form_links','cancellation_form_links_select'))
--    ORDER BY 1, 2, 3;
--   And the three branding policies must call is_owner():
--   SELECT policyname, qual, with_check FROM pg_policies
--    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'Owners can % branding';
--
-- (P4) Every policy that reads a profile table inline, prod-wide. Expected 51
--      = the 47 above + staff_allowances_select/_ins/_upd/_del. (The earlier
--      "16 on prod vs 15 in the files" was the inbound_invoices →
--      invoices_queue rename, not a policy missing from the files.) ANY other
--      row makes 626's self-check RAISE and abort the whole apply — read it,
--      then add it to 626 or allowlist it with a reason:
--   SELECT schemaname, tablename, policyname, cmd, roles
--     FROM pg_policies
--    WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* '\m(profiles|profile_locations|profile_organizations)\M'
--    ORDER BY 1, 2, 3;
--
-- (P5) What `authenticated` may read on profiles (expected: all false / 0
--      rows — mig 153b):
--   SELECT has_table_privilege('authenticated', 'public.profiles', 'SELECT') AS tbl,
--          has_column_privilege('authenticated', 'public.profiles', 'role', 'SELECT') AS role_col;
--   SELECT grantee, column_name FROM information_schema.column_privileges
--    WHERE table_schema = 'public' AND table_name = 'profiles' AND privilege_type = 'SELECT'
--      AND grantee IN ('authenticated', 'anon');
--
-- (P6) anon: which gated tables it can SELECT, and which helpers it executes.
--      Expected (22 Sep): anon_select true for the first ten; the new helper
--      does not exist yet (NULL).
--   SELECT t, has_table_privilege('anon', t, 'SELECT') AS anon_select
--     FROM unnest(ARRAY['public.glofox_invoices','public.glofox_sync_runs','public.glofox_push_events',
--       'public.pipeline_classification_runs','public.channel_connections','public.instagram_conversations',
--       'public.instagram_messages','public.glofox_memberships','public.profile_compensation',
--       'public.profile_locations','public.organizations','public.contracts','public.contract_templates',
--       'public.landing_page_settings','public.org_settings','public.chooser_settings','public.agent_knowledge',
--       'public.agent_membership_requests','public.car_bca_submissions','public.car_bca_submission_events',
--       'public.contract_template_versions','public.zoom_sync_runs','public.cancellation_form_links',
--       'public.invoices_queue','public.audit_events','public.policies','public.policy_versions',
--       'public.policy_views','public.password_overrides_audit','public.fte_expense_claims',
--       'public.fte_expense_items','storage.objects']) AS t;
--   SELECT f, has_function_privilege('anon', f, 'EXECUTE') AS anon_exec
--     FROM unnest(ARRAY['private.auth_is_master()','private.auth_is_manager_at(uuid)',
--       'private.auth_is_in_organization(uuid)','private.auth_is_in_location(uuid)']) AS f;
--
-- (P7) Anything else on prod that calls the p_user_id helpers (expected: only
--      private.auth_mobile_can calling mobile_can_for; 0 policies):
--   SELECT p.oid::regprocedure FROM pg_proc p
--    WHERE p.prosrc ~ '(get_user_role|mobile_can_for)' AND p.proname NOT IN ('get_user_role','get_user_role_at','mobile_can_for');
--   SELECT schemaname, tablename, policyname FROM pg_policies
--    WHERE coalesce(qual, '') || coalesce(with_check, '') ~ '(get_user_role|mobile_can_for)';
--
-- (P8) Other SECURITY DEFINER functions that read a profile table for
--      auth.uid() — 626's self-check RAISES on any that is not gated
--      (expected: only the helpers listed in P1):
--   SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname IN ('public', 'private') AND p.prosecdef
--      AND p.prosrc ~ 'auth\.uid\(\)' AND p.prosrc ~* '\m(profiles|profile_locations|profile_organizations)\M';
--
-- (P9) The people this is about, and the master count:
--   SELECT p.id, p.role, p.active, p.deleted_at IS NOT NULL AS tombstone,
--          c.id AS contact_id, c.location_id AS member_location
--     FROM public.profiles p LEFT JOIN public.contacts c ON c.user_id = p.id
--    WHERE p.active IS NOT TRUE OR p.deleted_at IS NOT NULL;
--   SELECT count(*) FILTER (WHERE role = 'master' AND active IS NOT FALSE AND deleted_at IS NULL) AS active_masters,  -- 1
--          count(*) FILTER (WHERE active IS NULL) AS null_active                                                       -- 0
--     FROM public.profiles;
--
-- (P10) BASELINE for the role-play below: run (R) for the inactive profile
--       AND for one active staff id, BEFORE applying. Keep the numbers.
--
-- ─────────────────────────────────────────────────────────────────────────
-- LOCKS. DROP/CREATE POLICY takes ACCESS EXCLUSIVE on ~30 tables (including
-- storage.objects and instagram_messages). The file sets lock_timeout = 3s
-- right after BEGIN, so a long-running reader makes the apply ABORT rather
-- than queue the app behind it. An abort ("canceling statement due to lock
-- timeout") means NOTHING was applied: re-run later.
-- ─────────────────────────────────────────────────────────────────────────
-- ROLE-PLAY (R) — run before AND after; ends in ROLLBACK. Replace <ID>.
-- MCP execute_sql: `begin;` without `commit;` rolls back, and only the last
-- statement's rows come back — hence ONE final SELECT.
-- ─────────────────────────────────────────────────────────────────────────
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"<ID>","role":"authenticated"}', true);
--   select
--     private.auth_is_active_staff()                                                        as active_staff,  -- (after only)
--     private.auth_is_master()                                                              as is_master,
--     (select count(*) from public.contacts where user_id is distinct from '<ID>')          as staff_contacts,
--     (select count(*) from public.shift_assignments where profile_id <> '<ID>')            as colleague_shifts,
--     (select count(*) from public.time_off_requests where profile_id <> '<ID>')            as colleague_leave,
--     (select count(*) from public.bookings)                                                as bookings,
--     (select count(*) from public.whatsapp_messages)                                       as wa_messages,
--     (select count(*) from public.contacts where user_id = '<ID>')                         as own_member_contact,
--     (select count(*) from public.heart_rate_sessions where contact_id = private.auth_contact_id()) as own_hr_sessions,
--     (select count(*) from public.contact_goals where contact_id = private.auth_contact_id())       as own_goals;
--   rollback;
--
--   INACTIVE profile, after: active_staff = false, is_master = false,
--     staff_contacts = colleague_shifts = colleague_leave = bookings =
--     wa_messages = 0; own_member_contact / own_hr_sessions / own_goals =
--     the SAME as the baseline (member access intact; own_member_contact = 1
--     if they are a member).
--   ACTIVE staff id, after: every count identical to its baseline;
--     active_staff = true.
--   (Before applying, auth_is_active_staff() does not exist — drop that column
--   from the baseline run.)
--
--   ANON, before and after — must be 0 rows and NO error:
--   begin; set local role anon;
--   select (select count(*) from public.instagram_messages) as ig,
--          (select count(*) from public.glofox_invoices)    as glofox;
--   rollback;
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (Q1) Re-run (P1). prosecdef, provolatile, proconfig, owner and proacl
--      IDENTICAL to before for every pre-existing helper, except is_owner()'s
--      proconfig ({search_path=public} → {search_path=""}). body_norm_md5 is
--      unchanged for the 7 "unchanged" helpers and is now:
--     auth_can_view_all_profiles      abff65571f5ff7d492f91ee299794c06
--     auth_is_admin_at                c21de4446dcdc20662fb18b550887e38
--     auth_is_admin_or_head_coach     fb64e76e72f89f2c9d5e67b97a7e5031
--     auth_is_in_location             4c874dfabf18f472ae65c87d6184bd20
--     auth_is_in_organization         0777061078b133dca9edf121d29dec35
--     auth_is_manager_at              8185763547736edd5eb1826dd8aa813b
--     auth_is_master                  3ed9c526408190b1ded76a8f090ffc74
--     auth_is_owner_at                e5b74def6d4ee68454ce325e0dd1bb71
--     auth_role                       63045c8fae37ab8dafec0f92dab296a4
--     get_user_role                   5d6b8c9bf57b916f1cbfd9ccc4194558
--     get_user_role_at                31c0a9aaab3d9424a3214971d8d746f8
--     mobile_can_for                  ceb961b928947022d840db8fe244c470
--     auth_has_mailbox_grant          12a6983f7da4ff8dcd139cb1d495c6ad
--     auth_has_ticket_mailbox_grant   2ec0a27c247254a1f34ac808f4d8efe1
--     is_owner                        ccb736a05760da324420d819cf2c704d
--     auth_is_active_staff            eecef176921045314f03f06a6a603484
--      auth_is_active_staff: owner postgres; EXECUTE for anon and
--      authenticated (and postgres), not PUBLIC:
--   SELECT has_function_privilege('anon', 'private.auth_is_active_staff()', 'EXECUTE');           -- true
--   SELECT has_function_privilege('authenticated', 'private.auth_is_active_staff()', 'EXECUTE');  -- true
-- (Q2) Re-run (P4): every row except the four staff_allowances policies has
--      auth_is_active_staff in qual (and in with_check where with_check is
--      set). The file's own DO block already refuses to commit otherwise.
-- (Q3) Re-run (P3): same 47 rows, same permissive/roles/cmd.
-- (Q4) Role-play (R) for the inactive profile, the active staff id, and anon.
-- (Q5) get_advisors — security AND performance. Expected: nothing new
--      (auth_rls_initplan: every auth.uid() and the new helper are wrapped).

BEGIN;

-- Wait at most 3s for any table lock; a long-running reader then aborts the
-- apply (nothing applied — re-run later) instead of queueing the app behind
-- an ACCESS EXCLUSIVE request on ~30 tables.
SET LOCAL lock_timeout = '3s';

-- The helpers' catalog attributes BEFORE any replace — self-check 4a compares
-- against these, so it detects drift instead of re-reading what this file
-- just wrote.
CREATE TEMP TABLE mig626_helpers_before ON COMMIT DROP AS
SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef, p.provolatile, p.proconfig, p.proowner, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'private'
   AND p.proname IN ('auth_is_master','auth_is_in_location','auth_is_owner_at','auth_is_admin_at',
     'auth_is_manager_at','auth_is_in_organization','auth_role','get_user_role','get_user_role_at',
     'mobile_can_for','auth_can_view_all_profiles','auth_is_admin_or_head_coach','is_owner',
     'auth_has_mailbox_grant','auth_has_ticket_mailbox_grant','auth_is_owner','auth_is_owner_or_manager',
     'auth_mobile_can','auth_is_manager_at_bridge','auth_can_read_shift_block',
     'auth_can_read_shift_assignment','auth_contact_id');

-- ═════════════════════════════════════════════════════════════════════════
-- 1. The predicate
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION private.auth_is_active_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND active IS NOT FALSE
      AND deleted_at IS NULL
  )
$$;

-- anon too: eight anon-readable tables carry a TO public policy that now calls
-- this; for anon auth.uid() is NULL, so it returns false and anon keeps its
-- empty set instead of a permission error (header, NEW BEHAVIOUR).
REVOKE ALL ON FUNCTION private.auth_is_active_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.auth_is_active_staff() TO anon, authenticated;

COMMENT ON FUNCTION private.auth_is_active_staff() IS
  'RLSACTIVE.1 (mig 626): TRUE iff the CALLER holds a staff profile that is active (active IS NOT FALSE — NULL counts as active, matching the app) and not a tombstone (deleted_at IS NULL). Staff authority at the RLS layer requires it: every staff helper returns false/NULL without it, and inline policies that read profiles/profile_locations/profile_organizations append (SELECT private.auth_is_active_staff()). Member authority (auth_contact_id) never uses it.';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Staff helpers — latest body from the migrations + the predicate
-- ═════════════════════════════════════════════════════════════════════════

-- auth_is_master (051) — same row it already reads.
CREATE OR REPLACE FUNCTION private.auth_is_master()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'master'
      AND active IS NOT FALSE
      AND deleted_at IS NULL
  )
$$;

-- auth_is_in_location (051). PER-ROW on contacts & co: the master branch
-- (auth_is_master()'s own predicate, p.role = 'master') and the active
-- predicate share ONE profiles lookup; the membership EXISTS is verbatim.
CREATE OR REPLACE FUNCTION private.auth_is_in_location(loc_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT loc_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations
            WHERE profile_id = (SELECT auth.uid())
              AND location_id = loc_id
          )
        )
    )
$$;

-- auth_is_owner_at (051) — same fold.
CREATE OR REPLACE FUNCTION private.auth_is_owner_at(
  p_location_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.active IS NOT FALSE
      AND p.deleted_at IS NULL
      AND (
        p.role = 'master'
        OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid())
            AND pl.location_id = p_location_id
            AND pl.role = 'owner'
        )
      )
  )
$$;

-- auth_is_admin_at (051) — same fold.
CREATE OR REPLACE FUNCTION private.auth_is_admin_at(
  p_location_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.active IS NOT FALSE
      AND p.deleted_at IS NULL
      AND (
        p.role = 'master'
        OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid())
            AND pl.location_id = p_location_id
            AND pl.role IN ('owner','manager')
        )
      )
  )
$$;

-- auth_is_manager_at (051) — same fold.
CREATE OR REPLACE FUNCTION private.auth_is_manager_at(
  p_location_id UUID
) RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.active IS NOT FALSE
      AND p.deleted_at IS NULL
      AND (
        p.role = 'master'
        OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid())
            AND pl.location_id = p_location_id
            AND pl.role IN ('owner','manager','head_coach')
        )
      )
  )
$$;

-- auth_is_in_organization (417) — same fold; both membership branches
-- (location member, profile_organizations grant) verbatim.
CREATE OR REPLACE FUNCTION private.auth_is_in_organization(org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT org_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1
              FROM public.locations l
              JOIN public.profile_locations pl ON pl.location_id = l.id
             WHERE l.organization_id = org_id
               AND pl.profile_id = (SELECT auth.uid())
          )
          OR EXISTS (
            SELECT 1
              FROM public.profile_organizations po
             WHERE po.organization_id = org_id
               AND po.profile_id = (SELECT auth.uid())
          )
        )
    )
$$;

-- auth_role (051) — NULL (no role) unless the caller is active staff; the
-- CASE inside is verbatim.
CREATE OR REPLACE FUNCTION private.auth_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid())
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    ) THEN
      CASE
        WHEN (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid())) = 'master'
          THEN 'master'
        ELSE COALESCE(
          (
            SELECT role FROM public.profile_locations pl
            WHERE pl.profile_id = (SELECT auth.uid())
            ORDER BY CASE pl.role
              WHEN 'owner'      THEN 1
              WHEN 'manager'    THEN 2
              WHEN 'head_coach' THEN 3
              WHEN 'staff'      THEN 4
            END
            LIMIT 1
          ),
          (SELECT role FROM public.profiles WHERE id = (SELECT auth.uid()))
        )
      END
  END
$$;

-- get_user_role (051) — the check is on THAT user (user_id), not the caller.
-- Param name kept as `user_id` (CREATE OR REPLACE cannot rename it).
CREATE OR REPLACE FUNCTION private.get_user_role(user_id UUID)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = user_id
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    ) THEN
      CASE
        WHEN (SELECT role FROM public.profiles WHERE id = user_id) = 'master'
          THEN 'master'
        ELSE COALESCE(
          (
            SELECT role FROM public.profile_locations pl
            WHERE pl.profile_id = user_id
            ORDER BY CASE pl.role
              WHEN 'owner'      THEN 1
              WHEN 'manager'    THEN 2
              WHEN 'head_coach' THEN 3
              WHEN 'staff'      THEN 4
            END
            LIMIT 1
          ),
          (SELECT role FROM public.profiles WHERE id = user_id)
        )
      END
  END
$$;

-- get_user_role_at (051) — THAT user (p_user_id).
CREATE OR REPLACE FUNCTION private.get_user_role_at(
  p_user_id UUID,
  p_location_id UUID
) RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role
  FROM public.profile_locations
  WHERE profile_id = p_user_id
    AND location_id = p_location_id
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_user_id
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
    )
$$;

-- mobile_can_for (218) — THAT user (p_uid; auth_mobile_can passes the
-- caller). Per-row on bookings / whatsapp_* / deals / notes / activities:
-- its master lookup and the predicate share one profiles lookup, the
-- membership CASE is verbatim.
CREATE OR REPLACE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT loc_id IS NOT NULL
    AND coalesce((SELECT (features -> perm_key) <> 'false'::jsonb FROM public.locations WHERE id = loc_id), true)
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_uid
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations pl
            WHERE pl.profile_id = p_uid AND pl.location_id = loc_id
              AND CASE
                WHEN pl.permissions -> 'mobile' ? perm_key
                  THEN (pl.permissions -> 'mobile' ->> perm_key) = 'true'
                ELSE coalesce((SELECT d.allowed FROM private.mobile_permission_defaults d
                               WHERE d.role = pl.role AND d.key = perm_key), false)
              END
          )
        )
    )
$$;

-- auth_can_view_all_profiles (105).
create or replace function private.auth_can_view_all_profiles()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  -- master role wins regardless of location
  select coalesce(
    (
      select role in ('owner','manager','head_coach','master')
      from public.profiles
      where id = (select auth.uid())
        and active is not false
        and deleted_at is null
    ),
    false
  )
$$;

-- auth_is_admin_or_head_coach (109) — its search_path (public, pg_temp) and
-- unqualified auth.uid() are kept as they are.
CREATE OR REPLACE FUNCTION private.auth_is_admin_or_head_coach()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = ANY (ARRAY['owner', 'manager', 'head_coach'])
      AND active IS NOT FALSE
      AND deleted_at IS NULL
  );
$$;

-- is_owner() — out-of-band on prod (no CREATE in any migration; mig 549 moved
-- it to private and documents it as profiles.role IN ('owner','master'),
-- SECURITY DEFINER, EXECUTE to authenticated, called by the three
-- storage.objects branding policies). Refuse to replace a body that is not
-- that shape — the whole file rolls back.
DO $$
DECLARE
  r record;
BEGIN
  SELECT p.prorettype::regtype::text AS rettype, p.prosecdef, p.prosrc
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname = 'is_owner' AND p.pronargs = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 626: private.is_owner() does not exist — read the live catalog (pre-apply P2) before applying';
  END IF;
  IF r.rettype <> 'boolean' OR NOT r.prosecdef
     OR r.prosrc !~* '\mprofiles\M'
     OR r.prosrc !~ '''owner'''
     OR r.prosrc !~ '''master'''
     OR r.prosrc ~* '\m(profile_locations|profile_organizations)\M' THEN
    RAISE EXCEPTION 'mig 626: private.is_owner() is not the shape mig 549 documents (boolean, SECURITY DEFINER, profiles.role IN (owner, master)). Live body: %', r.prosrc;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role IN ('owner', 'master')
      AND active IS NOT FALSE
      AND deleted_at IS NULL
  )
$$;

-- auth_has_mailbox_grant (502) — mailbox grants survive deactivation.
CREATE OR REPLACE FUNCTION private.auth_has_mailbox_grant(p_mailbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_mailbox_access a
    JOIN public.profiles p ON p.id = a.profile_id
    WHERE a.mailbox_id = p_mailbox_id
      AND a.profile_id = (SELECT auth.uid())
      AND p.active IS NOT FALSE
      AND p.deleted_at IS NULL
  )
$$;

-- auth_has_ticket_mailbox_grant (502).
CREATE OR REPLACE FUNCTION private.auth_has_ticket_mailbox_grant(p_ticket_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.email_tickets t
    JOIN public.email_mailbox_access a ON a.mailbox_id = t.mailbox_id
    JOIN public.profiles p ON p.id = a.profile_id
    WHERE t.id = p_ticket_id
      AND a.profile_id = (SELECT auth.uid())
      AND p.active IS NOT FALSE
      AND p.deleted_at IS NULL
  )
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Inline policies — caller-scoped subquery + (SELECT private.auth_is_active_staff())
-- ═════════════════════════════════════════════════════════════════════════

-- profile_compensation (162; no TO = public) ------------------------------
DROP POLICY IF EXISTS "profile_compensation_select" ON public.profile_compensation;
CREATE POLICY "profile_compensation_select" ON public.profile_compensation
  FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
        AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.profile_locations caller_pl
      JOIN public.profile_locations target_pl ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = (SELECT auth.uid())
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "profile_compensation_insert" ON public.profile_compensation;
CREATE POLICY "profile_compensation_insert" ON public.profile_compensation
  FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
        AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.profile_locations caller_pl
      JOIN public.profile_locations target_pl ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = (SELECT auth.uid())
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "profile_compensation_update" ON public.profile_compensation;
CREATE POLICY "profile_compensation_update" ON public.profile_compensation
  FOR UPDATE TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
        AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.profile_locations caller_pl
      JOIN public.profile_locations target_pl ON target_pl.location_id = caller_pl.location_id
      WHERE caller_pl.profile_id = (SELECT auth.uid())
        AND caller_pl.role = 'owner'
        AND target_pl.profile_id = profile_compensation.profile_id
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- password_overrides_audit (161) -----------------------------------------
DROP POLICY IF EXISTS password_overrides_audit_master_read ON public.password_overrides_audit;
CREATE POLICY password_overrides_audit_master_read ON public.password_overrides_audit
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('master','owner')
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- policies / policy_versions (320) ---------------------------------------
DROP POLICY IF EXISTS "policies_ins" ON public.policies;
CREATE POLICY "policies_ins" ON public.policies FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
DROP POLICY IF EXISTS "policies_upd" ON public.policies;
CREATE POLICY "policies_upd" ON public.policies FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())))
  WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
DROP POLICY IF EXISTS "policies_del" ON public.policies;
CREATE POLICY "policies_del" ON public.policies FOR DELETE TO authenticated
  USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));

DROP POLICY IF EXISTS "policy_versions_ins" ON public.policy_versions;
CREATE POLICY "policy_versions_ins" ON public.policy_versions FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
DROP POLICY IF EXISTS "policy_versions_upd" ON public.policy_versions;
CREATE POLICY "policy_versions_upd" ON public.policy_versions FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())))
  WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
DROP POLICY IF EXISTS "policy_versions_del" ON public.policy_versions;
CREATE POLICY "policy_versions_del" ON public.policy_versions FOR DELETE TO authenticated
  USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));

-- policy_views (179) — own-row branch unchanged ---------------------------
DROP POLICY IF EXISTS policy_views_select_own_or_admin ON public.policy_views;
CREATE POLICY policy_views_select_own_or_admin ON public.policy_views
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND (p.role = 'master' OR p.role = 'owner')
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- audit_events (180) ------------------------------------------------------
DROP POLICY IF EXISTS audit_events_select_master_owner ON public.audit_events;
CREATE POLICY audit_events_select_master_owner ON public.audit_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('master', 'owner')
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- fte_expense_claims / fte_expense_items (183) — own-row branch unchanged --
DROP POLICY IF EXISTS fte_expense_claims_read ON public.fte_expense_claims;
CREATE POLICY fte_expense_claims_read ON public.fte_expense_claims
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
        AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = fte_expense_claims.location_id
        AND pl.role = 'owner'
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS fte_expense_items_read ON public.fte_expense_items;
CREATE POLICY fte_expense_items_read ON public.fte_expense_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.fte_expense_claims c
      WHERE c.id = fte_expense_items.claim_id
        AND (
          c.profile_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = (SELECT auth.uid()) AND p.role = 'master'
              AND (SELECT private.auth_is_active_staff())
          )
          OR EXISTS (
            SELECT 1 FROM public.profile_locations pl
            WHERE pl.profile_id = (SELECT auth.uid())
              AND pl.location_id = c.location_id
              AND pl.role = 'owner'
              AND (SELECT private.auth_is_active_staff())
          )
        )
    )
  );

-- invoices_queue (184 CREATE on inbound_invoices; 185 renamed the table;
-- 204 rewrote USING with ALTER POLICY — this is 204's text + the gate) -----
DROP POLICY IF EXISTS inbound_invoices_read ON public.invoices_queue;
CREATE POLICY inbound_invoices_read ON public.invoices_queue
  FOR SELECT TO authenticated
  USING (
    exists (
      select 1 from profiles p
      where p.id = (select auth.uid()) and p.role = 'master'::text
        and (SELECT private.auth_is_active_staff())
    )
    or exists (
      select 1 from profile_locations pl
      where pl.profile_id = (select auth.uid())
        and pl.location_id = invoices_queue.location_id
        and pl.role = 'owner'::text
        and (SELECT private.auth_is_active_staff())
    )
  );

-- storage.objects — contracts bucket, owner branch (106) -----------------
DROP POLICY IF EXISTS "Owner reads org signed PDFs" ON storage.objects;
CREATE POLICY "Owner reads org signed PDFs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'contracts'
    AND EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE (storage.foldername(name))[1] = c.id::text
        AND c.organization_id IN (
          SELECT l.organization_id
          FROM public.profile_locations pl
          JOIN public.locations l ON l.id = pl.location_id
          WHERE pl.profile_id = (SELECT auth.uid())
            AND pl.role = 'owner'
            AND (SELECT private.auth_is_active_staff())
        )
    )
  );

-- organizations (417) -----------------------------------------------------
DROP POLICY IF EXISTS organizations_select ON public.organizations;
CREATE POLICY organizations_select ON public.organizations
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = organizations.id
         AND pl.profile_id = (SELECT auth.uid())
         AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1
        FROM public.profile_organizations po
       WHERE po.organization_id = organizations.id
         AND po.profile_id = (SELECT auth.uid())
         AND (SELECT private.auth_is_active_staff())
    )
  );

-- contract_templates (167) — FOR ALL kept as it was -----------------------
DROP POLICY IF EXISTS "contract_templates_write" ON public.contract_templates;
CREATE POLICY "contract_templates_write" ON public.contract_templates
  FOR ALL TO authenticated
  USING (
    private.auth_is_master()
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
        AND (SELECT private.auth_is_active_staff())
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- contracts (167 read, 320 writes) — own-row branches unchanged -----------
DROP POLICY IF EXISTS "contracts_read" ON public.contracts;
CREATE POLICY "contracts_read" ON public.contracts
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR profile_id = (SELECT auth.uid())
    OR organization_id IN (
      SELECT l.organization_id
      FROM public.profile_locations pl
      JOIN public.locations l ON l.id = pl.location_id
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.role = 'owner'
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "contracts_insert" ON public.contracts;
CREATE POLICY "contracts_insert" ON public.contracts FOR INSERT TO authenticated
  WITH CHECK ( private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );
DROP POLICY IF EXISTS "contracts_update" ON public.contracts;
CREATE POLICY "contracts_update" ON public.contracts FOR UPDATE TO authenticated
  USING ( private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) OR (profile_id = (select auth.uid())) )
  WITH CHECK ( private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) OR (profile_id = (select auth.uid())) );
DROP POLICY IF EXISTS "contracts_delete" ON public.contracts;
CREATE POLICY "contracts_delete" ON public.contracts FOR DELETE TO authenticated
  USING ( private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );

-- landing_page_settings (320) --------------------------------------------
DROP POLICY IF EXISTS "landing_page_settings_ins" ON public.landing_page_settings;
CREATE POLICY "landing_page_settings_ins" ON public.landing_page_settings FOR INSERT TO authenticated
  WITH CHECK ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );
DROP POLICY IF EXISTS "landing_page_settings_upd" ON public.landing_page_settings;
CREATE POLICY "landing_page_settings_upd" ON public.landing_page_settings FOR UPDATE TO authenticated
  USING ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) )
  WITH CHECK ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );
DROP POLICY IF EXISTS "landing_page_settings_del" ON public.landing_page_settings;
CREATE POLICY "landing_page_settings_del" ON public.landing_page_settings FOR DELETE TO authenticated
  USING ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );

-- glofox_* / pipeline_classification_runs (162; no TO = public) -----------
DROP POLICY IF EXISTS "glofox_invoices_select" ON public.glofox_invoices;
CREATE POLICY "glofox_invoices_select" ON public.glofox_invoices
  FOR SELECT TO public
  USING (
    location_id IN (
      SELECT pl.location_id FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "glofox_sync_runs_select" ON public.glofox_sync_runs;
CREATE POLICY "glofox_sync_runs_select" ON public.glofox_sync_runs
  FOR SELECT TO public
  USING (
    location_id IN (
      SELECT pl.location_id FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "glofox_push_events_select" ON public.glofox_push_events;
CREATE POLICY "glofox_push_events_select" ON public.glofox_push_events
  FOR SELECT TO public
  USING (
    location_id IN (
      SELECT pl.location_id FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "pipeline_classification_runs_select" ON public.pipeline_classification_runs;
CREATE POLICY "pipeline_classification_runs_select" ON public.pipeline_classification_runs
  FOR SELECT TO public
  USING (
    location_id IN (
      SELECT pl.location_id FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- car_bca_submissions (163) / car_bca_submission_events (165) -------------
DROP POLICY IF EXISTS "car_bca_submissions_read_at_location" ON public.car_bca_submissions;
CREATE POLICY "car_bca_submissions_read_at_location" ON public.car_bca_submissions
  FOR SELECT TO authenticated
  USING (
    location_id IN (
      SELECT pl.location_id FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS "car_bca_submission_events_read_at_location" ON public.car_bca_submission_events;
CREATE POLICY "car_bca_submission_events_read_at_location" ON public.car_bca_submission_events
  FOR SELECT TO authenticated
  USING (
    submission_id IN (
      SELECT s.id FROM public.car_bca_submissions s
      WHERE s.location_id IN (
        SELECT pl.location_id FROM public.profile_locations pl
        WHERE pl.profile_id = (SELECT auth.uid())
          AND (SELECT private.auth_is_active_staff())
      )
    )
  );

-- chooser_settings (414) --------------------------------------------------
DROP POLICY IF EXISTS chooser_settings_ins ON public.chooser_settings;
CREATE POLICY chooser_settings_ins ON public.chooser_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
         AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
         AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS chooser_settings_upd ON public.chooser_settings;
CREATE POLICY chooser_settings_upd ON public.chooser_settings
  FOR UPDATE TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
         AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
         AND (SELECT private.auth_is_active_staff())
    )
  )
  WITH CHECK (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
         AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
         AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS chooser_settings_del ON public.chooser_settings;
CREATE POLICY chooser_settings_del ON public.chooser_settings
  FOR DELETE TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.profile_organizations po
       WHERE po.organization_id = chooser_settings.organization_id
         AND po.profile_id = (SELECT auth.uid())
         AND po.role = 'org_admin'
         AND (SELECT private.auth_is_active_staff())
    )
    OR EXISTS (
      SELECT 1 FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE l.organization_id = chooser_settings.organization_id
         AND pl.profile_id = (SELECT auth.uid())
         AND pl.role = 'owner'
         AND (SELECT private.auth_is_active_staff())
    )
  );

-- agent_knowledge (320) ---------------------------------------------------
DROP POLICY IF EXISTS "agent_knowledge_read" ON public.agent_knowledge;
CREATE POLICY "agent_knowledge_read" ON public.agent_knowledge FOR SELECT TO authenticated
  USING ( (select private.auth_is_master()) OR private.auth_is_manager_at(location_id) OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = agent_knowledge.location_id AND (SELECT private.auth_is_active_staff()))) );

-- channel_connections / instagram_* / glofox_memberships (242; TO public) --
DROP POLICY IF EXISTS channel_connections_select ON public.channel_connections;
CREATE POLICY channel_connections_select ON public.channel_connections
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = channel_connections.location_id
        AND pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS glofox_memberships_select ON public.glofox_memberships;
CREATE POLICY glofox_memberships_select ON public.glofox_memberships
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = glofox_memberships.location_id
        AND pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS ig_conv_select ON public.instagram_conversations;
CREATE POLICY ig_conv_select ON public.instagram_conversations
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = instagram_conversations.location_id
        AND pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

DROP POLICY IF EXISTS ig_msg_select ON public.instagram_messages;
CREATE POLICY ig_msg_select ON public.instagram_messages
  FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM profile_locations pl
      WHERE pl.location_id = instagram_messages.location_id
        AND pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- agent_membership_requests (363) ----------------------------------------
DROP POLICY IF EXISTS agent_membership_requests_read ON public.agent_membership_requests;
CREATE POLICY agent_membership_requests_read ON public.agent_membership_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT private.auth_is_master())
    OR private.auth_is_manager_at(location_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = agent_membership_requests.location_id
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- org_settings (320) ------------------------------------------------------
DROP POLICY IF EXISTS "org_settings_select" ON public.org_settings;
CREATE POLICY "org_settings_select" ON public.org_settings FOR SELECT TO authenticated
  USING ( (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff())))) OR private.auth_is_in_organization(organization_id) );
DROP POLICY IF EXISTS "org_settings_ins" ON public.org_settings;
CREATE POLICY "org_settings_ins" ON public.org_settings FOR INSERT TO authenticated
  WITH CHECK ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );
DROP POLICY IF EXISTS "org_settings_upd" ON public.org_settings;
CREATE POLICY "org_settings_upd" ON public.org_settings FOR UPDATE TO authenticated
  USING ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) )
  WITH CHECK ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );
DROP POLICY IF EXISTS "org_settings_del" ON public.org_settings;
CREATE POLICY "org_settings_del" ON public.org_settings FOR DELETE TO authenticated
  USING ( private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text AND (SELECT private.auth_is_active_staff()))) );

-- contract_template_versions (446) ---------------------------------------
DROP POLICY IF EXISTS "contract_template_versions_read" ON public.contract_template_versions;
CREATE POLICY "contract_template_versions_read" ON public.contract_template_versions
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (
      SELECT 1 FROM public.contract_templates ct
      WHERE ct.id = contract_template_versions.template_id
        AND ct.organization_id IN (
          SELECT l.organization_id
          FROM public.profile_locations pl
          JOIN public.locations l ON l.id = pl.location_id
          WHERE pl.profile_id = (SELECT auth.uid())
            AND pl.role = 'owner'
            AND (SELECT private.auth_is_active_staff())
        )
    )
  );

-- zoom_sync_runs (491) ----------------------------------------------------
DROP POLICY IF EXISTS zoom_sync_runs_select ON public.zoom_sync_runs;
CREATE POLICY zoom_sync_runs_select ON public.zoom_sync_runs
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT l.organization_id
        FROM public.locations l
        JOIN public.profile_locations pl ON pl.location_id = l.id
       WHERE pl.profile_id = (SELECT auth.uid())
         AND (SELECT private.auth_is_active_staff())
    )
  );

-- cancellation_form_links (585) ------------------------------------------
DROP POLICY IF EXISTS cancellation_form_links_select ON public.cancellation_form_links;
CREATE POLICY cancellation_form_links_select ON public.cancellation_form_links
  FOR SELECT TO authenticated
  USING (
    (SELECT private.auth_is_master())
    OR private.auth_is_manager_at(location_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = cancellation_form_links.location_id
        AND (SELECT private.auth_is_active_staff())
    )
  );

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Self-check — RAISE aborts the WHOLE file (explicit BEGIN/COMMIT)
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record;
  v_bad text[] := ARRAY[]::text[];
  v_n integer;
BEGIN
  -- 4a. Gated helpers carry the predicate, are SECURITY DEFINER and STABLE.
  FOR r IN
    SELECT x.sig, p.prosrc, p.prosecdef, p.provolatile
      FROM (VALUES
        ('private.auth_is_active_staff()'), ('private.auth_is_master()'),
        ('private.auth_is_in_location(uuid)'), ('private.auth_is_owner_at(uuid)'),
        ('private.auth_is_admin_at(uuid)'), ('private.auth_is_manager_at(uuid)'),
        ('private.auth_is_in_organization(uuid)'), ('private.auth_role()'),
        ('private.get_user_role(uuid)'), ('private.get_user_role_at(uuid, uuid)'),
        ('private.mobile_can_for(uuid, uuid, text)'), ('private.auth_can_view_all_profiles()'),
        ('private.auth_is_admin_or_head_coach()'), ('private.is_owner()'),
        ('private.auth_has_mailbox_grant(uuid)'), ('private.auth_has_ticket_mailbox_grant(uuid)')
      ) AS x(sig)
      JOIN pg_proc p ON p.oid = x.sig::regprocedure
  LOOP
    IF r.prosrc !~* 'active\s+is\s+not\s+false' OR r.prosrc !~* 'deleted_at\s+is\s+null'
       OR NOT r.prosecdef OR r.provolatile <> 's' THEN
      v_bad := v_bad || r.sig;
    END IF;
  END LOOP;

  -- 4a'. Nothing else moved: every pre-existing helper keeps the SECURITY
  --      DEFINER flag, volatility, search_path, owner and ACL captured at the
  --      top of this transaction. The only allowed change is is_owner()'s:
  --      search_path becomes '' (and STABLE, if it was not already).
  SELECT count(*) INTO v_n FROM mig626_helpers_before;
  IF v_n <> 22 THEN
    v_bad := v_bad || ('expected 22 pre-existing helpers, found ' || v_n);
  END IF;
  FOR r IN
    SELECT b.sig, b.prosecdef AS b_def, p.prosecdef, b.provolatile AS b_vol, p.provolatile,
           b.proconfig AS b_cfg, p.proconfig, b.proowner AS b_own, p.proowner,
           b.proacl::text AS b_acl, p.proacl::text AS acl
      FROM mig626_helpers_before b
      LEFT JOIN pg_proc p ON p.oid = b.oid
  LOOP
    IF r.prosecdef IS DISTINCT FROM r.b_def OR r.proowner IS DISTINCT FROM r.b_own
       OR r.acl IS DISTINCT FROM r.b_acl
       OR (r.sig <> 'private.is_owner()' AND (r.provolatile IS DISTINCT FROM r.b_vol
                                               OR r.proconfig IS DISTINCT FROM r.b_cfg))
       OR (r.sig = 'private.is_owner()' AND (r.provolatile <> 's'
                                              OR r.proconfig IS DISTINCT FROM ARRAY['search_path=""'])) THEN
      v_bad := v_bad || ('catalog drift on ' || r.sig);
    END IF;
  END LOOP;

  -- 4a''. The new helper: search_path '', EXECUTE for anon + authenticated,
  --       none for PUBLIC.
  IF (SELECT proconfig FROM pg_proc WHERE oid = 'private.auth_is_active_staff()'::regprocedure)
       IS DISTINCT FROM ARRAY['search_path=""']
     OR NOT has_function_privilege('anon', 'private.auth_is_active_staff()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'private.auth_is_active_staff()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'private.auth_is_active_staff()'::regprocedure AND a.grantee = 0) THEN
    v_bad := v_bad || 'private.auth_is_active_staff() grants/search_path'::text;
  END IF;

  -- 4b. Delegating staff helpers still delegate to a gated helper.
  FOR r IN
    SELECT x.sig, x.must_call, p.prosrc
      FROM (VALUES
        ('private.auth_is_owner()',                          'private\.auth_role\('),
        ('private.auth_is_owner_or_manager()',               'private\.auth_role\('),
        ('private.auth_mobile_can(uuid, text)',              'private\.mobile_can_for\('),
        ('private.auth_is_manager_at_bridge(uuid)',          'private\.auth_is_manager_at\('),
        ('private.auth_can_read_shift_block(uuid, uuid)',    'private\.auth_is_manager_at\('),
        ('private.auth_can_read_shift_assignment(uuid, uuid)', 'private\.auth_is_manager_at\(')
      ) AS x(sig, must_call)
      JOIN pg_proc p ON p.oid = x.sig::regprocedure
  LOOP
    IF r.prosrc !~ r.must_call THEN
      v_bad := v_bad || r.sig;
    END IF;
  END LOOP;

  -- 4c. MEMBER authority untouched.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = 'private.auth_contact_id()'::regprocedure AND prosrc ~* 'active';
  IF v_n > 0 THEN
    v_bad := v_bad || 'private.auth_contact_id() (member helper must not check staff active)'::text;
  END IF;

  -- 4d. Every policy this file re-created carries the gate in each
  --     expression it has.
  FOR r IN
    SELECT x.s, x.t, x.n, pp.qual, pp.with_check, pp.permissive
      FROM (VALUES
        ('public','profile_compensation','profile_compensation_select'),
        ('public','profile_compensation','profile_compensation_insert'),
        ('public','profile_compensation','profile_compensation_update'),
        ('public','password_overrides_audit','password_overrides_audit_master_read'),
        ('public','policies','policies_ins'), ('public','policies','policies_upd'), ('public','policies','policies_del'),
        ('public','policy_versions','policy_versions_ins'), ('public','policy_versions','policy_versions_upd'),
        ('public','policy_versions','policy_versions_del'),
        ('public','policy_views','policy_views_select_own_or_admin'),
        ('public','audit_events','audit_events_select_master_owner'),
        ('public','fte_expense_claims','fte_expense_claims_read'),
        ('public','fte_expense_items','fte_expense_items_read'),
        ('public','invoices_queue','inbound_invoices_read'),
        ('storage','objects','Owner reads org signed PDFs'),
        ('public','organizations','organizations_select'),
        ('public','contract_templates','contract_templates_write'),
        ('public','contracts','contracts_read'), ('public','contracts','contracts_insert'),
        ('public','contracts','contracts_update'), ('public','contracts','contracts_delete'),
        ('public','landing_page_settings','landing_page_settings_ins'),
        ('public','landing_page_settings','landing_page_settings_upd'),
        ('public','landing_page_settings','landing_page_settings_del'),
        ('public','glofox_invoices','glofox_invoices_select'),
        ('public','glofox_sync_runs','glofox_sync_runs_select'),
        ('public','glofox_push_events','glofox_push_events_select'),
        ('public','pipeline_classification_runs','pipeline_classification_runs_select'),
        ('public','car_bca_submissions','car_bca_submissions_read_at_location'),
        ('public','car_bca_submission_events','car_bca_submission_events_read_at_location'),
        ('public','chooser_settings','chooser_settings_ins'), ('public','chooser_settings','chooser_settings_upd'),
        ('public','chooser_settings','chooser_settings_del'),
        ('public','agent_knowledge','agent_knowledge_read'),
        ('public','channel_connections','channel_connections_select'),
        ('public','instagram_conversations','ig_conv_select'),
        ('public','instagram_messages','ig_msg_select'),
        ('public','glofox_memberships','glofox_memberships_select'),
        ('public','agent_membership_requests','agent_membership_requests_read'),
        ('public','org_settings','org_settings_select'), ('public','org_settings','org_settings_ins'),
        ('public','org_settings','org_settings_upd'), ('public','org_settings','org_settings_del'),
        ('public','contract_template_versions','contract_template_versions_read'),
        ('public','zoom_sync_runs','zoom_sync_runs_select'),
        ('public','cancellation_form_links','cancellation_form_links_select')
      ) AS x(s, t, n)
      LEFT JOIN pg_policies pp ON pp.schemaname = x.s AND pp.tablename = x.t AND pp.policyname = x.n
  LOOP
    IF r.permissive IS DISTINCT FROM 'PERMISSIVE'
       OR (r.qual IS NULL AND r.with_check IS NULL)
       OR (r.qual IS NOT NULL AND r.qual !~ 'auth_is_active_staff')
       OR (r.with_check IS NOT NULL AND r.with_check !~ 'auth_is_active_staff') THEN
      v_bad := v_bad || (r.s || '.' || r.t || ' :: ' || r.n);
    END IF;
  END LOOP;

  -- 4e. Prod-wide: ANY policy expression that reads a profile table must
  --     carry the gate. Allowlist = target-scoped policies whose caller check
  --     is a gated helper. Catches a policy that exists only on prod.
  FOR r IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE (coalesce(qual, '') ~* '\m(profiles|profile_locations|profile_organizations)\M'
            AND coalesce(qual, '') !~ 'auth_is_active_staff')
        OR (coalesce(with_check, '') ~* '\m(profiles|profile_locations|profile_organizations)\M'
            AND coalesce(with_check, '') !~ 'auth_is_active_staff')
  LOOP
    IF NOT (r.schemaname = 'public' AND r.tablename = 'staff_allowances'
            AND r.policyname IN ('staff_allowances_select', 'staff_allowances_ins',
                                 'staff_allowances_upd', 'staff_allowances_del')) THEN
      v_bad := v_bad || ('ungated inline policy ' || r.schemaname || '.' || r.tablename || ' :: ' || r.policyname);
    END IF;
  END LOOP;

  -- 4f. Prod-wide: no SECURITY DEFINER function in public/private reads a
  --     profile table for auth.uid() without the predicate.
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'private') AND p.prosecdef
       AND p.prosrc ~ 'auth\.uid\(\)'
       AND p.prosrc ~* '\m(profiles|profile_locations|profile_organizations)\M'
       AND p.prosrc !~* 'active\s+is\s+not\s+false'
       AND p.prosrc !~ 'auth_is_active_staff'
  LOOP
    v_bad := v_bad || ('ungated definer function ' || r.sig);
  END LOOP;

  IF cardinality(v_bad) > 0 THEN
    RAISE EXCEPTION 'mig 626 self-check failed: %', array_to_string(v_bad, '; ');
  END IF;
END $$;

COMMIT;
