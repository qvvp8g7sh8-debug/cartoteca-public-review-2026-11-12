// Closed compatibility helpers for the application's bound JSON array batches.
// Clinical records remain encrypted BYTEA; these functions receive request IDs,
// fingerprints and existing plaintext audit metadata, never decrypted patients.
const compatibilityFunctionsSQL = [
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.ascii_lower(source text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
      SELECT translate(source,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
    $fn$`,
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.ascii_upper(source text)
    RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
      SELECT translate(source,'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    $fn$`,
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.sqlite_typeof(source anyelement)
    RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
    DECLARE native_type text := pg_typeof(source)::text;
    BEGIN
      IF source IS NULL THEN RETURN 'null'; END IF;
      IF native_type IN ('smallint','integer','bigint') THEN RETURN 'integer'; END IF;
      IF native_type IN ('real','double precision','numeric') THEN RETURN 'real'; END IF;
      IF native_type IN ('text','character varying','character') THEN RETURN 'text'; END IF;
      IF native_type='bytea' THEN RETURN 'blob'; END IF;
      RAISE EXCEPTION 'Unsupported logical storage class' USING ERRCODE='22023';
    END $fn$`,
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.json_each(source text)
    RETURNS TABLE(key bigint,value text) LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path=pg_catalog AS $fn$
    DECLARE document jsonb;
    BEGIN
      document := source::jsonb;
      IF jsonb_typeof(document) <> 'array' THEN
        RAISE EXCEPTION 'JSON batch must be an array' USING ERRCODE='22023';
      END IF;
      RETURN QUERY SELECT ordinal-1,
        CASE WHEN item='null'::jsonb THEN NULL
          WHEN jsonb_typeof(item)='string' THEN item#>>'{}' ELSE item::text END
        FROM jsonb_array_elements(document) WITH ORDINALITY AS entries(item,ordinal);
    END $fn$`,
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.json_extract(source text,path text)
    RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
    DECLARE document jsonb; selected jsonb;
    BEGIN
      document := source::jsonb;
      IF path ~ '^\\$\\.[A-Za-z_][A-Za-z_0-9]*$' THEN
        selected := document->substring(path FROM 3);
      ELSIF path ~ '^\\$\\[[0-9]+\\]$' THEN
        selected := document->substring(path FROM 3 FOR length(path)-3)::integer;
      ELSE
        RAISE EXCEPTION 'Unsupported JSON batch path' USING ERRCODE='22023';
      END IF;
      IF selected IS NULL OR selected='null'::jsonb THEN RETURN NULL; END IF;
      IF jsonb_typeof(selected) IN ('array','object') THEN RETURN selected::text; END IF;
      IF selected='true'::jsonb THEN RETURN '1'; END IF;
      IF selected='false'::jsonb THEN RETURN '0'; END IF;
      RETURN selected#>>'{}';
    END $fn$`,
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.json_valid(source text)
    RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
    BEGIN
      IF source IS NULL THEN RETURN NULL; END IF;
      -- Syntax validation must not impose JSONB's decoded-NUL/NUMERIC limits.
      PERFORM source::json; RETURN 1;
    EXCEPTION WHEN invalid_text_representation THEN RETURN 0;
    END $fn$`,
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.glob_match(source text,pattern text)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
    DECLARE expression text := '^'; item text; cursor_at integer := 1;
      finish integer; content text;
    BEGIN
      WHILE cursor_at<=length(pattern) LOOP
        item := substring(pattern FROM cursor_at FOR 1);
        IF item='*' THEN expression := expression||'.*';
        ELSIF item='?' THEN expression := expression||'.';
        ELSIF item='[' THEN
          finish := cursor_at+1;
          IF substring(pattern FROM finish FOR 1)='^' THEN finish := finish+1; END IF;
          IF substring(pattern FROM finish FOR 1)=']' THEN finish := finish+1; END IF;
          WHILE finish<=length(pattern) AND substring(pattern FROM finish FOR 1)<>']' LOOP
            finish := finish+1;
          END LOOP;
          IF finish>length(pattern) THEN RETURN false; END IF;
          content := substring(pattern FROM cursor_at+1 FOR finish-cursor_at-1);
          IF strpos(content,E'\\\\')>0 OR strpos(content,'[:')>0 OR strpos(content,'[.')>0 OR strpos(content,'[=')>0 THEN
            RAISE EXCEPTION 'Unsupported GLOB character class' USING ERRCODE='22023';
          END IF;
          expression := expression||'['||content||']'; cursor_at := finish;
        ELSE
          IF strpos(E'.^$+(){}|\\\\',item)>0 THEN expression := expression||E'\\\\'; END IF;
          expression := expression||item;
        END IF;
        cursor_at := cursor_at+1;
      END LOOP;
      RETURN (source COLLATE "C") ~ (expression||'$');
    END $fn$`,
  // SQLite's built-in LIKE folds ASCII only and has no implicit backslash escape.
  `CREATE OR REPLACE FUNCTION cartoteca_catalog.like_match(source text,pattern text)
    RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
      SELECT translate(source,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"
        LIKE translate(pattern,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') ESCAPE ''
    $fn$`,
];
module.exports = { compatibilityFunctionsSQL };
