-- Strata — OEE (Disponibilité × Performance × Qualité). Conception : docs/oee-design.md.
--
-- Réutilise prod_buckets / prod_by_shift / shift_active / shift_schedule (03-production).
-- Ajoute :
--   - oee_line          : config par ligne (cadence nominale + tag de marche)
--   - oee_state_buckets : continuous aggregate des minutes de marche (tag d'état)
--   - oee_state_by_shift / oee_by_shift : A, P, Q, OEE par ligne × shift
--
-- Binding (cf. doc §1) : STANDARD SÉMANTIQUE + liaison en CONFIG. Le tag de marche
-- suit la convention canonique « valeur = 1 quand en marche » (normaliser au bord
-- si la source diffère). produced/ok viennent des rôles existants (tag_role).

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Config OEE par ligne.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oee_line (
    line        TEXT PRIMARY KEY,          -- préfixe métier, ex: brasserie.blonde
    label       TEXT,
    ideal_rate  DOUBLE PRECISION NOT NULL, -- cadence nominale, pièces/min à pleine vitesse
    running_tag TEXT,                      -- tag d'état (canonique : 1 = en marche)
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN oee_line.running_tag IS
  'Tag d''état marche/arrêt. Convention canonique : valeur = 1 quand la machine tourne (0/2/autre = arrêt/défaut). Normaliser au bord si la source diffère.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Minutes de marche par tag d'état et tranche de 15 min (ETL en continu).
--    running_samples / samples * 15 = minutes de marche dans le bucket.
-- ───────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS oee_state_buckets
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('15 minutes', ts)     AS bucket,
    tag,
    count(*)                          AS samples,
    count(*) FILTER (WHERE value = 1) AS running_samples
FROM mesures
GROUP BY bucket, tag
WITH NO DATA;

SELECT add_continuous_aggregate_policy('oee_state_buckets',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists     => TRUE);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Minutes de marche attribuées au shift (même logique que prod_by_shift,
--    gère les shifts à cheval sur minuit).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW oee_state_by_shift AS
SELECT
    sa.day,
    sa.shift_no,
    sb.tag,
    sum((sb.running_samples::numeric / NULLIF(sb.samples, 0)) * 15) AS run_minutes
FROM oee_state_buckets sb
JOIN shift_active sa
  ON (sb.bucket AT TIME ZONE 'UTC')::date = sa.day
 AND (
        (sa.start_time < sa.end_time
         AND (sb.bucket AT TIME ZONE 'UTC')::time >= sa.start_time
         AND (sb.bucket AT TIME ZONE 'UTC')::time <  sa.end_time)
        OR
        (sa.start_time >= sa.end_time
         AND ((sb.bucket AT TIME ZONE 'UTC')::time >= sa.start_time
              OR (sb.bucket AT TIME ZONE 'UTC')::time <  sa.end_time))
     )
GROUP BY sa.day, sa.shift_no, sb.tag;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. OEE par ligne × shift. A, P, Q (avec gardes anti div/0, plafonnés à 1).
--    produced = rôle 'produced' si présent, sinon ok+scrap.
-- ───────────────────────────────────────────────────────────────────────────
-- DROP+CREATE (et non CREATE OR REPLACE) : on change le type des colonnes (float8).
DROP VIEW IF EXISTS oee_by_shift;
CREATE VIEW oee_by_shift AS
WITH counts AS (
    SELECT
        ol.line,
        ol.label       AS line_label,
        ol.ideal_rate,
        ol.running_tag,
        pbs.day,
        pbs.shift_no,
        pbs.shift_label,
        sum(pbs.pieces) FILTER (WHERE tr.role = 'ok') AS ok,
        COALESCE(
            sum(pbs.pieces) FILTER (WHERE tr.role = 'produced'),
            sum(pbs.pieces) FILTER (WHERE tr.role IN ('ok', 'scrap'))
        ) AS produced
    FROM oee_line ol
    JOIN prod_by_shift pbs ON pbs.tag LIKE ol.line || '.%'
    JOIN tag_role     tr  ON tr.tag_name = pbs.tag
    WHERE ol.enabled
    GROUP BY ol.line, ol.label, ol.ideal_rate, ol.running_tag,
             pbs.day, pbs.shift_no, pbs.shift_label
),
joined AS (
    SELECT
        c.*,
        s.run_minutes,
        sd.planned_minutes
    FROM counts c
    LEFT JOIN oee_state_by_shift s
      ON s.tag = c.running_tag AND s.day = c.day AND s.shift_no = c.shift_no
    LEFT JOIN LATERAL (
        SELECT EXTRACT(EPOCH FROM
                 CASE WHEN sh.end_time > sh.start_time
                      THEN sh.end_time - sh.start_time
                      ELSE sh.end_time - sh.start_time + INTERVAL '24 hours'
                 END) / 60.0 AS planned_minutes
        FROM shift_active sh
        WHERE sh.day = c.day AND sh.shift_no = c.shift_no
        LIMIT 1
    ) sd ON true
),
factors AS (
    -- Cast en float8 : node-postgres sérialise `numeric` en string ; on veut des
    -- nombres JSON cohérents pour le front (cf. notice docs/oee-design.md §8).
    SELECT
        line, line_label, day, shift_no, shift_label,
        ok, produced,
        run_minutes::float8     AS run_minutes,
        planned_minutes::float8 AS planned_minutes,
        ideal_rate,
        LEAST(1.0, run_minutes / NULLIF(planned_minutes, 0))::float8          AS availability,
        LEAST(1.0, produced    / NULLIF(run_minutes * ideal_rate, 0))::float8 AS performance,
        (ok::numeric / NULLIF(produced, 0))::float8                           AS quality
    FROM joined
)
SELECT
    *,
    (availability * performance * quality)::float8 AS oee
FROM factors;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Démo : config OEE des 2 lignes du simulateur (cadence nominale 50/min,
--    tag d'état = celui de l'embouteilleuse). Sans effet si déjà présent.
--    (Les rôles ok/scrap des compteurs .bouteilles_ok/_rebut sont auto-assignés par
--     la gateway à la découverte du tag — seedDemoRole ; cf. gateway/src/index.ts.)
-- ───────────────────────────────────────────────────────────────────────────
-- Cadences nominales = celles du simulateur (brain.py : blonde 50/min, ipa 40/min).
INSERT INTO oee_line (line, label, ideal_rate, running_tag) VALUES
    ('brasserie.blonde', 'Ligne Blonde', 50, 'brasserie.blonde.embouteilleuse.state'),
    ('brasserie.ipa',    'Ligne IPA',    40, 'brasserie.ipa.embouteilleuse.state')
ON CONFLICT DO NOTHING;
