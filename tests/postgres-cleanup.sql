-- Run only against the disposable CI database named avalon_test.
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'avalon_test' THEN
    RAISE EXCEPTION 'Use a disposable avalon_test database';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'avalon_runtime') THEN
    CREATE ROLE avalon_runtime LOGIN;
  END IF;
END
$$;

\ir ../migrations/0001_avalon.sql
-- Production deploys reapply migrations, so the schema must remain idempotent.
\ir ../migrations/0001_avalon.sql

BEGIN;
CREATE TEMP TABLE cleanup_results (step text PRIMARY KEY, deleted integer NOT NULL);
GRANT INSERT ON cleanup_results TO avalon_runtime;

INSERT INTO public.avalon_documents (collection, id, value, expires_at) VALUES
  ('rooms', '1000', '{"state":{"instanceId":"a","createdAt":10,"expiresAt":500,"players":[{"userId":"u_1"},{"userId":"u_2"},{"userId":"u_3"}]}}', 500),
  ('notes', '1000_u_1', '{"roomInstanceId":"a","roomCreatedAt":10,"expiresAt":100,"revision":7,"notes":{"player":{"nickname":"private"}}}', 100),
  ('notes', '1000_u_2', '{"roomInstanceId":"old","roomCreatedAt":10,"expiresAt":100,"revision":7,"notes":{"player":{"nickname":"wrong room"}}}', 100),
  ('notes', '1000_u_3', '{"expiresAt":100,"revision":7,"notes":{"player":{"nickname":"old format new room"}}}', 100),
  ('notes', '1000_kicked', '{"roomInstanceId":"a","expiresAt":100,"notes":{}}', 100),
  ('notes', '9999_orphan', '{"roomInstanceId":"a","expiresAt":100,"notes":{}}', 100),
  ('rooms', '2000', '{"state":{"createdAt":10,"expiresAt":500,"players":[{"userId":"legacy"}]}}', 500),
  ('notes', '2000_legacy', '{"expiresAt":100,"revision":2,"notes":{"player":{"text":"retained"}}}', 100),
  ('rooms', '3000', '{"state":{"instanceId":"expired","createdAt":10,"expiresAt":100,"players":[{"userId":"u"}]}}', 100),
  ('notes', '3000_u', '{"roomInstanceId":"expired","expiresAt":100,"notes":{}}', 100);

SET LOCAL ROLE avalon_runtime;
INSERT INTO cleanup_results VALUES ('first', public.avalon_cleanup(200, 400));
RESET ROLE;

DO $$
DECLARE
  deleted integer;
  note jsonb;
BEGIN
  SELECT cleanup_results.deleted INTO deleted FROM cleanup_results WHERE step = 'first';
  IF deleted <> 6 THEN
    RAISE EXCEPTION 'Expected six deleted records, got %', deleted;
  END IF;
  SELECT value INTO note
    FROM public.avalon_documents
   WHERE collection = 'notes' AND id = '1000_u_1';
  IF note IS DISTINCT FROM '{"roomInstanceId":"a","roomCreatedAt":10,"expiresAt":500,"revision":7,"notes":{"player":{"nickname":"private"}}}'::jsonb THEN
    RAISE EXCEPTION 'Active room lost its notes: %', note;
  END IF;
  IF EXISTS (
    SELECT FROM public.avalon_documents
     WHERE collection = 'notes' AND id = '1000_u_1' AND expires_at <> 500
  ) THEN
    RAISE EXCEPTION 'Note expiry was not renewed';
  END IF;
  SELECT value INTO note
    FROM public.avalon_documents
   WHERE collection = 'notes' AND id = '2000_legacy';
  IF note IS DISTINCT FROM '{"expiresAt":500,"revision":2,"roomCreatedAt":10,"notes":{"player":{"text":"retained"}}}'::jsonb THEN
    RAISE EXCEPTION 'Legacy note renewal failed: %', note;
  END IF;
END
$$;

SET LOCAL ROLE avalon_runtime;
INSERT INTO cleanup_results VALUES ('renewed', public.avalon_cleanup(200, 400));
INSERT INTO cleanup_results VALUES ('limited', public.avalon_cleanup(500, 1));
INSERT INTO cleanup_results VALUES ('remaining', public.avalon_cleanup(500, 400));
RESET ROLE;

DO $$
BEGIN
  IF (SELECT deleted FROM cleanup_results WHERE step = 'renewed') <> 0 THEN
    RAISE EXCEPTION 'Renewed records expired too soon';
  END IF;
  IF (SELECT deleted FROM cleanup_results WHERE step = 'limited') <> 1 THEN
    RAISE EXCEPTION 'Cleanup ignored its batch limit';
  END IF;
  IF (SELECT deleted FROM cleanup_results WHERE step = 'remaining') <> 3 THEN
    RAISE EXCEPTION 'Ended rooms and their notes were not removed';
  END IF;
  IF NOT has_function_privilege('avalon_runtime', 'public.avalon_cleanup(bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Runtime role cannot execute cleanup';
  END IF;
  IF has_table_privilege('avalon_runtime', 'public.avalon_documents', 'SELECT') THEN
    RAISE EXCEPTION 'Runtime role can read documents directly';
  END IF;
  IF has_function_privilege('public', 'public.avalon_cleanup(bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Cleanup is available to PUBLIC';
  END IF;
END
$$;
ROLLBACK;
