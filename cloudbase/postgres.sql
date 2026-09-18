-- PG environments only. Safe to rerun; does not replace or clear existing records.
BEGIN;
CREATE TABLE IF NOT EXISTS public.avalon_documents (
  collection text NOT NULL CHECK (collection IN ('rooms', 'users', 'notes', 'oauth')),
  id text NOT NULL,
  value jsonb NOT NULL,
  expires_at bigint NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS avalon_documents_expiry ON public.avalon_documents (expires_at);
ALTER TABLE public.avalon_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.avalon_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.avalon_documents TO service_role;

CREATE OR REPLACE FUNCTION public.avalon_get(p_collection text, p_id text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object('revision', revision, 'value', value)
     FROM public.avalon_documents WHERE collection = p_collection AND id = p_id),
    jsonb_build_object('revision', NULL, 'value', NULL)
  );
$$;

CREATE OR REPLACE FUNCTION public.avalon_commit(p_reads jsonb, p_writes jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE r jsonb; current_revision uuid; lock_key text;
BEGIN
  IF jsonb_typeof(p_reads) <> 'array' OR jsonb_typeof(p_writes) <> 'array'
     OR jsonb_array_length(p_reads) > 64 OR jsonb_array_length(p_writes) > 64 THEN
    RAISE EXCEPTION 'Invalid transaction';
  END IF;
  -- Lock missing records too; sorted advisory locks prevent concurrent inserts
  -- and protect all revisions until the entire commit completes.
  FOR lock_key IN
    SELECT DISTINCT (x->>'collection') || '/' || (x->>'id')
    FROM jsonb_array_elements(p_reads || p_writes) x ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_reads) LOOP
    SELECT revision INTO current_revision FROM public.avalon_documents
      WHERE collection = r->>'collection' AND id = r->>'id';
    IF current_revision IS DISTINCT FROM (r->>'revision')::uuid THEN RETURN false; END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_writes) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_reads) x
      WHERE x->>'collection' = r->>'collection' AND x->>'id' = r->>'id') THEN
      RAISE EXCEPTION 'Write without read';
    END IF;
    IF COALESCE((r->>'delete')::boolean, false) THEN
      DELETE FROM public.avalon_documents WHERE collection = r->>'collection' AND id = r->>'id';
    ELSE
      INSERT INTO public.avalon_documents (collection, id, value, expires_at)
      VALUES (r->>'collection', r->>'id', r->'value', (r->>'expiresAt')::bigint)
      ON CONFLICT (collection, id) DO UPDATE SET
        value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, revision = gen_random_uuid();
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.avalon_cleanup(p_now bigint, p_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE r record; deleted integer; total integer := 0;
  candidates jsonb; lock_key text; note_value jsonb; room_value jsonb;
  room_code text; owner_id text; room_expiry bigint; same_room boolean;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO candidates
  FROM (SELECT collection, id FROM public.avalon_documents
    WHERE expires_at <= p_now ORDER BY collection, id
    LIMIT LEAST(GREATEST(p_limit, 0), 400)) d;

  -- Read a note and its parent room under the same sorted locks as commits.
  -- Acquire every key first: locking a room inside the loop could deadlock
  -- with another transaction that changes multiple notes and rooms.
  FOR lock_key IN
    SELECT key FROM (
      SELECT (x->>'collection') || '/' || (x->>'id') AS key
        FROM jsonb_array_elements(candidates) x
      UNION
      SELECT 'rooms/' || split_part(x->>'id', '_', 1) AS key
        FROM jsonb_array_elements(candidates) x WHERE x->>'collection' = 'notes'
    ) keys ORDER BY key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;

  FOR r IN SELECT * FROM jsonb_to_recordset(candidates) AS x(collection text, id text)
  LOOP
    IF r.collection = 'notes' THEN
      SELECT value INTO note_value FROM public.avalon_documents
        WHERE collection = r.collection AND id = r.id AND expires_at <= p_now;
      IF note_value IS NULL THEN CONTINUE; END IF;
      room_code := split_part(r.id, '_', 1);
      owner_id := substring(r.id FROM length(room_code) + 2);
      SELECT value->'state' INTO room_value FROM public.avalon_documents
        WHERE collection = 'rooms' AND id = room_code;
      room_expiry := (room_value->>'expiresAt')::bigint;
      -- New rooms have an immutable instance ID. Legacy rooms keep their
      -- timestamp fallback until they expire; old notes cannot cross into a
      -- newly created room that happens to reuse the same four-digit code.
      same_room := CASE
        WHEN room_value->>'instanceId' IS NOT NULL THEN
          note_value->>'roomInstanceId' = room_value->>'instanceId'
        WHEN note_value->>'roomInstanceId' IS NOT NULL THEN false
        WHEN note_value->>'roomCreatedAt' IS NOT NULL THEN
          note_value->>'roomCreatedAt' = room_value->>'createdAt'
        ELSE (note_value->>'expiresAt')::bigint > (room_value->>'createdAt')::bigint
      END;
      IF room_expiry > p_now AND same_room AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(room_value->'players') player
          WHERE player->>'userId' = owner_id
      ) THEN
        UPDATE public.avalon_documents SET
          expires_at = room_expiry,
          value = note_value || jsonb_build_object(
            'expiresAt', room_expiry, 'roomCreatedAt', (room_value->>'createdAt')::bigint
          ) || CASE WHEN room_value->>'instanceId' IS NOT NULL
            THEN jsonb_build_object('roomInstanceId', room_value->>'instanceId')
            ELSE '{}'::jsonb END,
          revision = gen_random_uuid()
          WHERE collection = r.collection AND id = r.id;
        CONTINUE;
      END IF;
    END IF;
    DELETE FROM public.avalon_documents WHERE collection = r.collection AND id = r.id
      AND expires_at <= p_now;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    total := total + deleted;
  END LOOP;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION public.avalon_get(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.avalon_commit(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.avalon_cleanup(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.avalon_get(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.avalon_commit(jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.avalon_cleanup(bigint, integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
