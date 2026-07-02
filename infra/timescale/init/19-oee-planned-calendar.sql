-- Strata — OEE : calendrier d'arrêts planifiés DÉCLARÉS À L'AVANCE (maintenance
-- planifiée, fermeture/congés, etc.). Cf. docs/oee-design.md.
--
-- Différence avec l'étiquetage opérateur (18-oee-planned-downtime.sql) : celui-ci ne
-- corrige l'OEE qu'APRÈS COUP, une fois l'arrêt détecté dans les données. Le calendrier
-- couvre ce que l'étiquetage ne peut pas : un arrêt encore EN COURS (l'OEE affiché doit
-- déjà être correct) ou une fermeture longue où la ligne peut être totalement éteinte
-- (pas de données à étiqueter). Pas de moteur de récurrence : des plages datées
-- explicites suffisent — les petites pauses quotidiennes restent couvertes par
-- l'étiquetage a posteriori (18-oee-planned-downtime.sql), le calendrier vise
-- l'exceptionnel/long/à l'avance.

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Catégorie de motif supplémentaire (fermeture/congés), en plus de maintenance/
--    cleaning/break déjà seedés (11-oee-stop-events.sql).
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO stop_reason (code, label, kind, planned, color) VALUES
    ('shutdown', 'Fermeture / congés', 'downtime', true, '#475569')
ON CONFLICT DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Arrêts planifiés déclarés. `line` NULL = toute l'usine (ex: fermeture congés) ;
--    sinon une ligne précise (ex: maintenance sur une seule ligne).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planned_stop (
    id          TEXT PRIMARY KEY,
    line        TEXT REFERENCES oee_line(line) ON DELETE CASCADE, -- NULL = toute l'usine
    reason_code TEXT NOT NULL REFERENCES stop_reason(code),
    start_ts    TIMESTAMPTZ NOT NULL,
    end_ts      TIMESTAMPTZ NOT NULL,
    note        TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_ts > start_ts)
);

COMMENT ON COLUMN planned_stop.line IS
  'NULL = toute l''usine (ex: fermeture/congés) ; sinon une ligne précise (ex: maintenance).';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Minutes de recouvrement entre les arrêts déclarés et la fenêtre réelle de
--    chaque shift (calendaire — indépendant de tout capteur, contrairement à
--    oee_stop_intervals). Une entrée `line IS NULL` s'applique à toutes les
--    lignes actives (oee_line).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW oee_planned_calendar_by_shift AS
WITH shifts AS (
    SELECT sa.day, sa.shift_no,
           ((sa.day + sa.start_time) AT TIME ZONE 'UTC') AS shift_start,
           ((sa.day + sa.start_time) AT TIME ZONE 'UTC') + (
               CASE WHEN sa.end_time > sa.start_time
                    THEN sa.end_time - sa.start_time
                    ELSE sa.end_time - sa.start_time + INTERVAL '24 hours'
               END
           ) AS shift_end
    FROM shift_active sa
),
lines AS (
    SELECT line FROM oee_line WHERE enabled
)
SELECT sh.day, sh.shift_no, l.line,
       sum(GREATEST(0, EXTRACT(EPOCH FROM (
           LEAST(sh.shift_end, ps.end_ts) - GREATEST(sh.shift_start, ps.start_ts)
       )) / 60.0))::float8 AS planned_calendar_minutes
FROM shifts sh
CROSS JOIN lines l
JOIN planned_stop ps
  ON (ps.line IS NULL OR ps.line = l.line)
 AND ps.start_ts < sh.shift_end
 AND ps.end_ts   > sh.shift_start
