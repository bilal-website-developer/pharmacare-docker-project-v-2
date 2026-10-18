\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('shops', 'licences', 'activation_codes', 'devices', 'shop_admins',
                        'support_sessions', 'releases', 'release_rollouts', 'audit_log')) <> 9 THEN
    RAISE EXCEPTION 'expected all nine control-plane tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('shops', 'licences', 'activation_codes', 'devices', 'shop_admins',
                        'support_sessions', 'releases', 'release_rollouts', 'audit_log')
      AND rowsecurity IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'RLS missing from a control-plane table';
  END IF;
  RAISE NOTICE 'PASS: all nine tables have RLS';
END
$$;

INSERT INTO public.shops (id, name, slug, owner_name, phone, city)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Shop A', 'shop-a', 'Owner A', '000', 'City A'),
  ('00000000-0000-0000-0000-000000000002', 'Shop B', 'shop-b', 'Owner B', '111', 'City B');
INSERT INTO public.devices (id, shop_id, device_key_hash, device_name)
VALUES
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001',
   repeat('a', 64), 'A device'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002',
   repeat('b', 64), 'B device');
INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'monthly', now(), now() + interval '1 month', 3),
  ('00000000-0000-0000-0000-000000000002', 'yearly', now(), now() + interval '1 year', 3);
INSERT INTO public.releases (version, bundle_path, sha256, signature)
VALUES ('test-1', 'bundles/test-1.zip', repeat('c', 64), 'test-signature');
INSERT INTO public.activation_codes (shop_id, code_hash, expires_at)
VALUES ('00000000-0000-0000-0000-000000000002', repeat('f', 64), now() + interval '7 days');
INSERT INTO public.shop_admins (shop_id, email, full_name)
VALUES ('00000000-0000-0000-0000-000000000002', 'admin@example.invalid', 'Test Admin');
INSERT INTO public.support_sessions (shop_id, scope, code_hash, expires_at)
VALUES ('00000000-0000-0000-0000-000000000002', 'diagnostics', repeat('1', 64), now() + interval '30 minutes');
INSERT INTO public.release_rollouts (shop_id, release_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM public.releases WHERE version = 'test-1';
INSERT INTO public.audit_log (actor, action, shop_id)
VALUES ('test', 'shop-b-event', '00000000-0000-0000-0000-000000000002');

SET ROLE anon;
DO $$
DECLARE
  visible_rows bigint;
BEGIN
  SELECT sum(row_count) INTO visible_rows FROM (
    SELECT count(*) AS row_count FROM public.shops
    UNION ALL SELECT count(*) FROM public.licences
    UNION ALL SELECT count(*) FROM public.activation_codes
    UNION ALL SELECT count(*) FROM public.devices
    UNION ALL SELECT count(*) FROM public.shop_admins
    UNION ALL SELECT count(*) FROM public.support_sessions
    UNION ALL SELECT count(*) FROM public.releases
    UNION ALL SELECT count(*) FROM public.release_rollouts
    UNION ALL SELECT count(*) FROM public.audit_log
  ) AS visible;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'anon can read % rows', visible_rows;
  END IF;
  RAISE NOTICE 'PASS: anon sees zero rows across all private tables';
END
$$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claims = '{"app_role":"device","shop_id":"00000000-0000-0000-0000-000000000001"}';
DO $$
DECLARE
  visible_rows bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.shops WHERE id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.licences WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.activation_codes WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.devices WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.shop_admins WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.support_sessions WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.release_rollouts WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    + (SELECT count(*) FROM public.audit_log WHERE shop_id = '00000000-0000-0000-0000-000000000002')
    INTO visible_rows;
  IF visible_rows <> 0 THEN
    RAISE EXCEPTION 'shop A device can see % shop B rows', visible_rows;
  END IF;
  RAISE NOTICE 'PASS: shop A device cannot read shop B rows from any shop-scoped table';
END
$$;
DO $$
BEGIN
  INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs)
  VALUES ('00000000-0000-0000-0000-000000000001', 'monthly', now(), now() + interval '1 month', 3);
  RAISE EXCEPTION 'non-developer wrote a licence';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: non-developer cannot write licences';
END
$$;
DO $$
BEGIN
  INSERT INTO public.releases (version, bundle_path, sha256, signature)
  VALUES ('test-unauthorized', 'bundles/unauthorized.zip', repeat('d', 64), 'test-signature');
  RAISE EXCEPTION 'non-developer wrote a release';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: non-developer cannot write releases';
END
$$;
RESET ROLE;

SET ROLE authenticated;
SET request.jwt.claims = '{"app_role":"developer"}';
INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs)
VALUES ('00000000-0000-0000-0000-000000000002', 'yearly', now(), now() + interval '1 year', 3);
INSERT INTO public.releases (version, bundle_path, sha256, signature)
VALUES ('test-authorized', 'bundles/authorized.zip', repeat('e', 64), 'test-signature');
RESET ROLE;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs, offline_grace_days)
    VALUES ('00000000-0000-0000-0000-000000000001', 'monthly', now(), now() + interval '1 month', 3, 0);
    RAISE EXCEPTION 'offline_grace_days accepted 0';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: offline_grace_days rejects 0';
  END;
  BEGIN
    INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs, warning_days)
    VALUES ('00000000-0000-0000-0000-000000000001', 'monthly', now(), now() + interval '1 month', 3, 31);
    RAISE EXCEPTION 'warning_days accepted 31';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: warning_days rejects 31';
  END;
  BEGIN
    INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs, renewal_notice_days)
    VALUES ('00000000-0000-0000-0000-000000000001', 'monthly', now(), now() + interval '1 month', 3, 31);
    RAISE EXCEPTION 'renewal_notice_days accepted 31';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: renewal_notice_days rejects 31';
  END;
  BEGIN
    INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs)
    VALUES ('00000000-0000-0000-0000-000000000001', 'monthly', now(), NULL, 3);
    RAISE EXCEPTION 'monthly plan accepted no expiry';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: monthly plan requires expiry';
  END;
  BEGIN
    INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs)
    VALUES ('00000000-0000-0000-0000-000000000001', 'yearly', now(), now(), 3);
    RAISE EXCEPTION 'expiry equal to start accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: expiry must follow start';
  END;
  BEGIN
    INSERT INTO public.licences (shop_id, plan_type, starts_at, expires_at, max_pcs)
    VALUES ('00000000-0000-0000-0000-000000000001', 'one_time', now(), now() + interval '1 year', 3);
    RAISE EXCEPTION 'one_time plan accepted an expiry';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: one_time plan has no expiry';
  END;
END
$$;

INSERT INTO public.audit_log (actor, action, shop_id) VALUES ('test', 'append', NULL);
DO $$
BEGIN
  BEGIN
    UPDATE public.audit_log SET action = 'mutated';
    RAISE EXCEPTION 'audit_log update succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'audit_log is append-only' THEN
      RAISE;
    END IF;
    RAISE NOTICE 'PASS: audit_log rejects updates';
  END;
  BEGIN
    DELETE FROM public.audit_log;
    RAISE EXCEPTION 'audit_log delete succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'audit_log is append-only' THEN
      RAISE;
    END IF;
    RAISE NOTICE 'PASS: audit_log rejects deletes';
  END;
END
$$;
