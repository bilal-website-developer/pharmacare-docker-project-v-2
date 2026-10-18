BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.control_plane_claims()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

CREATE TABLE public.shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  owner_name text NOT NULL,
  phone text NOT NULL,
  city text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Karachi',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.licences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  plan_type text NOT NULL CHECK (plan_type IN ('monthly', 'yearly', 'one_time')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  max_pcs integer NOT NULL CHECK (max_pcs > 0),
  offline_grace_days integer NOT NULL DEFAULT 14 CHECK (offline_grace_days BETWEEN 1 AND 60),
  warning_days integer NOT NULL DEFAULT 7 CHECK (warning_days BETWEEN 0 AND 30),
  renewal_notice_days integer NOT NULL DEFAULT 7 CHECK (renewal_notice_days BETWEEN 0 AND 30),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  signed_payload jsonb,
  signature text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licences_expiry_matches_plan CHECK (
    (plan_type = 'one_time' AND expires_at IS NULL)
    OR
    (plan_type IN ('monthly', 'yearly') AND expires_at IS NOT NULL AND expires_at > starts_at)
  )
);

CREATE INDEX licences_shop_updated_idx ON public.licences (shop_id, updated_at DESC);

CREATE TABLE public.activation_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  device_key_hash text NOT NULL UNIQUE CHECK (device_key_hash ~ '^[a-f0-9]{64}$'),
  device_name text NOT NULL,
  app_version text,
  last_seen_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.shop_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  email text NOT NULL CHECK (email = lower(email)),
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, email)
);

CREATE TABLE public.support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  scope text NOT NULL CHECK (scope IN ('diagnostics', 'read_only', 'admin_actions')),
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  token_hash text CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  approved_by_shop_admin uuid REFERENCES public.shop_admins(id),
  started_by_developer text,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  channel text NOT NULL DEFAULT 'pilot' CHECK (channel IN ('pilot', 'stable')),
  bundle_path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'withdrawn')),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.release_rollouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  release_id uuid NOT NULL REFERENCES public.releases(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'downloading', 'installed', 'failed', 'withdrawn')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, release_id)
);

CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  shop_id uuid REFERENCES public.shops(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.control_plane_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public.control_plane_reject_audit_mutation();

GRANT EXECUTE ON FUNCTION public.control_plane_claims() TO anon, authenticated, service_role;

REVOKE ALL ON public.shops, public.licences, public.activation_codes, public.devices,
  public.shop_admins, public.support_sessions, public.releases, public.release_rollouts,
  public.audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.shops, public.licences, public.activation_codes, public.devices,
  public.shop_admins, public.support_sessions, public.releases, public.release_rollouts,
  public.audit_log TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shops, public.licences,
  public.activation_codes, public.devices, public.shop_admins, public.support_sessions,
  public.releases, public.release_rollouts, public.audit_log TO authenticated, service_role;

ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY shops_select ON public.shops FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' IN ('device', 'shop_admin')
      AND id::text = public.control_plane_claims() ->> 'shop_id')
  );
CREATE POLICY shops_developer_write ON public.shops FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY licences_select ON public.licences FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' IN ('device', 'shop_admin')
      AND shop_id::text = public.control_plane_claims() ->> 'shop_id')
  );
CREATE POLICY licences_developer_write ON public.licences FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY activation_codes_developer_only ON public.activation_codes FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY devices_select ON public.devices FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' = 'device'
      AND shop_id::text = public.control_plane_claims() ->> 'shop_id')
  );
CREATE POLICY devices_developer_write ON public.devices FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY shop_admins_select ON public.shop_admins FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' = 'shop_admin'
      AND shop_id::text = public.control_plane_claims() ->> 'shop_id')
  );
CREATE POLICY shop_admins_developer_write ON public.shop_admins FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY support_sessions_developer_only ON public.support_sessions FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY releases_select ON public.releases FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' = 'device' AND status = 'approved')
  );
CREATE POLICY releases_developer_write ON public.releases FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY release_rollouts_select ON public.release_rollouts FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' = 'device'
      AND shop_id::text = public.control_plane_claims() ->> 'shop_id')
  );
CREATE POLICY release_rollouts_developer_write ON public.release_rollouts FOR ALL TO authenticated
  USING (public.control_plane_claims() ->> 'app_role' = 'developer')
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

CREATE POLICY audit_log_select ON public.audit_log FOR SELECT TO anon, authenticated
  USING (
    public.control_plane_claims() ->> 'app_role' = 'developer'
    OR (public.control_plane_claims() ->> 'app_role' = 'shop_admin'
      AND shop_id::text = public.control_plane_claims() ->> 'shop_id')
  );
CREATE POLICY audit_log_developer_append ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (public.control_plane_claims() ->> 'app_role' = 'developer');

COMMIT;
