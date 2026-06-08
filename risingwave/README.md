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

## État : chaîne complète FAITE ✅
- [x] Chaîne source -> MV -> sink validée.
- [x] **Gateway** : consumer `tags.derived` -> `alarms` (source='derived', anti-doublon).
      Les anomalies apparaissent dans la page Alarmes existante, sans toucher l'UI.

## Idées d'amélioration (pour un prochain chat — non faites, par choix)
- **Vrai z-score par point** : aujourd'hui `mv_anomalies` utilise un *proxy de dispersion*
  (`sd > 0.25*|mean|`) par fenêtre. Mieux : JOIN du flux courant `s_tags_raw` avec
  `mv_tag_stats` pour calculer `|value - mean| / sd` point par point, anomalie si > ~3σ.
  Plus juste et standard. (Attention : les tags PLC4X `RANDOM` ressortiront toujours, c'est
  normal — ce sont de vraies valeurs aléatoires.)
- **Sévérité graduée** : warning au-delà de 3σ, critical au-delà de 5σ (au lieu de warning fixe
  dans le consumer gateway `startDerivedConsumer`).
- **Clear auto des anomalies derived** : actuellement une anomalie derived se lève mais n'est
  jamais clôturée automatiquement (contrairement aux seuils de l'AlarmEngine). Émettre aussi un
  signal de "retour normal" depuis RisingWave (ou clôturer après N fenêtres sans anomalie).
- **Exclure les tags non pertinents** : filtrer les tags booléens (`.panne`, `.state`,
  `defaut_thermique`) de la détection d'anomalie statistique — ils ont déjà des règles de seuil
  dédiées ; le z-score n'a pas de sens dessus.
- **Autres MV utiles** : moyennes mobiles lissées, débits cumulés, OEE live — réémises comme
  tags `source='derived'`, affichables dans l'Explorer à côté du réel.
- Mettre à jour `docs/roadmap.md` (P9 RisingWave) au prochain jalon.

## Fichiers
- `risingwave/01-setup.sql` : source `tags.raw` -> `mv_tag_stats` (TUMBLE 1 min) ->
  `mv_anomalies` -> sink `tags.derived`.
- `docker-compose.yml` : service `risingwave` (profil `risingwave`), topic
  `tags.derived` créé par `topic-init`.
