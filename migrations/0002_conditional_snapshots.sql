-- Keep avalon_get available for rolling deployments and uncached private notes.
-- A payload can only be reused after this query confirms its exact UUID revision.
BEGIN;

CREATE OR REPLACE FUNCTION public.avalon_get_cached(p_collection text, p_id text, p_revision uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_collection IS NULL OR p_collection NOT IN ('rooms', 'users')
     OR p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'Invalid cached document key';
  END IF;
  -- Preserve avalon_get expiry semantics: the API checks room expiry using its
  -- current clock even when the revision is unchanged. Transactions must still
  -- observe expired records until cleanup deletes them, to validate their reads.
  RETURN COALESCE(
    (SELECT CASE WHEN revision = p_revision
       THEN jsonb_build_object('revision', revision, 'unchanged', true)
       ELSE jsonb_build_object('revision', revision, 'value', value)
     END FROM public.avalon_documents WHERE collection = p_collection AND id = p_id),
    jsonb_build_object('revision', NULL, 'value', NULL)
  );
END
$$;

REVOKE ALL ON FUNCTION public.avalon_get_cached(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.avalon_get_cached(text, text, uuid) TO avalon_runtime;

COMMIT;
