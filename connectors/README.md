# connectors/

Pipelines **Redpanda Connect** (YAML) : connecteurs (MQTT, SQL…) et transformations stateless
(nettoyage, conversion d'unités, enrichissement).

À venir en Phase 1 :
- `mqtt-to-raw.yaml` — MQTT in → normalisation → topic `tags.raw`
- `raw-to-timescale.yaml` — `tags.raw` → sink TimescaleDB (`mesures`)
