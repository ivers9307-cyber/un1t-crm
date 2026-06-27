-- 320 — PERF: consolidate multiple_permissive_policies (Supabase advisor WARN x91 -> 0)
-- Applied via Supabase MCP on 2026-06-27 (remote version 20260627113932); this file is the
-- source-controlled record (forward-only). Same idea as mig 167 (consolidate_multi_permissive_policies_167).
--
-- Behaviour-preserving by construction:
--   * Merge N permissive SELECT policies into ONE: USING (q1 OR q2 ...). RLS already ORs permissive
--     policies, so the visible-row set is identical.
--   * Split a FOR ALL "manage" policy into per-command write policies (INSERT/UPDATE/DELETE) when its
--     SELECT branch overlapped a read policy. FOR ALL == the four per-command policies; when the original
--     WITH CHECK was null, USING is copied into the split check (Postgres uses USING as the check).
--   Merged-policy role set = UNION of contributing roles (never narrows access; private.auth_*()/auth.uid()
--   predicates yield nothing for anon, so widening to public adds no real rows).
--   Exception: google_reviews — a {public} member-read + an {anon} public-read can't merge, so the member
--   policy is narrowed to {authenticated} (its predicate already excluded anon) to clear the anon overlap.
-- Verified post-apply: advisor multiple_permissive_policies 91 -> 0; anon sees 0 rows on every protected
-- table; master/staff retain full access (contacts 8310 == old union; profiles/health-metrics unchanged).

-- achievement_rules
DROP POLICY "Masters manage rules" ON public.achievement_rules;
CREATE POLICY "achievement_rules_ins" ON public.achievement_rules FOR INSERT TO authenticated WITH CHECK ((select private.auth_is_master()));
CREATE POLICY "achievement_rules_upd" ON public.achievement_rules FOR UPDATE TO authenticated USING ((select private.auth_is_master())) WITH CHECK ((select private.auth_is_master()));
CREATE POLICY "achievement_rules_del" ON public.achievement_rules FOR DELETE TO authenticated USING ((select private.auth_is_master()));

-- agent_knowledge
DROP POLICY "agent_knowledge_write" ON public.agent_knowledge;
DROP POLICY "agent_knowledge_read" ON public.agent_knowledge;
CREATE POLICY "agent_knowledge_read" ON public.agent_knowledge FOR SELECT TO authenticated USING (
  (select private.auth_is_master()) OR private.auth_is_manager_at(location_id)
  OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = agent_knowledge.location_id))
);
CREATE POLICY "agent_knowledge_ins" ON public.agent_knowledge FOR INSERT TO authenticated WITH CHECK ((select private.auth_is_master()) OR private.auth_is_manager_at(location_id));
CREATE POLICY "agent_knowledge_upd" ON public.agent_knowledge FOR UPDATE TO authenticated USING ((select private.auth_is_master()) OR private.auth_is_manager_at(location_id)) WITH CHECK ((select private.auth_is_master()) OR private.auth_is_manager_at(location_id));
CREATE POLICY "agent_knowledge_del" ON public.agent_knowledge FOR DELETE TO authenticated USING ((select private.auth_is_master()) OR private.auth_is_manager_at(location_id));

-- agent_membership_requests
DROP POLICY "agent_membership_requests_write" ON public.agent_membership_requests;
CREATE POLICY "agent_membership_requests_ins" ON public.agent_membership_requests FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "agent_membership_requests_upd" ON public.agent_membership_requests FOR UPDATE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id)) WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "agent_membership_requests_del" ON public.agent_membership_requests FOR DELETE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));

-- ble_bridges
DROP POLICY "Master can manage bridges" ON public.ble_bridges;
DROP POLICY "Staff can view bridges at location" ON public.ble_bridges;
CREATE POLICY "ble_bridges_read" ON public.ble_bridges FOR SELECT TO public USING ((select private.auth_is_master()) OR private.auth_is_in_location(location_id));
CREATE POLICY "ble_bridges_ins" ON public.ble_bridges FOR INSERT TO public WITH CHECK (private.auth_is_master());
CREATE POLICY "ble_bridges_upd" ON public.ble_bridges FOR UPDATE TO public USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());
CREATE POLICY "ble_bridges_del" ON public.ble_bridges FOR DELETE TO public USING (private.auth_is_master());

