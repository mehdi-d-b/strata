# risingwave/ — moteur de calcul temps réel (profil optionnel)

> ✅ **État : chaîne validée de bout en bout** (branche `feat/risingwave`).
> RisingWave lit `tags.raw`, calcule des stats glissantes par tag, détecte des
> anomalies et les réémet dans le topic `tags.derived`. Reste à brancher le
> consumer côté gateway (`tags.derived` → table `alarms` source='derived').
>
> Note env : l'image n'embarque pas `psql` ; on utilise le `psql` du container
> `timescaledb` pointé sur `risingwave:4566` (voir commandes ci-dessous). Le pull
> de l'image est lourd (coupures réseau WSL possibles : relancer en boucle).

## Rôle
RisingWave consomme `tags.raw` (Redpanda), calcule des vues matérialisées en SQL
streaming (anomalies, dérivés) et **sink** les résultats vers le topic
`tags.derived`. La gateway consommera `tags.derived` pour créer des alarmes
`source='derived'` (le modèle `alarms` est déjà prévu pour). Contexte complet et
justification : [docs/risingwave-integration.md](../docs/risingwave-integration.md).

## Reprendre quand le réseau le permet

```bash
# 1) Télécharger l'image (en boucle si le réseau coupe ; reprend les couches)
until docker pull risingwavelabs/risingwave:v2.5.0; do echo "retry…"; sleep 3; done
#   Astuce si ça coupe sans fin : Docker Desktop > Settings > Docker Engine
#   -> ajouter "max-concurrent-downloads": 1, Apply & Restart, puis relancer.

# 2) Démarrer RisingWave (profil dédié, ne touche pas au stack par défaut)
docker compose --profile risingwave up -d risingwave

# 3) Appliquer le SQL de setup. L'image RisingWave n'a PAS psql -> on emprunte
#    celui de timescaledb, en pointant le réseau Docker vers risingwave:4566.
docker compose exec -T timescaledb psql -h risingwave -p 4566 -d dev -U root < risingwave/01-setup.sql
#    (si le sink échoue sur "unexpected decreasing now" = saut d'horloge WSL : relancer la création du sink)

# 4) Vérifier que la source lit bien tags.raw et que les MV tournent
docker compose exec -T timescaledb psql -h risingwave -p 4566 -d dev -U root -c "SHOW SOURCES; SHOW MATERIALIZED VIEWS;"
docker compose exec -T timescaledb psql -h risingwave -p 4566 -d dev -U root -c "SELECT * FROM mv_tag_stats ORDER BY window_start DESC LIMIT 5;"

# 5) Voir les anomalies réémises arriver dans Redpanda
docker compose exec redpanda rpk topic consume tags.derived --num 5 --brokers redpanda:9092
```

## Reste à faire (après que l'image tourne)
- [ ] Valider la chaîne source -> MV -> sink (étapes 3-5 ci-dessus).
- [ ] Affiner la détection : passer du proxy "dispersion" à un vrai **z-score par
      point** (JOIN du flux courant avec `mv_tag_stats`).
- [ ] **Gateway** : consumer `tags.derived` -> insert dans `alarms` (source='derived',
      severity selon l'écart). C'est le raccord qui fait apparaître les anomalies
      dans la page Alarmes existante, sans toucher l'UI.
- [ ] Mettre à jour la roadmap (P9 RisingWave) une fois validé.

## Fichiers
- `risingwave/01-setup.sql` : source `tags.raw` -> `mv_tag_stats` (TUMBLE 1 min) ->
  `mv_anomalies` -> sink `tags.derived`.
- `docker-compose.yml` : service `risingwave` (profil `risingwave`), topic
  `tags.derived` créé par `topic-init`.
