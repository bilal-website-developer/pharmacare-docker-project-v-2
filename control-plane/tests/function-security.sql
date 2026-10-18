\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'control_plane_rate_limits') IS NOT TRUE THEN
    RAISE EXCEPTION 'rate-limit table is missing RLS';
  END IF;
  IF has_table_privilege('anon', 'public.control_plane_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read the rate-limit table';
  END IF;
  IF has_function_privilege('anon',
      'public.control_plane_consume_rate_limit(text,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call the rate-limit function';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.control_plane_consume_rate_limit(text,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot call the rate-limit function';
  END IF;
  RAISE NOTICE 'PASS: rate-limit state is private and service-role scoped';
END
$$;

SET ROLE service_role;
DO $$
DECLARE
  first_attempt boolean;
  second_attempt boolean;
  locked_attempt boolean;
BEGIN
  first_attempt := public.control_plane_consume_rate_limit(repeat('a', 64), 3, 3600, 3600);
  second_attempt := public.control_plane_consume_rate_limit(repeat('a', 64), 3, 3600, 3600);
  locked_attempt := public.control_plane_consume_rate_limit(repeat('a', 64), 3, 3600, 3600);
  IF NOT first_attempt OR NOT second_attempt OR locked_attempt THEN
    RAISE EXCEPTION 'rate limit did not allow two attempts then lock the third';
  END IF;
  IF public.control_plane_consume_rate_limit(repeat('a', 64), 3, 3600, 3600) THEN
    RAISE EXCEPTION 'rate limit allowed a request during the lockout';
  END IF;
  RAISE NOTICE 'PASS: rate limit enforces threshold and persistent lockout';
END
$$;
RESET ROLE;
