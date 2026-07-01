-- Strata — alarmes en mode "self-baseline" (3ᵉ mode de alarm_rules, après seuil fixe et bande).
--
-- Pour un tag sans référence externe (ampérage sans consigne, vibration...) : l'attendu se
-- déduit de l'historique récent du tag lui-même (moyenne/écart-type glissants), calculé en
-- continu par TimescaleDB. Porte l'idée déjà validée dans RisingWave (mv_tag_stats), mais
-- RisingWave reste dernier recours (cf. docs/risingwave-integration.md) : pour de la dérive,
-- pas besoin de sub-seconde.
--
-- Rien n'est surveillé tant qu'une règle n'est pas créée sur le tag précis (pas de scan global
-- ni de table "quels tags surveiller" à part) : le filtrage est gratuit, par construction.

CREATE MATERIALIZED VIEW IF NOT EXISTS tag_stats_1m
WITH (timescaledb.continuous) AS
SELECT
  tag,
  time_bucket('1 minute', ts) AS bucket,
  avg(value)         AS mean,
  stddev_samp(value) AS sd,
  count(*)           AS n
FROM mesures
GROUP BY tag, bucket;

-- Écart voulu vs l'idiome du projet (3h / 15min / 1min, cf. prod_buckets `03-production.sql`) :
-- ici on veut une baseline FRAÎCHE (comparaison live), pas un report shift-safe. end_offset
-- réduit au minimum viable (juste au-delà de la largeur du bucket, pour ne pas matérialiser un
-- bucket encore ouvert).
SELECT add_continuous_aggregate_policy('tag_stats_1m',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

ALTER TABLE alarm_rules ADD COLUMN IF NOT EXISTS baseline_sigma DOUBLE PRECISION;

COMMENT ON COLUMN alarm_rules.baseline_sigma IS
  'Si renseigné (et ref_tag NULL) : mode self-baseline — alarme si |valeur - moyenne glissante (tag_stats_1m)| > baseline_sigma * écart-type glissant. Mutuellement exclusif avec ref_tag.';
