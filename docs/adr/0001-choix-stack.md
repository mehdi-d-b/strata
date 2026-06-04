# ADR 0001 — Choix de la stack

- **Date** : 2026-05-29
- **Statut** : accepté

## Contexte

Strata est une plateforme de streaming de données industrielles. Objectifs : éviter au maximum
le code custom (surtout les connecteurs industriels), rester léger (pas de JVM si possible),
pouvoir grandir vers du vrai industriel (Modbus, S7, Allen-Bradley) sans tout réécrire, et
servir une UI web moderne (temps réel + historique).

## Décisions

### Broker : Redpanda
Compatible API Kafka, écrit en C++ (pas de JVM), un seul binaire. La **compatibilité Kafka est
le point décisif** : c'est la police d'assurance pour brancher plus tard des connecteurs
industriels off-the-shelf (PLC4X Kafka Connect) sans écrire de code.

- *Écarté — Apache Kafka* : JVM, ZooKeeper/KRaft, plus lourd à opérer.
- *Écarté — Fluvio (Rust)* : élégant mais écosystème jeune ; pas de connecteurs industriels et
  API propriétaire ⇒ forcerait à écrire des connecteurs custom en Rust. C'est l'inverse de
  l'objectif « éviter le code custom ».

### Connecteurs + transformation stateless : Redpanda Connect (ex-Benthos, Go)
300+ connecteurs, écrit en Go (pas de JVM). Sert à la fois de connecteur (MQTT, SQL…) et de
couche de transformation sans état (nettoyage, conversion d'unités, enrichissement).

### Historisation + agrégats métier : TimescaleDB
Postgres + time-series. Les **continuous aggregates** fournissent un ETL « transparent »
(ex : production par shift pré-calculée en continu) ⇒ on évite de recalculer à l'ouverture des
pages (anti-pattern ELT).

- *Écarté — ksqlDB* : produit Confluent, JVM, friction de licence avec Redpanda.

### Stream processing stateful avancé : différé (RisingWave si besoin)
Pour les agrégats fenêtrés simples, les continuous aggregates Timescale suffisent. Si un jour on
a besoin de temps réel sub-seconde ou de streams dérivés réémis, on ajoutera **RisingWave**
(Rust, pas de JVM, compatible wire PostgreSQL, consomme Redpanda).

- *Écarté pour l'instant — Apache Flink* : puissant mais lourd, JVM ; surdimensionné.

### Temps réel → web : gateway WebSocket/SSE (Node/TypeScript)
Petit service qui consomme les topics Redpanda et pousse au navigateur. Node/TS pour unifier le
langage avec le frontend.

### Frontend : React + Vite + TypeScript
React = écosystème le plus riche pour dashboards/SCADA. Vite = outil de build/dev. TypeScript
pour le typage (filet de sécurité sur les nombreuses structures : tags, mesures, configs).
Charts : uPlot (temps réel, gros volumes) / ECharts (riche).

### Packaging : Docker Compose
Couvre Windows/Mac/Linux d'un coup. Un installeur natif par OS reste possible mais non
prioritaire (polish très tardif).

## Principe transverse : southbound pluggable

Toute source écrit dans des topics Redpanda **normalisés** (`tags.raw` =
`{ tag, value, ts, quality, source }`). Le reste du système ne connaît que ce contrat. On peut
donc mélanger les sources (MQTT via Redpanda Connect + PLC4X via Kafka Connect) sans rien
changer en aval. Conséquence : **aucune JVM dans le stack tant qu'on reste OPC-UA/MQTT** ; la
JVM n'apparaît que si on active le module PLC4X (Phase 4). Alternative no-JVM pour
l'Allen-Bradley : libplctag.