-- challenges
DROP POLICY "Staff manage challenges at their locations" ON public.challenges;
DROP POLICY "Customers read active challenges at their location" ON public.challenges;
CREATE POLICY "challenges_read" ON public.challenges FOR SELECT TO public USING (
  ((select private.auth_is_master()) OR private.auth_is_in_location(location_id))
  OR ((ends_on >= ((now() AT TIME ZONE 'utc'::text))::date) AND (EXISTS ( SELECT 1 FROM contacts c WHERE c.id = (select private.auth_contact_id()) AND c.location_id = challenges.location_id)))
);
CREATE POLICY "challenges_ins" ON public.challenges FOR INSERT TO public WITH CHECK ((select private.auth_is_master()) OR private.auth_is_in_location(location_id));
CREATE POLICY "challenges_upd" ON public.challenges FOR UPDATE TO public USING ((select private.auth_is_master()) OR private.auth_is_in_location(location_id)) WITH CHECK ((select private.auth_is_master()) OR private.auth_is_in_location(location_id));
CREATE POLICY "challenges_del" ON public.challenges FOR DELETE TO public USING ((select private.auth_is_master()) OR private.auth_is_in_location(location_id));

-- chooser_settings
DROP POLICY "chooser_settings_write" ON public.chooser_settings;
CREATE POLICY "chooser_settings_ins" ON public.chooser_settings FOR INSERT TO public WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));
CREATE POLICY "chooser_settings_upd" ON public.chooser_settings FOR UPDATE TO public USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text))) WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));
CREATE POLICY "chooser_settings_del" ON public.chooser_settings FOR DELETE TO public USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));

-- coaching_goals
DROP POLICY "coaching_goals_loc" ON public.coaching_goals;
DROP POLICY "coaching_goals_self" ON public.coaching_goals;
CREATE POLICY "coaching_goals_read" ON public.coaching_goals FOR SELECT TO public USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY "coaching_goals_ins" ON public.coaching_goals FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "coaching_goals_upd" ON public.coaching_goals FOR UPDATE TO authenticated USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "coaching_goals_del" ON public.coaching_goals FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));

-- company_settings
DROP POLICY "Owners can manage company settings" ON public.company_settings;
DROP POLICY "company_settings_location_scoped_read" ON public.company_settings;
CREATE POLICY "company_settings_read" ON public.company_settings FOR SELECT TO public USING (private.auth_is_owner() OR private.auth_is_in_location(location_id));
CREATE POLICY "company_settings_ins" ON public.company_settings FOR INSERT TO public WITH CHECK (private.auth_is_owner());
CREATE POLICY "company_settings_upd" ON public.company_settings FOR UPDATE TO public USING (private.auth_is_owner()) WITH CHECK (private.auth_is_owner());
CREATE POLICY "company_settings_del" ON public.company_settings FOR DELETE TO public USING (private.auth_is_owner());

-- consultation_photos
DROP POLICY "consultation_photos_loc" ON public.consultation_photos;
DROP POLICY "consultation_photos_self" ON public.consultation_photos;
CREATE POLICY "consultation_photos_read" ON public.consultation_photos FOR SELECT TO public USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY "consultation_photos_ins" ON public.consultation_photos FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "consultation_photos_upd" ON public.consultation_photos FOR UPDATE TO authenticated USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "consultation_photos_del" ON public.consultation_photos FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));

-- contact_goals
DROP POLICY "Customers manage own goals" ON public.contact_goals;
DROP POLICY "Staff read goals at their locations" ON public.contact_goals;
CREATE POLICY "contact_goals_read" ON public.contact_goals FOR SELECT TO public USING (
  (contact_id = private.auth_contact_id())
  OR (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM contacts c WHERE c.id = contact_goals.contact_id AND private.auth_is_in_location(c.location_id))))
);
CREATE POLICY "contact_goals_ins" ON public.contact_goals FOR INSERT TO public WITH CHECK (contact_id = private.auth_contact_id());
CREATE POLICY "contact_goals_upd" ON public.contact_goals FOR UPDATE TO public USING (contact_id = private.auth_contact_id()) WITH CHECK (contact_id = private.auth_contact_id());
CREATE POLICY "contact_goals_del" ON public.contact_goals FOR DELETE TO public USING (contact_id = private.auth_contact_id());

