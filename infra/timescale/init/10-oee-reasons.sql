-- Strata — OEE : motifs d'arrêt (Pareto des pertes). Cf. docs/oee-design.md.
--
-- v1 : motifs DÉRIVÉS des signaux (pas de saisie opérateur) —
--   - running_tag (état) : code 0 = Arrêt, code 2 = Panne/Défaut  → pertes de DISPO
--   - waiting_tag (en_attente) : valeur 1 = Attente amont          → perte de PERF
-- Approche bucket 15 min (cohérente avec l'ETL OEE) ; granularité 15 min, pas de
-- détection d'intervalle fine (évolution v2 : codes motif PLC, saisie opérateur,
-- durées exactes). Note : oee_reason_buckets recoupe oee_state_buckets — on
-- pourra les fusionner plus tard (n0/n1/n2 dans un seul agrégat).

-- 0. Signal "tourne mais n'avance pas" (perte de perf), optionnel, par ligne.
ALTER TABLE oee_line ADD COLUMN IF NOT EXISTS waiting_tag TEXT;

-- 1. Catalogue de motifs (label / type / couleur). Configurable.
CREATE TABLE IF NOT EXISTS stop_reason (
    code    TEXT PRIMARY KEY,
    label   TEXT NOT NULL,
    kind    TEXT NOT NULL CHECK (kind IN ('downtime', 'performance')),
    planned BOOLEAN NOT NULL DEFAULT FALSE,
    color   TEXT
);

INSERT INTO stop_reason (code, label, kind, planned, color) VALUES
    ('fault',   'Panne / Défaut',  'downtime',    false, '#dc2626'),
    ('stopped', 'Arrêt',           'downtime',    false, '#6b7280'),
    ('waiting', 'Attente amont',   'performance', false, '#d97706')
ON CONFLICT DO NOTHING;

-- 2. Distribution des valeurs d'état par tag et tranche de 15 min.
--    n0/n1/n2 = nb d'échantillons à la valeur 0/1/2 (couvre état 0/1/2 et booléens).
CREATE MATERIALIZED VIEW IF NOT EXISTS oee_reason_buckets
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('15 minutes', ts)     AS bucket,
    tag,
    count(*)                          AS samples,
    count(*) FILTER (WHERE value = 0) AS n0,
    count(*) FILTER (WHERE value = 1) AS n1,
    count(*) FILTER (WHERE value = 2) AS n2
FROM mesures
GROUP BY bucket, tag
WITH NO DATA;

SELECT add_continuous_aggregate_policy('oee_reason_buckets',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists     => TRUE);

-- 3. Minutes par motif, attribuées au shift (long form : 1 ligne par motif).
DROP VIEW IF EXISTS oee_downtime_by_shift;
CREATE VIEW oee_downtime_by_shift AS
WITH reason_minutes AS (
    -- Arrêt (état = 0) depuis le running_tag.
    SELECT ol.line, rb.bucket, 'stopped'::text AS reason,
           (rb.n0::numeric / NULLIF(rb.samples, 0)) * 15 AS minutes
    FROM oee_line ol JOIN oee_reason_buckets rb ON rb.tag = ol.running_tag
    WHERE ol.enabled
    UNION ALL
    -- Panne/Défaut (état = 2) depuis le running_tag.
    SELECT ol.line, rb.bucket, 'fault',
           (rb.n2::numeric / NULLIF(rb.samples, 0)) * 15
    FROM oee_line ol JOIN oee_reason_buckets rb ON rb.tag = ol.running_tag
    WHERE ol.enabled
    UNION ALL
    -- Attente amont (waiting_tag = 1).
    SELECT ol.line, rb.bucket, 'waiting',
           (rb.n1::numeric / NULLIF(rb.samples, 0)) * 15
    FROM oee_line ol JOIN oee_reason_buckets rb ON rb.tag = ol.waiting_tag
    WHERE ol.enabled AND ol.waiting_tag IS NOT NULL
),
attributed AS (
    SELECT rm.line, sa.day, sa.shift_no, rm.reason, sum(rm.minutes) AS minutes
    FROM reason_minutes rm
    JOIN shift_active sa
      ON (rm.bucket AT TIME ZONE 'UTC')::date = sa.day
     AND (
            (sa.start_time < sa.end_time
             AND (rm.bucket AT TIME ZONE 'UTC')::time >= sa.start_time
             AND (rm.bucket AT TIME ZONE 'UTC')::time <  sa.end_time)
            OR
            (sa.start_time >= sa.end_time
             AND ((rm.bucket AT TIME ZONE 'UTC')::time >= sa.start_time
                  OR (rm.bucket AT TIME ZONE 'UTC')::time <  sa.end_time))
         )
    GROUP BY rm.line, sa.day, sa.shift_no, rm.reason
)
SELECT
    a.line, a.day, a.shift_no,
    a.reason       AS reason_code,
    sr.label       AS reason_label,
    sr.kind, sr.color,
    a.minutes::float8 AS minutes
FROM attributed a
JOIN stop_reason sr ON sr.code = a.reason
WHERE a.minutes > 0.01;

-- 4. Démo : waiting_tag des 2 lignes = l'en_attente de l'embouteilleuse.
UPDATE oee_line SET waiting_tag = line || '.embouteilleuse.en_attente'
WHERE line IN ('brasserie.blonde', 'brasserie.ipa') AND waiting_tag IS NULL;
