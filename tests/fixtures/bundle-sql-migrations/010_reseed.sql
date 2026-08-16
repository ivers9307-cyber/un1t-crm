-- reseed after a real KEY_BUNDLES change
TRUNCATE private.permission_key_bundles;

INSERT INTO private.permission_key_bundles (key, bundle) VALUES
  ('pipeline', 'bundle_sales'),
  ('email', 'bundle_messaging'),
  ('email', 'bundle_marketing'),
  ('bookings', 'bundle_members');