-- contacts
DROP POLICY "contacts_location_scoped" ON public.contacts;
DROP POLICY "Customers can read own contact" ON public.contacts;
DROP POLICY "Customers can update own contact" ON public.contacts;
CREATE POLICY "contacts_select" ON public.contacts FOR SELECT TO public USING (private.auth_is_in_location(location_id) OR (user_id = (select auth.uid())));
CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE TO public USING (private.auth_is_in_location(location_id) OR (user_id = (select auth.uid()))) WITH CHECK (private.auth_is_in_location(location_id) OR (user_id = (select auth.uid())));
CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "contacts_delete" ON public.contacts FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));

-- contracts
DROP POLICY "contracts_write" ON public.contracts;
DROP POLICY "Recipient signs own contract" ON public.contracts;
CREATE POLICY "contracts_insert" ON public.contracts FOR INSERT TO authenticated WITH CHECK (
  private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text))
);
CREATE POLICY "contracts_update" ON public.contracts FOR UPDATE TO authenticated USING (
  private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text)) OR (profile_id = (select auth.uid()))
) WITH CHECK (
  private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text)) OR (profile_id = (select auth.uid()))
);
CREATE POLICY "contracts_delete" ON public.contracts FOR DELETE TO authenticated USING (
  private.auth_is_master() OR (organization_id IN ( SELECT l.organization_id FROM (profile_locations pl JOIN locations l ON l.id = pl.location_id) WHERE pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text))
);

-- customer_engagement_nudges
DROP POLICY "Customers read own engagement nudges" ON public.customer_engagement_nudges;
DROP POLICY "Staff read engagement nudges at their locations" ON public.customer_engagement_nudges;
CREATE POLICY "customer_engagement_nudges_read" ON public.customer_engagement_nudges FOR SELECT TO public USING (
  (contact_id = (select private.auth_contact_id()))
  OR ((select private.auth_is_master()) OR (EXISTS ( SELECT 1 FROM contacts c WHERE c.id = customer_engagement_nudges.contact_id AND private.auth_is_in_location(c.location_id))))
);

-- event_type_reminders
DROP POLICY "event_type_reminders managers can write" ON public.event_type_reminders;
CREATE POLICY "event_type_reminders_ins" ON public.event_type_reminders FOR INSERT TO authenticated WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM event_types et WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)))
);
CREATE POLICY "event_type_reminders_upd" ON public.event_type_reminders FOR UPDATE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM event_types et WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)))
) WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM event_types et WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)))
);
CREATE POLICY "event_type_reminders_del" ON public.event_type_reminders FOR DELETE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM event_types et WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)))
);

-- google_business_connections
DROP POLICY "gbc_owner_write" ON public.google_business_connections;
CREATE POLICY "gbc_ins" ON public.google_business_connections FOR INSERT TO public WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "gbc_upd" ON public.google_business_connections FOR UPDATE TO public USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "gbc_del" ON public.google_business_connections FOR DELETE TO public USING (private.auth_is_in_location(location_id));

-- google_reviews (scope member_select to authenticated; preserves access, clears anon overlap)
DROP POLICY "google_reviews_member_select" ON public.google_reviews;
CREATE POLICY "google_reviews_member_select" ON public.google_reviews FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));

-- impersonation_log
DROP POLICY "impersonation_log_write" ON public.impersonation_log;
CREATE POLICY "impersonation_log_ins" ON public.impersonation_log FOR INSERT TO public WITH CHECK (private.auth_is_master());
CREATE POLICY "impersonation_log_upd" ON public.impersonation_log FOR UPDATE TO public USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());
CREATE POLICY "impersonation_log_del" ON public.impersonation_log FOR DELETE TO public USING (private.auth_is_master());

-- inbody_scans
DROP POLICY "inbody_scans_loc" ON public.inbody_scans;
DROP POLICY "inbody_scans_self" ON public.inbody_scans;
CREATE POLICY "inbody_scans_read" ON public.inbody_scans FOR SELECT TO public USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY "inbody_scans_ins" ON public.inbody_scans FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "inbody_scans_upd" ON public.inbody_scans FOR UPDATE TO authenticated USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "inbody_scans_del" ON public.inbody_scans FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));

-- landing_page_settings
DROP POLICY "landing_page_settings_master_owner_write" ON public.landing_page_settings;
CREATE POLICY "landing_page_settings_ins" ON public.landing_page_settings FOR INSERT TO authenticated WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text))
);
CREATE POLICY "landing_page_settings_upd" ON public.landing_page_settings FOR UPDATE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text))
) WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text))
);
CREATE POLICY "landing_page_settings_del" ON public.landing_page_settings FOR DELETE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (select auth.uid()) AND pl.location_id = landing_page_settings.location_id AND pl.role = 'owner'::text))
);

