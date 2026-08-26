-- 570 — car_enquiries.source follows the rebrand (GIVERS-WEB.1).
--
-- The car business rebranded from CCF Autos to Givers Autos and the
-- marketing site moved to giversautos.com (mig 479 created this table
-- with default 'ccfautos.com'). New enquiries must record the current
-- brand, or every row from here on is mislabelled.
--
-- Existing rows are deliberately NOT rewritten: they genuinely arrived
-- via ccfautos.com and the column is a record of where they came from,
-- not of what the business is called today.

alter table car_enquiries alter column source set default 'giversautos.com';
