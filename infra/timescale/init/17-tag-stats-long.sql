-- Strata — 2ᵉ continuous aggregate pour le mode self-baseline (fenêtre LONGUE).
--
-- Constat en vérifiant le mode self-baseline (16-alarm-rules-baseline.sql) sur une vraie dérive
-- lente : comparer la VALEUR INSTANTANÉE à `tag_stats_1m` (1 min) fait clignoter l'alarme
-- (raise/clear répétés) au lieu de signaler proprement "ça dérive" — la moyenne 1 min rattrape
-- une partie de la dérive, et son écart-type explose pendant les transitions rapides.
--
-- Fix : comparer deux moyennes lissées de vitesses différentes (court terme vs long terme) au
-- lieu d'une valeur brute à une seule fenêtre. Un écart persistant entre les deux grossit
-- pendant une vraie dérive sans clignoter, parce qu'aucun des deux côtés n'est une valeur
-- ponctuelle bruitée. `tag_stats_5m` est volontairement moins fraîche (end_offset 1 min) :
-- elle ne doit PAS suivre l'anomalie qu'on cherche à détecter.
--
-- ⚠️ Fenêtre longue = 5 min ici, pas 30 min : le bucket time_bucket() se cale sur `ts` (horodatage
-- RÉEL, indépendant de la variable SPEED du simulateur) — une fenêtre de 30 min demanderait donc
-- 30 vraies minutes d'attente avant le premier bucket, quelle que soit l'accélération. 5 min garde
-- le même mécanisme (court/long) tout en restant vérifiable dans une session interactive. À
-- recalibrer en production selon l'échelle de temps réelle de la dérive à détecter (heures pour
-- une usure mécanique lente, cf. docs/simulator-scenarios.md § Addendum).

CREATE MATERIALIZED VIEW IF NOT EXISTS tag_stats_5m
WITH (timescaledb.continuous) AS
SELECT
  tag,
  time_bucket('5 minutes', ts) AS bucket,
  avg(value)         AS mean,
  stddev_samp(value) AS sd,
  count(*)           AS n
FROM mesures
GROUP BY tag, bucket;

SELECT add_continuous_aggregate_policy('tag_stats_5m',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);