-- locations
DROP POLICY "Owners and masters can manage locations" ON public.locations;
DROP POLICY "Users can view assigned locations" ON public.locations;
CREATE POLICY "locations_read" ON public.locations FOR SELECT TO public USING (((select private.auth_is_master()) OR private.auth_is_owner_at(id)) OR private.auth_is_in_location(id));
CREATE POLICY "locations_ins" ON public.locations FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR private.auth_is_owner_at(id));
CREATE POLICY "locations_upd" ON public.locations FOR UPDATE TO authenticated USING (private.auth_is_master() OR private.auth_is_owner_at(id)) WITH CHECK (private.auth_is_master() OR private.auth_is_owner_at(id));
CREATE POLICY "locations_del" ON public.locations FOR DELETE TO authenticated USING (private.auth_is_master() OR private.auth_is_owner_at(id));

-- member_health_metrics
DROP POLICY "Customers view own health metrics" ON public.member_health_metrics;
DROP POLICY "Staff view location health metrics" ON public.member_health_metrics;
CREATE POLICY "member_health_metrics_read" ON public.member_health_metrics FOR SELECT TO public USING ((contact_id = (select private.auth_contact_id())) OR private.auth_is_in_location(location_id));

-- member_monthly_targets
DROP POLICY "Customers read own monthly targets" ON public.member_monthly_targets;
DROP POLICY "Staff read monthly targets at their locations" ON public.member_monthly_targets;
CREATE POLICY "member_monthly_targets_read" ON public.member_monthly_targets FOR SELECT TO public USING (
  (contact_id = (select private.auth_contact_id()))
  OR ((select private.auth_is_master()) OR (EXISTS ( SELECT 1 FROM contacts c WHERE c.id = member_monthly_targets.contact_id AND private.auth_is_in_location(c.location_id))))
);

-- org_settings
DROP POLICY "org_settings_write" ON public.org_settings;
DROP POLICY "org_settings_select" ON public.org_settings;
CREATE POLICY "org_settings_select" ON public.org_settings FOR SELECT TO authenticated USING (
  (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text)))
  OR private.auth_is_in_organization(organization_id)
);
CREATE POLICY "org_settings_ins" ON public.org_settings FOR INSERT TO authenticated WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text))
);
CREATE POLICY "org_settings_upd" ON public.org_settings FOR UPDATE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text))
) WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text))
);
CREATE POLICY "org_settings_del" ON public.org_settings FOR DELETE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM (locations l JOIN profile_locations pl ON pl.location_id = l.id) WHERE l.organization_id = org_settings.organization_id AND pl.profile_id = (select auth.uid()) AND pl.role = 'owner'::text))
);

-- organizations
DROP POLICY "organizations_master_write" ON public.organizations;
CREATE POLICY "organizations_ins" ON public.organizations FOR INSERT TO authenticated WITH CHECK (private.auth_is_master());
CREATE POLICY "organizations_upd" ON public.organizations FOR UPDATE TO authenticated USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());
CREATE POLICY "organizations_del" ON public.organizations FOR DELETE TO authenticated USING (private.auth_is_master());

-- pipeline_stages
DROP POLICY "pipeline_stages_admin_write" ON public.pipeline_stages;
DROP POLICY "pipeline_stages_select" ON public.pipeline_stages;
CREATE POLICY "pipeline_stages_select" ON public.pipeline_stages FOR SELECT TO authenticated USING (private.auth_is_admin_at(location_id) OR ((location_id IS NULL) OR private.auth_is_in_location(location_id)));
CREATE POLICY "pipeline_stages_ins" ON public.pipeline_stages FOR INSERT TO authenticated WITH CHECK (private.auth_is_admin_at(location_id));
CREATE POLICY "pipeline_stages_upd" ON public.pipeline_stages FOR UPDATE TO authenticated USING (private.auth_is_admin_at(location_id)) WITH CHECK (private.auth_is_admin_at(location_id));
CREATE POLICY "pipeline_stages_del" ON public.pipeline_stages FOR DELETE TO authenticated USING (private.auth_is_admin_at(location_id));

