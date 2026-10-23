-- Run only against the disposable CI database named avalon_test.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'avalon_test' THEN
    RAISE EXCEPTION 'Use a disposable avalon_test database';
  END IF;
END
$$;

\ir ../migrations/0002_conditional_snapshots.sql
-- All migrations are reapplied on deployment, so verify idempotency too.
\ir ../migrations/0002_conditional_snapshots.sql

BEGIN;
SET LOCAL ROLE avalon_runtime;
DO $$
DECLARE
  initial jsonb;
  confirmed jsonb;
  changed jsonb;
  recreated jsonb;
BEGIN
  IF NOT public.avalon_commit('[{"collection":"rooms","id":"cache-fixture","revision":null}]',
    jsonb_build_array(jsonb_build_object('collection','rooms','id','cache-fixture',
      'value',jsonb_build_object('history',repeat('x',600000)),'expiresAt',1000)))
    THEN RAISE EXCEPTION 'Fixture creation failed'; END IF;
  initial := public.avalon_get_cached('rooms','cache-fixture',NULL);
  confirmed := public.avalon_get_cached('rooms','cache-fixture',(initial->>'revision')::uuid);
  IF confirmed->>'unchanged' IS DISTINCT FROM 'true' OR confirmed ? 'value'
     OR octet_length(confirmed::text) > 100
     OR octet_length(initial::text) < 600000
    THEN RAISE EXCEPTION 'Unchanged reads still return full data'; END IF;
  IF public.avalon_get('rooms','cache-fixture') IS DISTINCT FROM initial
    THEN RAISE EXCEPTION 'Legacy read changed'; END IF;
  IF NOT public.avalon_commit(jsonb_build_array(jsonb_build_object('collection','rooms','id','cache-fixture','revision',initial->>'revision')),
    '[{"collection":"rooms","id":"cache-fixture","value":{"updated":true},"expiresAt":2000}]')
    THEN RAISE EXCEPTION 'Fixture update failed'; END IF;
  changed := public.avalon_get_cached('rooms','cache-fixture',(initial->>'revision')::uuid);
  IF changed#>>'{value,updated}' IS DISTINCT FROM 'true' OR changed->>'revision' = initial->>'revision'
    THEN RAISE EXCEPTION 'Cached read missed an update'; END IF;
  IF public.avalon_commit(jsonb_build_array(jsonb_build_object('collection','rooms','id','cache-fixture','revision',initial->>'revision')), '[]')
    THEN RAISE EXCEPTION 'Stale cached revision bypassed transaction validation'; END IF;
  PERFORM public.avalon_commit(jsonb_build_array(jsonb_build_object('collection','rooms','id','cache-fixture','revision',changed->>'revision')),
    '[{"collection":"rooms","id":"cache-fixture","delete":true}]');
  IF public.avalon_get_cached('rooms','cache-fixture',(changed->>'revision')::uuid)->'value' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'Cached read missed deletion'; END IF;
  PERFORM public.avalon_commit('[{"collection":"rooms","id":"cache-fixture","revision":null}]',
    '[{"collection":"rooms","id":"cache-fixture","value":{"recreated":true},"expiresAt":2000}]');
  recreated := public.avalon_get_cached('rooms','cache-fixture',(changed->>'revision')::uuid);
  IF recreated#>>'{value,recreated}' IS DISTINCT FROM 'true' OR recreated->>'revision' = changed->>'revision'
    THEN RAISE EXCEPTION 'Recreated document reused old snapshot'; END IF;
  PERFORM public.avalon_cleanup(2000,400);
  IF public.avalon_get_cached('rooms','cache-fixture',(recreated->>'revision')::uuid)->'value' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'Cleanup deletion did not invalidate cached snapshot'; END IF;

  PERFORM public.avalon_commit('[{"collection":"users","id":"cache-user-a","revision":null},{"collection":"users","id":"cache-user-b","revision":null}]',
    '[{"collection":"users","id":"cache-user-a","value":{"lastRoom":"1234"},"expiresAt":2000},{"collection":"users","id":"cache-user-b","value":{"lastRoom":"5678"},"expiresAt":2000}]');
  initial := public.avalon_get_cached('users','cache-user-a',NULL);
  confirmed := public.avalon_get_cached('users','cache-user-a',(initial->>'revision')::uuid);
  IF confirmed->>'unchanged' IS DISTINCT FROM 'true' OR confirmed ? 'value'
    THEN RAISE EXCEPTION 'User snapshot was not conditionally cached'; END IF;
  changed := public.avalon_get_cached('users','cache-user-b',(initial->>'revision')::uuid);
  IF changed#>>'{value,lastRoom}' IS DISTINCT FROM '5678'
    THEN RAISE EXCEPTION 'User snapshots crossed identity boundary'; END IF;

  BEGIN
    PERFORM public.avalon_get_cached('notes','1234_someone',NULL);
    RAISE EXCEPTION 'Private notes accepted by conditional cache';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Invalid cached document key' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.avalon_get_cached(NULL,'1234',NULL);
    RAISE EXCEPTION 'Null collection accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Invalid cached document key' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.avalon_get_cached('rooms',NULL,NULL);
    RAISE EXCEPTION 'Null ID accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Invalid cached document key' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;
DO $$
BEGIN
  IF has_function_privilege('public', 'public.avalon_get_cached(text,text,uuid)', 'EXECUTE')
    THEN RAISE EXCEPTION 'Public can read cached private snapshots'; END IF;
  IF has_table_privilege('avalon_runtime', 'public.avalon_documents', 'SELECT')
    THEN RAISE EXCEPTION 'Runtime can access authoritative documents directly'; END IF;
END
$$;
ROLLBACK;
