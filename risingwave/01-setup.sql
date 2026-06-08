-- Strata — RisingWave : détection d'anomalie temps réel (premier cas d'usage).
--
-- Chaîne : tags.raw (Redpanda) -> source -> MV z-score glissant -> sink tags.derived.
-- Les anomalies réémises sont consommées par la gateway, qui les insère dans
-- `alarms` avec source='derived' (le modèle d'alarme est déjà prévu pour ça).
--
-- Appliquer :  docker compose exec -T risingwave psql -h 127.0.0.1 -p 4566 -d dev -U root < risingwave/01-setup.sql
-- (ou via le client psql sur localhost:4566, base `dev`, user `root` sans mot de passe)

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Source : lit le topic Redpanda tags.raw (JSON du contrat Strata).
-- ─────────────────────────────────────────────────────────────────────────
CREATE SOURCE IF NOT EXISTS s_tags_raw (
    tag     VARCHAR,
    value   DOUBLE PRECISION,
    ts      TIMESTAMPTZ,
    quality VARCHAR,
    source  VARCHAR
) WITH (
    connector = 'kafka',
    topic = 'tags.raw',
    properties.bootstrap.server = 'redpanda:9092',
    scan.startup.mode = 'latest'
) FORMAT PLAIN ENCODE JSON;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Statistiques glissantes par tag (fenêtre de temps), pour le z-score.
--    On agrège sur une fenêtre TUMBLE d'1 minute : moyenne + écart-type.
--    (Première version simple ; on pourra passer en HOP pour du recouvrement.)
-- ─────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_tag_stats AS
SELECT
    tag,
    window_start,
    avg(value)    AS mean,
    stddev_samp(value) AS sd,
    count(*)      AS n
FROM TUMBLE(s_tags_raw, ts, INTERVAL '1 MINUTE')
GROUP BY tag, window_start;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. MV d'anomalies : pour chaque fenêtre close, on signale les tags dont la
--    dispersion révèle un comportement anormal. Version pédagogique : on émet
--    une anomalie quand l'écart-type de la fenêtre dépasse un facteur de la
--    moyenne (proxy simple de "ça bouge anormalement"). À raffiner ensuite en
--    vrai z-score par point via un JOIN stream/MV.
-- ─────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_anomalies AS
SELECT
    tag,
    window_start AS detected_at,
    mean,
    sd,
    n
FROM mv_tag_stats
WHERE n >= 5
  AND sd IS NOT NULL
  AND sd > 0.25 * abs(mean) + 0.001;  -- seuil de dispersion (proxy d'anomalie)

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Sink : réémet les anomalies vers le topic Redpanda tags.derived (JSON).
--    La gateway les consomme et crée des alarmes source='derived'.
-- ─────────────────────────────────────────────────────────────────────────
CREATE SINK IF NOT EXISTS sk_anomalies
FROM mv_anomalies
WITH (
    connector = 'kafka',
    topic = 'tags.derived',
    properties.bootstrap.server = 'redpanda:9092',
    primary_key = 'tag,detected_at'
) FORMAT PLAIN ENCODE JSON (force_append_only = 'true');