-- policies
DROP POLICY "policies_admin_write" ON public.policies;
CREATE POLICY "policies_ins" ON public.policies FOR INSERT TO authenticated WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));
CREATE POLICY "policies_upd" ON public.policies FOR UPDATE TO authenticated USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text))) WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));
CREATE POLICY "policies_del" ON public.policies FOR DELETE TO authenticated USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));

-- policy_versions
DROP POLICY "policy_versions_admin_write" ON public.policy_versions;
CREATE POLICY "policy_versions_ins" ON public.policy_versions FOR INSERT TO authenticated WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));
CREATE POLICY "policy_versions_upd" ON public.policy_versions FOR UPDATE TO authenticated USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text))) WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));
CREATE POLICY "policy_versions_del" ON public.policy_versions FOR DELETE TO authenticated USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text)));

-- profile_locations
DROP POLICY "Owners can manage location assignments" ON public.profile_locations;
DROP POLICY "Users can view own location assignments" ON public.profile_locations;
CREATE POLICY "profile_locations_read" ON public.profile_locations FOR SELECT TO authenticated USING (private.auth_is_owner_at(location_id) OR (profile_id = (select auth.uid())));
CREATE POLICY "profile_locations_ins" ON public.profile_locations FOR INSERT TO authenticated WITH CHECK (private.auth_is_owner_at(location_id));
CREATE POLICY "profile_locations_upd" ON public.profile_locations FOR UPDATE TO authenticated USING (private.auth_is_owner_at(location_id)) WITH CHECK (private.auth_is_owner_at(location_id));
CREATE POLICY "profile_locations_del" ON public.profile_locations FOR DELETE TO authenticated USING (private.auth_is_owner_at(location_id));

-- profiles
DROP POLICY "Admins can manage profiles" ON public.profiles;
DROP POLICY "profiles_read" ON public.profiles;
DROP POLICY "Users can update own profile" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING ((select private.auth_is_master()) OR (id = (select auth.uid())) OR private.auth_can_view_all_profiles());
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE TO authenticated USING ((select private.auth_is_master()) OR (id = (select auth.uid()))) WITH CHECK ((select private.auth_is_master()) OR (id = (select auth.uid())));
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK ((select private.auth_is_master()));
CREATE POLICY "profiles_delete" ON public.profiles FOR DELETE TO authenticated USING ((select private.auth_is_master()));

-- rosters
DROP POLICY "rosters managers can write" ON public.rosters;
CREATE POLICY "rosters_ins" ON public.rosters FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "rosters_upd" ON public.rosters FOR UPDATE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id)) WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "rosters_del" ON public.rosters FOR DELETE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));

-- shift_assignments
DROP POLICY "shift_assignments managers can write" ON public.shift_assignments;
CREATE POLICY "shift_assignments_ins" ON public.shift_assignments FOR INSERT TO authenticated WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)))
);
CREATE POLICY "shift_assignments_upd" ON public.shift_assignments FOR UPDATE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)))
) WITH CHECK (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)))
);
CREATE POLICY "shift_assignments_del" ON public.shift_assignments FOR DELETE TO authenticated USING (
  private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)))
);

-- shift_blocks
DROP POLICY "shift_blocks managers can write" ON public.shift_blocks;
CREATE POLICY "shift_blocks_ins" ON public.shift_blocks FOR INSERT TO authenticated WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "shift_blocks_upd" ON public.shift_blocks FOR UPDATE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id)) WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "shift_blocks_del" ON public.shift_blocks FOR DELETE TO authenticated USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));

-- shift_swap_requests
DROP POLICY "Managers can manage swap requests" ON public.shift_swap_requests;
DROP POLICY "Staff can create swap requests" ON public.shift_swap_requests;
DROP POLICY "Managers can view all swap requests" ON public.shift_swap_requests;
DROP POLICY "Staff can view own swap requests" ON public.shift_swap_requests;
CREATE POLICY "shift_swap_requests_select" ON public.shift_swap_requests FOR SELECT TO public USING (private.auth_is_admin_or_head_coach() OR ((requester_id = (select auth.uid())) OR (target_id = (select auth.uid()))));
CREATE POLICY "shift_swap_requests_insert" ON public.shift_swap_requests FOR INSERT TO public WITH CHECK (private.auth_is_admin_or_head_coach() OR (requester_id = (select auth.uid())));
CREATE POLICY "shift_swap_requests_update" ON public.shift_swap_requests FOR UPDATE TO public USING (private.auth_is_admin_or_head_coach()) WITH CHECK (private.auth_is_admin_or_head_coach());
CREATE POLICY "shift_swap_requests_delete" ON public.shift_swap_requests FOR DELETE TO public USING (private.auth_is_admin_or_head_coach());

