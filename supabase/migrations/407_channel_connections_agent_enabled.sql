-- 407 — per-channel customer-agent gate (IG-DM).
-- agent_enabled=false (the default) means the customer agent (Mia)
-- never auto-replies on this channel; staff inbox flows (persistence,
-- unread, pushes) are unaffected. Default OFF so a freshly connected
-- channel is staff-only until an operator explicitly opts in.
alter table channel_connections
  add column if not exists agent_enabled boolean not null default false;

comment on column channel_connections.agent_enabled is
  'When false the customer agent (Mia) never auto-replies on this channel; staff inbox flows are unaffected (IG-DM, mig 407).';
