# connectors/plc4x/ — industriel via PLC4X (Phase 4)

Sous-système **optionnel** pour brancher de vrais automates (Siemens S7, Schneider
Modbus, Rockwell EtherNet/IP…) via [Apache PLC4X](https://plc4x.apache.org/) tournant
dans **Kafka Connect**.

> ⚠️ C'est le **seul** container JVM de Strata. Il est isolé derrière le profil
> Docker `plc4x` : le stack par défaut (`make up`) reste 100 % sans JVM.

## Architecture

```
Kafka Connect + PLC4X   →   topic plc.raw   →   Redpanda Connect (renormalise)   →   tags.raw
   (driver simulated://            (schéma PLC4X)        plc.raw → contrat Strata
    ou s7:// / modbus-tcp://
    ou eip:// en réel)
```

Tout l'aval (Timescale, gateway, dashboard) est déjà en place et ne change pas.

## Démarrer le sous-système

```bash
# Lance le stack AVEC Kafka Connect (sinon il ne démarre pas)
docker compose --profile plc4x up -d --build

# Vérifier que Kafka Connect est prêt (peut prendre ~1 min au 1er boot)
curl http://localhost:8083/connector-plugins | grep -i plc4x
```

## De la simulation au matériel réel

On teste **sans automate** grâce au driver `simulated://` de PLC4X. Le jour où tu as
du vrai matériel, tu changes **uniquement l'URL de connexion** dans le JSON du
connecteur — le reste de la chaîne ne bouge pas :

| Marque | Driver PLC4X (réel) |
|---|---|
| Siemens S7-1200/1500 | `s7://192.168.0.10` |
| Schneider / Modbus | `modbus-tcp://192.168.0.20` |
| Rockwell / Allen-Bradley | `eip://192.168.0.30` |

## Configs prêtes à l'emploi

| Fichier | Marque / protocole | sourceName | base métier (normaliseur) |
|---|---|---|---|
| `00-simulated.json` | démo pure (RANDOM) | `demo` | `usine1.ligne1` |
| `10-siemens-s7.json` | Siemens S7 (`s7://`) | `s7line` | `usine1.ligne1` |
| `11-schneider-modbus.json` | Modbus TCP (`modbus-tcp://`) | `modbusdev` | `usine1.ligne2` |
| `12-rockwell-eip.json` | Allen-Bradley (`eip://`) | `ablogix` | `usine1.ligne3` |

Chaque fichier est **testable immédiatement** (driver `simulated://`). Déployer un
connecteur :

```bash
curl -s -X POST http://localhost:8083/connectors \
  -H 'content-type: application/json' \
  -d @connectors/plc4x/10-siemens-s7.json | python3 -m json.tool

# état (RUNNING attendu)
curl -s http://localhost:8083/connectors/plc4x-siemens/status | python3 -m json.tool
```

Gérer les connecteurs :

```bash
curl -s http://localhost:8083/connectors                       # lister
curl -s -X DELETE http://localhost:8083/connectors/plc4x-siemens   # supprimer
# mettre à jour la config d'un connecteur existant :
curl -s -X PUT http://localhost:8083/connectors/plc4x-siemens/config \
  -H 'content-type: application/json' \
  -d "$(python3 -c "import json;print(json.dumps(json.load(open('connectors/plc4x/10-siemens-s7.json'))['config']))")"
```

## Écriture vers les automates (sink, Phase 8)

`20-sink-siemens-s7.json` est un **template** de connecteur *sink* : il consomme le
topic `tags.cmd` (consignes publiées par la gateway après vérif des droits) et les
écrit dans un automate.

> ⚠️ Contrairement au connecteur **source** (testé et fonctionnel via `simulated://`),
> ce sink est un **template non calibré** : le mapping « tag métier → adresse physique »
> et le format exact dépendent du matériel et de la version du connecteur. À finaliser
> le jour où un vrai automate est disponible (interroger
> `/connector-plugins/Plc4xSinkConnector/config/validate` pour le schéma exact).

En attendant, la boucle d'écriture est **pleinement démontrable via le simulateur** :
la gateway publie sur `tags.cmd`, et la *face de commande* du simulateur applique la
consigne au cerveau (ex : changer la température cible d'une cuve → visible sur la courbe).

## Passer au matériel réel

Dans le JSON du connecteur :
1. `sources.<nom>.connectionString` : `simulated://127.0.0.1` → l'URL réelle
   (`s7://192.168.0.10`, `modbus-tcp://192.168.0.20`, `eip://192.168.0.30`).
2. `jobs.scan.tags.<alias>` : `RANDOM/...` → les vraies adresses (exemples par marque
   dans le champ `_comment_addresses` de chaque fichier).
3. Le **nom métier** des tags (`site.ligne.machine.mesure`) est composé par le normaliseur
   `connectors/plc4x-to-raw.yaml` à partir du `sourceName` (table `source_base`). Adapter
   cette table si besoin. Le reste de la chaîne ne change pas.
