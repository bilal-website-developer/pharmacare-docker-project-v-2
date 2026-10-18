BEGIN;

CREATE TABLE public.control_plane_rate_limits (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  locked_until timestamptz
);

ALTER TABLE public.devices ADD COLUMN health_counts jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.control_plane_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.control_plane_rate_limits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.control_plane_rate_limits TO service_role;
CREATE POLICY control_plane_rate_limits_service_only
  ON public.control_plane_rate_limits
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.control_plane_consume_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_lock_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window timestamptz;
  v_attempts integer;
  v_locked_until timestamptz;
BEGIN
  IF p_key_hash !~ '^[a-f0-9]{64}$'
    OR p_limit < 1
    OR p_window_seconds < 1
    OR p_lock_seconds < 1 THEN
    RAISE EXCEPTION 'invalid rate-limit arguments';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.control_plane_rate_limits
    WHERE key_hash = p_key_hash AND locked_until > clock_timestamp()
  ) THEN
    RETURN false;
  END IF;

  v_window := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO public.control_plane_rate_limits (key_hash, window_started_at, attempts, locked_until)
  VALUES (p_key_hash, v_window, 1, NULL)
  ON CONFLICT (key_hash) DO UPDATE
    SET window_started_at = EXCLUDED.window_started_at,
        attempts = CASE
          WHEN public.control_plane_rate_limits.window_started_at = EXCLUDED.window_started_at
            THEN public.control_plane_rate_limits.attempts + 1
          ELSE 1
        END,
        locked_until = CASE
          WHEN public.control_plane_rate_limits.window_started_at = EXCLUDED.window_started_at
            AND public.control_plane_rate_limits.attempts + 1 >= p_limit
            THEN clock_timestamp() + make_interval(secs => p_lock_seconds)
          WHEN EXCLUDED.window_started_at <> public.control_plane_rate_limits.window_started_at
            THEN NULL
          ELSE public.control_plane_rate_limits.locked_until
        END
  RETURNING attempts, locked_until INTO v_attempts, v_locked_until;

  DELETE FROM public.control_plane_rate_limits
  WHERE key_hash <> p_key_hash
    AND window_started_at < clock_timestamp() - make_interval(secs => p_window_seconds * 2)
    AND (locked_until IS NULL OR locked_until <= clock_timestamp());

  RETURN v_attempts < p_limit AND (v_locked_until IS NULL OR v_locked_until <= clock_timestamp());
END
$$;

REVOKE ALL ON FUNCTION public.control_plane_consume_rate_limit(text, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.control_plane_consume_rate_limit(text, integer, integer, integer)
  TO service_role;

COMMIT;
