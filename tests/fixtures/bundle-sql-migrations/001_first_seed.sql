CREATE TABLE IF NOT EXISTS private.permission_key_bundles (
  key text NOT NULL,
  bundle text NOT NULL,
  PRIMARY KEY (key, bundle)
);

INSERT INTO private.permission_key_bundles (key, bundle) VALUES
  ('pipeline', 'bundle_sales'),
  ('email', 'bundle_messaging');
