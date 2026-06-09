-- Strata — automates (devices) & adresses physiques des tags (Phase « gestion des tags »).
--
-- Objectif : faire de Strata l'UNIQUE source de vérité de la configuration
-- d'acquisition. Avant, l'adresse physique d'un point (ex %DB1.DBD0) vivait
-- uniquement dans le JSON du connecteur PLC4X. Désormais elle est en base,
-- rattachée à un automate, et les configs PLC4X sont GÉNÉRÉES depuis ces tables.

-- Un automate (ou tout équipement adressable via un protocole).
CREATE TABLE IF NOT EXISTS devices (
    name       TEXT PRIMARY KEY,          -- identifiant logique, ex: ipa-fermenteur
    protocol   TEXT NOT NULL CHECK (protocol IN ('modbus-tcp', 's7', 'eip', 'opcua', 'simulated')),
    host       TEXT NOT NULL,             -- IP/host, ex: 192.168.0.21 (ou 127.0.0.1 en simulated)
    options    TEXT,                      -- options de connexion PLC4X (ex: 'remote-slot=1')
    poll_ms    INTEGER NOT NULL DEFAULT 1000,  -- période de scan
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    base_tag   TEXT,                      -- préfixe métier appliqué aux tags, ex: brasserie.ipa
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- On rattache chaque tag (déjà existant) à un automate + son adresse physique.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS device  TEXT REFERENCES devices(name) ON DELETE SET NULL;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS address TEXT;       -- adresse PLC4X, ex: holding-register:1:DINT
ALTER TABLE tags ADD COLUMN IF NOT EXISTS datatype TEXT;      -- optionnel : DINT, REAL, BOOL…

CREATE INDEX IF NOT EXISTS idx_tags_device ON tags(device);

COMMENT ON COLUMN tags.address IS
  'Adresse physique au format du driver PLC4X du device (ex Modbus: holding-register:1:DINT ; S7: %DB1.DBD0:DINT ; AB: nom_tag ; OPC-UA: ns=2;s=NomDuNode).';
