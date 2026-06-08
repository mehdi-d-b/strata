# connectors/

Pipelines **Redpanda Connect** (ex-Benthos, en Go, **sans JVM**) : ils déplacent et
**normalisent** les données entre MQTT, Redpanda et TimescaleDB. Chaque pipeline est un fichier
YAML monté dans un container `connect-*` (voir `docker-compose.yml`).

Rôle central : faire respecter le **contrat `tags.raw`** (`{ tag, value, ts, quality, source }`,
tag = nom métier `site.ligne.machine.mesure`). Les sources écrivent du brut ; ces pipelines
produisent/consomment le contrat normalisé.

## Pipelines (stack par défaut)

| Fichier | Flux | Rôle |
|---|---|---|
| `mqtt-to-raw.yaml` | MQTT → `tags.raw` | normalise les messages du simulateur (topic MQTT `factory/<site>/<ligne>/<machine>/<mesure>` → tag métier) |
| `raw-to-timescale.yaml` | `tags.raw` → TimescaleDB | insère chaque mesure (brute) dans l'hypertable `mesures` |
| `plc4x-to-raw.yaml` | `plc.raw` → `tags.raw` | renormalise la sortie PLC4X (éclate les tags groupés, compose le nom métier depuis le `base_tag` du device) — **profil `plc4x`** |

> ⚠️ Les producteurs vers `tags.raw` sont en **`compression: none`** : la gateway (KafkaJS) ne
> décode pas Snappy. Ne pas réactiver la compression sans ajouter le codec côté gateway.

## PLC4X (`plc4x/`) — profil `plc4x`

Connecteurs **Kafka Connect** (et non Redpanda Connect) pour brancher de vrais automates ou
le driver `simulated://`. Ce sont des configs JSON déployées via l'API Kafka Connect (:8083).

| Fichier | Cible |
|---|---|
| `00-simulated.json` | démo sans matériel (`simulated://`) |
| `10-siemens-s7.json` | Siemens S7 (`s7://`) |
| `11-schneider-modbus.json` | Schneider / Modbus TCP (`modbus-tcp://`) |
| `12-rockwell-eip.json` | Rockwell / Allen-Bradley (`eip://`) |
| `20-sink-siemens-s7.json` | écriture de consignes vers un S7 (sink) |

Détail d'usage (déploiement, mapping d'adresses) : [plc4x/README.md](plc4x/README.md).

> 💡 En pratique, les connecteurs PLC4X sont **générés et déployés depuis l'UI** (onglet
> Automates) par la gateway, à partir de la table `devices`. Ces fichiers JSON sont des
> **gabarits de référence** ; la source de vérité est la base.

## Tester un pipeline

```bash
# voir les messages normalisés arriver dans tags.raw
docker compose exec redpanda rpk topic consume tags.raw --num 5 --brokers redpanda:9092

# logs d'un pipeline
docker compose logs -f connect-mqtt-to-raw
```

Vue d'ensemble : [../docs/infra-architecture.md](../docs/infra-architecture.md).
