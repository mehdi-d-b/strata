-- Strata — modèle production / shift (Phase 3, "SAP-lite").
--
-- Objectif : compter la production par shift, en gérant DEUX choses que les
-- systèmes naïfs ratent :
--   1. Les shifts qui ÉVOLUENT dans le temps (2->3 shifts, horaires qui changent)
--      -> planning VERSIONNÉ par `valid_from`.
--   2. Les compteurs PLC qui se REMETTENT À ZÉRO (coupure, minuit, rollover)
--      -> delta par bucket = max - min, le saut négatif d'un reset n'est pas compté.
--
-- Philosophie ETL : le pré-calcul lourd (deltas par tranche de 15 min) tourne en
-- continu dans un continuous aggregate. L'attribution au shift (qui dépend de la
-- config versionnée) se fait à la LECTURE, par jointure légère sur des lignes déjà
-- agrégées — jamais de recalcul du brut à l'ouverture d'une page.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Rôles de compteurs : quel tag représente quoi (le "mode SAP" raisonnable).
--    Un petit ensemble de rôles fixes plutôt qu'une ontologie infinie.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tag_role (
    tag_name TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
    role     TEXT NOT NULL CHECK (role IN ('produced', 'ok', 'scrap', 'available')),
    PRIMARY KEY (tag_name, role)
);

COMMENT ON TABLE tag_role IS
  'Mappe un tag compteur à un rôle de production. produced=total, ok=bonnes, scrap=rebut, available=dispo.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Planning de shifts VERSIONNÉ. Chaque version a une date d'effet.
--    Pour une date donnée, la version active = le plus grand valid_from <= date.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_schedule (
    valid_from DATE NOT NULL,           -- à partir de quand cette ligne s'applique
    shift_no   INT  NOT NULL,           -- 1, 2, 3…
    label      TEXT,                    -- "Matin", "Après-midi", "Nuit"
    start_time TIME NOT NULL,           -- début (heure locale)
    end_time   TIME NOT NULL,           -- fin ; si <= start_time, le shift passe minuit
    PRIMARY KEY (valid_from, shift_no)
);

COMMENT ON TABLE shift_schedule IS
  'Planning de shifts versionné. Changer de config = insérer des lignes avec un nouveau valid_from.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Continuous aggregate : production brute par tag et par tranche de 15 min.
--    delta = max - min sur le bucket (gère les compteurs cumulatifs + resets).
-- ───────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS prod_buckets
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('15 minutes', ts) AS bucket,
    tag,
    max(value) - min(value)       AS delta,
    max(value)                    AS last_value,
    count(*)                      AS samples
FROM mesures
GROUP BY bucket, tag
WITH NO DATA;

-- Rafraîchissement automatique en tâche de fond (l'ETL "transparent").
SELECT add_continuous_aggregate_policy('prod_buckets',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists     => TRUE);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Vue : version de planning active pour chaque date présente dans les données.
--    (LATERAL = pour chaque jour, prend la config dont le valid_from est le plus
--    récent sans dépasser ce jour.)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW shift_active AS
SELECT d.day, s.shift_no, s.label, s.start_time, s.end_time
FROM (
    SELECT DISTINCT (bucket AT TIME ZONE 'UTC')::date AS day FROM prod_buckets
) d
CROSS JOIN LATERAL (
    SELECT ss.*
    FROM shift_schedule ss
    WHERE ss.valid_from <= d.day
      AND ss.valid_from = (
          SELECT max(valid_from) FROM shift_schedule WHERE valid_from <= d.day
      )
) s;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Vue : chaque bucket attribué à son shift (selon la version active ce jour-là).
--    Gère les shifts qui passent minuit (end_time <= start_time).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW prod_by_shift AS
SELECT
    sa.day,
    sa.shift_no,
    sa.label       AS shift_label,
    pb.tag,
    sum(pb.delta)  AS pieces
FROM prod_buckets pb
JOIN shift_active sa
  ON (pb.bucket AT TIME ZONE 'UTC')::date = sa.day
 AND (
        -- shift dans la journée : [start, end)
        (sa.start_time < sa.end_time
         AND (pb.bucket AT TIME ZONE 'UTC')::time >= sa.start_time
         AND (pb.bucket AT TIME ZONE 'UTC')::time <  sa.end_time)
        OR
        -- shift à cheval sur minuit : [start, 24h) U [0, end)
        (sa.start_time >= sa.end_time
         AND ((pb.bucket AT TIME ZONE 'UTC')::time >= sa.start_time
              OR (pb.bucket AT TIME ZONE 'UTC')::time < sa.end_time))
     )
GROUP BY sa.day, sa.shift_no, sa.label, pb.tag;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Vue : production par shift agrégée PAR RÔLE (ok / scrap / …) + taux de rebut.
--    C'est la vue que le dashboard consommera.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW prod_by_shift_role AS
SELECT
    pbs.day,
    pbs.shift_no,
    pbs.shift_label,
    sum(pbs.pieces) FILTER (WHERE tr.role = 'ok')        AS ok,
    sum(pbs.pieces) FILTER (WHERE tr.role = 'scrap')     AS scrap,
    sum(pbs.pieces) FILTER (WHERE tr.role = 'produced')  AS produced,
    sum(pbs.pieces) FILTER (WHERE tr.role = 'available') AS available
FROM prod_by_shift pbs
JOIN tag_role tr ON tr.tag_name = pbs.tag
GROUP BY pbs.day, pbs.shift_no, pbs.shift_label;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Données de démo : un planning 2 shifts + mapping des rôles du simulateur.
--    (Sans effet si les lignes existent déjà.)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO shift_schedule (valid_from, shift_no, label, start_time, end_time) VALUES
    ('2026-01-01', 1, 'Jour', '06:00', '18:00'),
    ('2026-01-01', 2, 'Nuit', '18:00', '06:00')
ON CONFLICT DO NOTHING;
