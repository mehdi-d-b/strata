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
-- 1b. Objectifs par ligne (cible OEE + objectif de pièces par shift). Servent
--     au suivi actuel/cible + à la projection « à l'allure actuelle » (cf. vue).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oee_target (
    line          TEXT PRIMARY KEY REFERENCES oee_line(line) ON DELETE CASCADE,
    target_oee    DOUBLE PRECISION,   -- cible OEE (0..1), optionnel
    target_pieces INTEGER,            -- objectif de pièces par shift, optionnel
    enabled       BOOLEAN NOT NULL DEFAULT TRUE
);

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
        sd.planned_minutes,
        t.target_oee,
        t.target_pieces,
        -- temps écoulé du shift, borné à la durée planifiée : sert (a) à une Dispo
        -- « shift en cours » juste (vs heures déjà passées, pas vs 12 h entières) et
        -- (b) à la projection de production.
        GREATEST(0, LEAST(sd.planned_minutes,
            EXTRACT(EPOCH FROM (now() - ((c.day + sd.start_time) AT TIME ZONE 'UTC'))) / 60.0
        )) AS elapsed_minutes
    FROM counts c
    LEFT JOIN oee_state_by_shift s
      ON s.tag = c.running_tag AND s.day = c.day AND s.shift_no = c.shift_no
    LEFT JOIN oee_target t ON t.line = c.line AND t.enabled
    LEFT JOIN LATERAL (
        SELECT sh.start_time,
               EXTRACT(EPOCH FROM
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
        elapsed_minutes::float8 AS elapsed_minutes,
        ideal_rate,
        target_oee::float8      AS target_oee,
        target_pieces,
        -- shift EN COURS = du temps s'est écoulé mais le shift n'est pas fini.
        (elapsed_minutes > 0 AND elapsed_minutes < planned_minutes) AS is_current,
        LEAST(1.0, run_minutes / NULLIF(planned_minutes, 0))::float8          AS availability,
        -- Dispo « écoulé » : run_minutes vs temps écoulé (juste pour un shift en cours).
        LEAST(1.0, run_minutes / NULLIF(elapsed_minutes, 0))::float8          AS availability_elapsed,
        LEAST(1.0, produced    / NULLIF(run_minutes * ideal_rate, 0))::float8 AS performance,
        (ok::numeric / NULLIF(produced, 0))::float8                           AS quality,
        -- projection de prod en fin de shift (extrapolation au prorata du temps
        -- écoulé ; = produced si le shift est terminé).
        CASE WHEN elapsed_minutes > 0 AND elapsed_minutes < planned_minutes
             THEN round(produced * planned_minutes / NULLIF(elapsed_minutes, 0))::bigint
             ELSE produced END                                                AS projected_pieces,
        (produced::float8 / NULLIF(target_pieces, 0))::float8                 AS pieces_ratio
    FROM joined
)
SELECT
    *,
    (availability * performance * quality)::float8 AS oee,
    CASE WHEN target_pieces IS NULL THEN NULL
         ELSE projected_pieces >= target_pieces END AS on_track
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

-- Objectifs de démo : cible OEE 80 %, objectif de pièces par shift (ordre de
-- grandeur d'un bon shift du sim ; blonde plus rapide que l'ipa).
INSERT INTO oee_target (line, target_oee, target_pieces) VALUES
    ('brasserie.blonde', 0.80, 30000),
    ('brasserie.ipa',    0.80, 24000)
ON CONFLICT DO NOTHING;
