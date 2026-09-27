-- Poker-only PostgreSQL resources. Safe to rerun; existing data is preserved.
BEGIN;

CREATE TABLE IF NOT EXISTS public.poker_documents (
  collection text NOT NULL CHECK (collection IN ('rooms', 'users')),
  id text NOT NULL,
  value jsonb NOT NULL,
  expires_at bigint NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS poker_documents_expiry
  ON public.poker_documents (expires_at);

ALTER TABLE public.poker_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.poker_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.poker_documents TO service_role;

CREATE OR REPLACE FUNCTION public.poker_get(p_collection text, p_id text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object('revision', revision, 'value', value)
       FROM public.poker_documents
      WHERE collection = p_collection AND id = p_id),
    jsonb_build_object('revision', NULL, 'value', NULL)
  );
$$;

CREATE OR REPLACE FUNCTION public.poker_commit(p_reads jsonb, p_writes jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  r jsonb;
  current_revision uuid;
  lock_key text;
BEGIN
  IF jsonb_typeof(p_reads) <> 'array' OR jsonb_typeof(p_writes) <> 'array'
     OR jsonb_array_length(p_reads) > 64 OR jsonb_array_length(p_writes) > 64 THEN
    RAISE EXCEPTION 'Invalid poker transaction';
  END IF;

  FOR lock_key IN
    SELECT DISTINCT (x->>'collection') || '/' || (x->>'id')
      FROM jsonb_array_elements(p_reads || p_writes) x
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('poker/' || lock_key, 0));
  END LOOP;

  FOR r IN SELECT * FROM jsonb_array_elements(p_reads)
  LOOP
    IF r->>'collection' NOT IN ('rooms', 'users') THEN RAISE EXCEPTION 'Invalid collection'; END IF;
    SELECT revision INTO current_revision
      FROM public.poker_documents
     WHERE collection = r->>'collection' AND id = r->>'id';
    IF current_revision IS DISTINCT FROM (r->>'revision')::uuid THEN RETURN false; END IF;
  END LOOP;

  FOR r IN SELECT * FROM jsonb_array_elements(p_writes)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_reads) x
       WHERE x->>'collection' = r->>'collection' AND x->>'id' = r->>'id'
    ) THEN RAISE EXCEPTION 'Write without read'; END IF;
    IF COALESCE((r->>'delete')::boolean, false) THEN
      DELETE FROM public.poker_documents
       WHERE collection = r->>'collection' AND id = r->>'id';
    ELSE
      INSERT INTO public.poker_documents (collection, id, value, expires_at)
      VALUES (r->>'collection', r->>'id', r->'value', (r->>'expiresAt')::bigint)
      ON CONFLICT (collection, id) DO UPDATE SET
        value = EXCLUDED.value,
        expires_at = EXCLUDED.expires_at,
        revision = gen_random_uuid();
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.poker_cleanup(p_now bigint, p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE deleted integer;
BEGIN
  WITH targets AS (
    SELECT collection, id
      FROM public.poker_documents
     WHERE expires_at <= p_now
     ORDER BY collection, id
     LIMIT LEAST(GREATEST(p_limit, 0), 400)
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.poker_documents d
   USING targets t
   WHERE d.collection = t.collection AND d.id = t.id AND d.expires_at <= p_now;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.poker_get(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.poker_commit(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.poker_cleanup(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.poker_get(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.poker_commit(jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.poker_cleanup(bigint, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