-- shift_templates
DROP POLICY "Managers can manage shift templates" ON public.shift_templates;
CREATE POLICY "shift_templates_ins" ON public.shift_templates FOR INSERT TO public WITH CHECK (private.auth_is_admin_or_head_coach());
CREATE POLICY "shift_templates_upd" ON public.shift_templates FOR UPDATE TO public USING (private.auth_is_admin_or_head_coach()) WITH CHECK (private.auth_is_admin_or_head_coach());
CREATE POLICY "shift_templates_del" ON public.shift_templates FOR DELETE TO public USING (private.auth_is_admin_or_head_coach());

-- staff_allowances
DROP POLICY "Admins can manage allowances" ON public.staff_allowances;
DROP POLICY "Admins can view all allowances" ON public.staff_allowances;
DROP POLICY "Staff can view own allowances" ON public.staff_allowances;
CREATE POLICY "staff_allowances_select" ON public.staff_allowances FOR SELECT TO public USING (private.auth_is_owner_or_manager() OR private.auth_is_admin_or_head_coach() OR (profile_id = (select auth.uid())));
CREATE POLICY "staff_allowances_ins" ON public.staff_allowances FOR INSERT TO public WITH CHECK (private.auth_is_owner_or_manager());
CREATE POLICY "staff_allowances_upd" ON public.staff_allowances FOR UPDATE TO public USING (private.auth_is_owner_or_manager()) WITH CHECK (private.auth_is_owner_or_manager());
CREATE POLICY "staff_allowances_del" ON public.staff_allowances FOR DELETE TO public USING (private.auth_is_owner_or_manager());

-- strap_assignments
DROP POLICY "Admins can manage strap assignments" ON public.strap_assignments;
DROP POLICY "strap_assignments_read" ON public.strap_assignments;
CREATE POLICY "strap_assignments_read" ON public.strap_assignments FOR SELECT TO public USING (
  private.auth_is_admin_or_head_coach()
  OR (contact_id = private.auth_contact_id())
  OR (EXISTS ( SELECT 1 FROM ble_bridges b WHERE b.id = strap_assignments.ble_bridge_id AND private.auth_is_in_location(b.location_id)))
);
CREATE POLICY "strap_assignments_ins" ON public.strap_assignments FOR INSERT TO public WITH CHECK (private.auth_is_admin_or_head_coach());
CREATE POLICY "strap_assignments_upd" ON public.strap_assignments FOR UPDATE TO public USING (private.auth_is_admin_or_head_coach()) WITH CHECK (private.auth_is_admin_or_head_coach());
CREATE POLICY "strap_assignments_del" ON public.strap_assignments FOR DELETE TO public USING (private.auth_is_admin_or_head_coach());

-- time_off_requests (INSERT policy "Staff can create own time off" intentionally retained)
DROP POLICY "Admins can view all time off" ON public.time_off_requests;
DROP POLICY "Staff can view own time off" ON public.time_off_requests;
DROP POLICY "Admins can manage time off" ON public.time_off_requests;
DROP POLICY "Staff can cancel own pending time off" ON public.time_off_requests;
CREATE POLICY "time_off_requests_select" ON public.time_off_requests FOR SELECT TO public USING (private.auth_is_admin_or_head_coach() OR (profile_id = (select auth.uid())));
CREATE POLICY "time_off_requests_update" ON public.time_off_requests FOR UPDATE TO public USING (
  private.auth_is_admin_or_head_coach() OR ((profile_id = (select auth.uid())) AND (status = 'pending'::text))
) WITH CHECK (
  private.auth_is_admin_or_head_coach() OR (status = 'cancelled'::text)
);

-- xero_connections
DROP POLICY "xero_connections_owner_write" ON public.xero_connections;
CREATE POLICY "xero_connections_ins" ON public.xero_connections FOR INSERT TO public WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "xero_connections_upd" ON public.xero_connections FOR UPDATE TO public USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY "xero_connections_del" ON public.xero_connections FOR DELETE TO public USING (private.auth_is_in_location(location_id));
