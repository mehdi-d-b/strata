-- Strata — OEE : arrêts PLANIFIÉS retirés du temps planifié (PPT). Cf. docs/oee-design.md
-- §3 « v2 restant » / §7. La donnée existe déjà : `stop_reason.planned` (posé quand
-- l'opérateur étiquette un arrêt via /api/oee/stops/label, catalogue seedé avec des motifs
-- planifiés 'cleaning'/'break' — cf. 11-oee-stop-events.sql). Ici on la BRANCHE dans le
-- calcul : un arrêt dont le motif EFFECTIF (label opérateur sinon dérivé) est planifié ne
-- doit plus compter comme une perte de Disponibilité, il sort du PPT. En v1 tout arrêt en
-- shift pénalisait la Dispo (assumé « légèrement pessimiste » dans le design doc) ; motifs
-- dérivés seuls ('fault'/'stopped'/'waiting') ne sont jamais `planned` — seul un label
-- opérateur explicite (nettoyage, pause) retire du temps du PPT.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Intervalles d'arrêt exacts + motif effectif — même détection que la route
--    gateway /api/oee/stops (trou entre deux échantillons "en marche" du running_tag,
--    absence de données incluse), factorisée ici en vue pour être réutilisable dans
--    le calcul OEE. Bornée à 35 jours (cohérent avec le max de l'UI OEE, 30 j) pour
--    éviter un scan LAG() non borné sur tout l'historique de `mesures`.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW oee_stop_intervals AS
WITH rt AS (
    SELECT line, running_tag FROM oee_line WHERE enabled AND running_tag IS NOT NULL
),
runs AS (
    SELECT rt.line, m.ts,
           lag(m.ts) OVER (PARTITION BY m.tag ORDER BY m.ts) AS prev_ts
    FROM mesures m JOIN rt ON rt.running_tag = m.tag
    WHERE m.value = 1 AND m.ts > now() - INTERVAL '35 days'
)
SELECT r.line,
       date_trunc('second', r.prev_ts) AS start_ts,
       r.ts                            AS end_ts,
       EXTRACT(EPOCH FROM (r.ts - r.prev_ts)) / 60.0 AS minutes,
       COALESCE(lbl.reason_code, 'stopped') AS reason_code
FROM runs r
LEFT JOIN stop_event_label lbl
       ON lbl.line = r.line AND lbl.start_ts = date_trunc('second', r.prev_ts)
WHERE r.prev_ts IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Minutes d'arrêt PLANIFIÉ (motif effectif `stop_reason.planned`), attribuées
--    au shift (même logique day/shift_no que les autres vues OEE, cf. 09-oee.sql).
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
GROUP BY sa.day, sa.shift_no, si.line;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Redéfinition de oee_by_shift (cf. 09-oee.sql) : le PPT utilisé par la
--    Disponibilité exclut désormais les minutes planifiées. `planned_minutes` reste
--    la durée BRUTE du shift (calendaire — sert aussi à `elapsed_minutes`/projection,
--    qui ne doivent PAS rétrécir avec une pause, sinon un shift semblerait "terminé"
--    avant l'heure) ; `planned_downtime_minutes` (nouveau champ) expose ce qui a été
--    retiré, pour affichage (waterfall/tooltip). Seule la Dispo change de dénominateur.
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
        COALESCE(pd.planned_downtime_minutes, 0) AS planned_downtime_minutes,
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
        -- Dispo : PPT = durée du shift MOINS les arrêts planifiés (nettoyage/pause étiquetés).
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
