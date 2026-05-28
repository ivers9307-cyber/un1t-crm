-- MOBILE-RLS.2 — replace the location-only ALL policies on the
-- direct-CRUD tables with per-command, permission-gated policies. Only
-- affects non-service-role clients (the mobile app); the web app uses
-- the service-role key and bypasses RLS, so web behaviour is unchanged.
-- SELECT/INSERT/UPDATE require the mobile feature permission
-- (private.auth_mobile_can); DELETE is restricted to manager+
-- (private.auth_is_manager_at — existing helper = owner/manager/head_coach;
-- mobile never deletes these). pipeline_stages left location-only
-- (non-PII board config). Applied to prod via Supabase MCP on 2026-05-29.
DROP POLICY "deals_location_scoped" ON public.deals;
CREATE POLICY "deals_select" ON public.deals FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "deals_insert" ON public.deals FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "deals_update" ON public.deals FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'pipeline')) WITH CHECK (private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "deals_delete" ON public.deals FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));

DROP POLICY "notes_location_scoped" ON public.notes;
CREATE POLICY "notes_select" ON public.notes FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "notes_insert" ON public.notes FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "notes_update" ON public.notes FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'pipeline')) WITH CHECK (private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "notes_delete" ON public.notes FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));

DROP POLICY "activities_location_scoped" ON public.activities;
CREATE POLICY "activities_select" ON public.activities FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'tasks') OR private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "activities_insert" ON public.activities FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'tasks') OR private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "activities_update" ON public.activities FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'tasks') OR private.auth_mobile_can(location_id,'pipeline')) WITH CHECK (private.auth_mobile_can(location_id,'tasks') OR private.auth_mobile_can(location_id,'pipeline'));
CREATE POLICY "activities_delete" ON public.activities FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));

DROP POLICY "bookings_location_scoped" ON public.bookings;
CREATE POLICY "bookings_select" ON public.bookings FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'bookings'));
CREATE POLICY "bookings_insert" ON public.bookings FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'bookings'));
CREATE POLICY "bookings_update" ON public.bookings FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'bookings')) WITH CHECK (private.auth_mobile_can(location_id,'bookings'));
CREATE POLICY "bookings_delete" ON public.bookings FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));

DROP POLICY "whatsapp_conversations_location_scoped" ON public.whatsapp_conversations;
CREATE POLICY "wa_conv_select" ON public.whatsapp_conversations FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_conv_insert" ON public.whatsapp_conversations FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_conv_update" ON public.whatsapp_conversations FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'whatsapp')) WITH CHECK (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_conv_delete" ON public.whatsapp_conversations FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));

DROP POLICY "whatsapp_messages_location_scoped" ON public.whatsapp_messages;
CREATE POLICY "wa_msg_select" ON public.whatsapp_messages FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_msg_insert" ON public.whatsapp_messages FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_msg_update" ON public.whatsapp_messages FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'whatsapp')) WITH CHECK (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_msg_delete" ON public.whatsapp_messages FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));

DROP POLICY "whatsapp_templates_location_scoped" ON public.whatsapp_templates;
CREATE POLICY "wa_tmpl_select" ON public.whatsapp_templates FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_tmpl_insert" ON public.whatsapp_templates FOR INSERT TO authenticated WITH CHECK (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_tmpl_update" ON public.whatsapp_templates FOR UPDATE TO authenticated USING (private.auth_mobile_can(location_id,'whatsapp')) WITH CHECK (private.auth_mobile_can(location_id,'whatsapp'));
CREATE POLICY "wa_tmpl_delete" ON public.whatsapp_templates FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));