GROUP BY sh.day, sh.shift_no, l.line;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Anti-double-comptage : un arrêt étiqueté par l'opérateur qui recouvre un
--    arrêt DÉJÀ déclaré au calendrier ne doit pas être compté deux fois. On
--    redéfinit oee_planned_downtime_by_shift (18-oee-planned-downtime.sql) pour
--    exclure les intervalles couverts par le calendrier.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW oee_planned_downtime_by_shift AS
SELECT sa.day, sa.shift_no, si.line, sum(si.minutes)::float8 AS planned_downtime_minutes
FROM oee_stop_intervals si
JOIN stop_reason sr ON sr.code = si.reason_code AND sr.planned
JOIN shift_active sa
  ON (si.start_ts AT TIME ZONE 'UTC')::date = sa.day
 AND (
        (sa.start_time < sa.end_time
         AND (si.start_ts AT TIME ZONE 'UTC')::time >= sa.start_time
         AND (si.start_ts AT TIME ZONE 'UTC')::time <  sa.end_time)
        OR
        (sa.start_time >= sa.end_time
         AND ((si.start_ts AT TIME ZONE 'UTC')::time >= sa.start_time
              OR (si.start_ts AT TIME ZONE 'UTC')::time <  sa.end_time))
     )
WHERE NOT EXISTS (
    SELECT 1 FROM planned_stop ps
    WHERE (ps.line IS NULL OR ps.line = si.line)
      AND ps.start_ts < si.end_ts AND ps.end_ts > si.start_ts
)
GROUP BY sa.day, sa.shift_no, si.line;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Redéfinition de oee_by_shift (cf. 09-oee.sql, 18-oee-planned-downtime.sql) :
--    planned_downtime_minutes = étiqueté (hors recouvrement calendrier) + calendrier.
-- ───────────────────────────────────────────────────────────────────────────
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
        COALESCE(pd.planned_downtime_minutes, 0) + COALESCE(cal.planned_calendar_minutes, 0)
            AS planned_downtime_minutes,
        t.target_oee,
        t.target_pieces,
        -- temps écoulé du shift, borné à la durée BRUTE planifiée (calendaire) : sert
        -- (a) à une Dispo « shift en cours » juste et (b) à la projection de production.
        -- Volontairement PAS net des arrêts planifiés (une pause ne raccourcit pas le
        -- shift, sinon il semblerait terminé avant l'heure).
        GREATEST(0, LEAST(sd.planned_minutes,
            EXTRACT(EPOCH FROM (now() - ((c.day + sd.start_time) AT TIME ZONE 'UTC'))) / 60.0
        )) AS elapsed_minutes
    FROM counts c
    LEFT JOIN oee_state_by_shift s
      ON s.tag = c.running_tag AND s.day = c.day AND s.shift_no = c.shift_no
    LEFT JOIN oee_target t ON t.line = c.line AND t.enabled
    LEFT JOIN oee_planned_downtime_by_shift pd
      ON pd.line = c.line AND pd.day = c.day AND pd.shift_no = c.shift_no
    LEFT JOIN oee_planned_calendar_by_shift cal
      ON cal.line = c.line AND cal.day = c.day AND cal.shift_no = c.shift_no
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
        run_minutes::float8               AS run_minutes,
        planned_minutes::float8           AS planned_minutes,
        planned_downtime_minutes::float8  AS planned_downtime_minutes,
        elapsed_minutes::float8           AS elapsed_minutes,
        ideal_rate,
        target_oee::float8      AS target_oee,
        target_pieces,
        -- shift EN COURS = du temps s'est écoulé mais le shift n'est pas fini (durée BRUTE).
        (elapsed_minutes > 0 AND elapsed_minutes < planned_minutes) AS is_current,
        -- Dispo : PPT = durée du shift MOINS les arrêts planifiés (étiquetés + calendrier).
        LEAST(1.0, run_minutes / NULLIF(planned_minutes - planned_downtime_minutes, 0))::float8
            AS availability,
        -- Dispo « écoulé » : même correction, sur le temps écoulé (juste pour un shift en cours).
        LEAST(1.0, run_minutes /
            NULLIF(GREATEST(0, elapsed_minutes - planned_downtime_minutes), 0))::float8
            AS availability_elapsed,
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
