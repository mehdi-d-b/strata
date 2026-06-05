-- Strata — rétention & compression TimescaleDB (durcissement « prod »).
--
-- Sans ça, la table `mesures` grossit indéfiniment. On active :
--   1. la COMPRESSION des chunks de plus de 7 jours (restent interrogeables,
--      gain typique 10-20× sur des séries temporelles) ;
--   2. la RÉTENTION : purge automatique du brut au-delà de 365 jours.
--
-- Les continuous aggregates (prod/shift) lisent l'hypertable et continuent de
-- fonctionner sur les chunks compressés ; ils ne sont PAS purgés par cette
-- politique (elle ne porte que sur `mesures`), donc l'historique métier agrégé
-- survit bien au-delà d'un an.

-- 1) Active la compression sur l'hypertable.
--    segmentby=tag : on compresse par tag (requêtes filtrées par tag = rapides).
--    orderby ts DESC : ordre interne des données compressées.
ALTER TABLE mesures SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'tag',
    timescaledb.compress_orderby = 'ts DESC'
);

-- 2) Politique de compression : compresse les chunks plus vieux que 7 jours.
SELECT add_compression_policy('mesures', INTERVAL '7 days', if_not_exists => TRUE);

-- 3) Politique de rétention : supprime le brut plus vieux que 365 jours.
SELECT add_retention_policy('mesures', INTERVAL '365 days', if_not_exists => TRUE);
