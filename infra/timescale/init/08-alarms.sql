-- Strata — alarmes Phase A : seuils (détection gateway + persistance).
--
-- Principe directeur : le modèle d'alarme (`alarms`) est STABLE et indépendant du
-- détecteur. Aujourd'hui la gateway détecte des seuils (source='rule') ; demain
-- RisingWave ou des tags d'alarme PLC (source='tag', Phase B) alimenteront le même
-- modèle sans rien changer à l'UI.

-- Définitions de seuils (Type A).
CREATE TABLE IF NOT EXISTS alarm_rules (
    id         TEXT PRIMARY KEY,
    tag        TEXT NOT NULL,
    operator   TEXT NOT NULL CHECK (operator IN ('>', '>=', '<', '<=', '==', '!=')),
    threshold  DOUBLE PRECISION NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    message    TEXT,
    for_ms     INTEGER NOT NULL DEFAULT 0,        -- anti-rebond
    hysteresis DOUBLE PRECISION NOT NULL DEFAULT 0, -- bande morte au retour normal
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alarm_rules_tag ON alarm_rules(tag) WHERE enabled;

-- Journal des transitions / état des instances d'alarme.
CREATE TABLE IF NOT EXISTS alarms (
    id         TEXT PRIMARY KEY,
    rule_id    TEXT REFERENCES alarm_rules(id) ON DELETE SET NULL,
    source     TEXT NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'tag', 'derived')),
    tag        TEXT NOT NULL,
    severity   TEXT NOT NULL,
    message    TEXT NOT NULL,
    value      DOUBLE PRECISION,
    state      TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cleared')),
    raised_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cleared_at TIMESTAMPTZ,
    acked      BOOLEAN NOT NULL DEFAULT FALSE,
    acked_by   TEXT,
    acked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alarms_state ON alarms(state, raised_at DESC);

-- Garde-fou anti-spam : au plus UNE alarme active par règle à la fois.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alarms_active_rule
    ON alarms(rule_id) WHERE state = 'active' AND rule_id IS NOT NULL;
