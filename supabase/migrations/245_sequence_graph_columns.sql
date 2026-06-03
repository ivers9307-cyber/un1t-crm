-- 245_sequence_graph_columns.sql
-- FLOW-GRAPH.6 — add the declarative node-graph to email_sequences.
-- The graph is the source of truth for editing + agent authoring; it
-- compiles to sequence_steps (the unchanged execution artifact). Nullable,
-- no behaviour change on deploy. `draft_graph` holds an unpublished edit;
-- `graph` is the published/canonical one.
ALTER TABLE email_sequences
  ADD COLUMN IF NOT EXISTS graph         JSONB,
  ADD COLUMN IF NOT EXISTS draft_graph   JSONB,
  ADD COLUMN IF NOT EXISTS graph_version INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN email_sequences.graph IS
  'Canonical declarative flow graph {trigger,nodes[],edges[]}. Compiles to sequence_steps (FLOW-GRAPH, 2026-06).';
COMMENT ON COLUMN email_sequences.draft_graph IS
  'Unpublished draft graph; Publish promotes it to graph + recompiles steps.';
