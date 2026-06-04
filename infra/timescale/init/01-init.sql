-- Strata — initialisation TimescaleDB (exécuté une seule fois, au premier démarrage).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Contrat de données Strata (cf. docs/adr/0001-choix-stack.md).
-- Toutes les mesures normalisées atterrissent ici depuis le topic Redpanda `tags.raw`.
CREATE TABLE IF NOT EXISTS mesures (
    ts       TIMESTAMPTZ      NOT NULL,
    tag      TEXT             NOT NULL,
    value    DOUBLE PRECISION,
    quality  TEXT,
    source   TEXT
);

SELECT create_hypertable('mesures', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_mesures_tag_ts ON mesures (tag, ts DESC);
