-- Run as the Neon project owner (avalon_owner) against the direct, non-pooler URL.
-- The SQL-created login role avalon_runtime must already exist. It receives function execution
-- only and never direct access to authoritative documents.
BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avalon_runtime') THEN
    RAISE EXCEPTION 'Required runtime role avalon_runtime does not exist';
  END IF;
  EXECUTE 'ALTER ROLE avalon_runtime NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS';
END
$$;

CREATE TABLE IF NOT EXISTS public.avalon_documents (
  collection text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  value jsonb NOT NULL,
  expires_at bigint NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (collection, id)
);

DELETE FROM public.avalon_documents WHERE collection NOT IN ('rooms', 'users', 'notes');
ALTER TABLE public.avalon_documents
  DROP CONSTRAINT IF EXISTS avalon_documents_collection_check;
ALTER TABLE public.avalon_documents
  ADD CONSTRAINT avalon_documents_collection_check
  CHECK (collection IN ('rooms', 'users', 'notes'));

CREATE INDEX IF NOT EXISTS avalon_documents_expiry
  ON public.avalon_documents (expires_at);

ALTER TABLE public.avalon_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avalon_documents FROM PUBLIC, avalon_runtime;

CREATE OR REPLACE FUNCTION public.avalon_get(p_collection text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_collection NOT IN ('rooms', 'users', 'notes')
     OR length(p_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Invalid document key';
  END IF;
  RETURN COALESCE(
    (SELECT jsonb_build_object('revision', revision, 'value', value)
       FROM public.avalon_documents
      WHERE collection = p_collection AND id = p_id),
    jsonb_build_object('revision', NULL, 'value', NULL)
  );
END
$$;

CREATE OR REPLACE FUNCTION public.avalon_commit(p_reads jsonb, p_writes jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r jsonb;
  current_revision uuid;
  lock_key text;
BEGIN
  IF jsonb_typeof(p_reads) <> 'array'
     OR jsonb_typeof(p_writes) <> 'array'
     OR jsonb_array_length(p_reads) > 64
     OR jsonb_array_length(p_writes) > 64 THEN
    RAISE EXCEPTION 'Invalid transaction';
  END IF;

  FOR r IN SELECT value FROM jsonb_array_elements(p_reads || p_writes)
  LOOP
    IF r->>'collection' NOT IN ('rooms', 'users', 'notes')
       OR length(r->>'id') NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION 'Invalid document key';
    END IF;
  END LOOP;

  -- Missing records need locks too. Sorted advisory locks prevent two creates
  -- from claiming the same four-digit room code and avoid lock-order deadlocks.
  FOR lock_key IN
    SELECT DISTINCT 'avalon/' || (x->>'collection') || '/' || (x->>'id')
      FROM jsonb_array_elements(p_reads || p_writes) x
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(lock_key, 0));
  END LOOP;

  FOR r IN SELECT value FROM jsonb_array_elements(p_reads)
  LOOP
    SELECT revision INTO current_revision
      FROM public.avalon_documents
     WHERE collection = r->>'collection' AND id = r->>'id';
    IF current_revision IS DISTINCT FROM (r->>'revision')::uuid THEN
      RETURN false;
    END IF;
  END LOOP;

  FOR r IN SELECT value FROM jsonb_array_elements(p_writes)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_reads) x
       WHERE x->>'collection' = r->>'collection' AND x->>'id' = r->>'id'
    ) THEN
      RAISE EXCEPTION 'Write without read';
    END IF;
    IF COALESCE((r->>'delete')::boolean, false) THEN
      DELETE FROM public.avalon_documents
       WHERE collection = r->>'collection' AND id = r->>'id';
    ELSE
      IF jsonb_typeof(r->'value') IS NULL OR (r->>'expiresAt')::bigint IS NULL THEN
        RAISE EXCEPTION 'Invalid document write';
      END IF;
      INSERT INTO public.avalon_documents (collection, id, value, expires_at)
      VALUES (r->>'collection', r->>'id', r->'value', (r->>'expiresAt')::bigint)
      ON CONFLICT (collection, id) DO UPDATE SET
        value = EXCLUDED.value,
        expires_at = EXCLUDED.expires_at,
        revision = gen_random_uuid();
    END IF;
  END LOOP;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.avalon_cleanup(p_now bigint, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  deleted integer;
  total integer := 0;
  candidates jsonb;
  lock_key text;
  note_value jsonb;
  room_value jsonb;
  room_code text;
  owner_id text;
  room_expiry bigint;
  same_room boolean;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO candidates
    FROM (
      SELECT collection, id
        FROM public.avalon_documents
       WHERE expires_at <= p_now
       ORDER BY collection, id
       LIMIT LEAST(GREATEST(p_limit, 0), 400)
    ) d;

  -- Notes and their parent room are inspected under the same sorted locks used
  -- by commits, so an active room cannot lose notes during a concurrent renewal.
  FOR lock_key IN
    SELECT key FROM (
      SELECT 'avalon/' || (x->>'collection') || '/' || (x->>'id') AS key
        FROM jsonb_array_elements(candidates) x
      UNION
      SELECT 'avalon/rooms/' || split_part(x->>'id', '_', 1) AS key
        FROM jsonb_array_elements(candidates) x
       WHERE x->>'collection' = 'notes'
    ) keys
    ORDER BY key
  LOOP
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended(lock_key, 0));
  END LOOP;

  FOR r IN
    SELECT * FROM jsonb_to_recordset(candidates) AS x(collection text, id text)
  LOOP
    IF r.collection = 'notes' THEN
      SELECT value INTO note_value
        FROM public.avalon_documents
       WHERE collection = r.collection AND id = r.id AND expires_at <= p_now;
      IF note_value IS NULL THEN
        CONTINUE;
      END IF;

      room_code := split_part(r.id, '_', 1);
      owner_id := substring(r.id FROM length(room_code) + 2);
      SELECT value->'state' INTO room_value
        FROM public.avalon_documents
       WHERE collection = 'rooms' AND id = room_code;
      room_expiry := (room_value->>'expiresAt')::bigint;
      same_room := CASE
        WHEN room_value IS NULL THEN false
        WHEN room_value->>'instanceId' IS NOT NULL THEN
          note_value->>'roomInstanceId' = room_value->>'instanceId'
        WHEN note_value->>'roomInstanceId' IS NOT NULL THEN false
        WHEN note_value->>'roomCreatedAt' IS NOT NULL THEN
          note_value->>'roomCreatedAt' = room_value->>'createdAt'
        ELSE (note_value->>'expiresAt')::bigint > (room_value->>'createdAt')::bigint
      END;

      IF room_expiry > p_now AND same_room AND EXISTS (
        SELECT 1
          FROM jsonb_array_elements(COALESCE(room_value->'players', '[]'::jsonb)) player
         WHERE player->>'userId' = owner_id
      ) THEN
        UPDATE public.avalon_documents SET
          expires_at = room_expiry,
          value = note_value || jsonb_build_object(
            'expiresAt', room_expiry,
            'roomCreatedAt', (room_value->>'createdAt')::bigint
          ) || CASE
            WHEN room_value->>'instanceId' IS NOT NULL
              THEN jsonb_build_object('roomInstanceId', room_value->>'instanceId')
            ELSE '{}'::jsonb
          END,
          revision = gen_random_uuid()
        WHERE collection = r.collection AND id = r.id;
        CONTINUE;
      END IF;
    END IF;

    DELETE FROM public.avalon_documents
     WHERE collection = r.collection AND id = r.id AND expires_at <= p_now;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    total := total + deleted;
  END LOOP;
  RETURN total;
END
$$;

REVOKE ALL ON FUNCTION public.avalon_get(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.avalon_commit(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.avalon_cleanup(bigint, integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO avalon_runtime;
GRANT EXECUTE ON FUNCTION public.avalon_get(text, text) TO avalon_runtime;
GRANT EXECUTE ON FUNCTION public.avalon_commit(jsonb, jsonb) TO avalon_runtime;
GRANT EXECUTE ON FUNCTION public.avalon_cleanup(bigint, integer) TO avalon_runtime;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avalon_app') THEN
    REVOKE ALL ON FUNCTION public.avalon_get(text, text) FROM avalon_app;
    REVOKE ALL ON FUNCTION public.avalon_commit(jsonb, jsonb) FROM avalon_app;
    REVOKE ALL ON FUNCTION public.avalon_cleanup(bigint, integer) FROM avalon_app;
  END IF;
END
$$;

COMMIT;
