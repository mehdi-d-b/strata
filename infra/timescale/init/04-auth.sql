-- Strata — authentification & contrôle d'accès (Phase 7).
--
-- Modèle :
--   users          : comptes (mot de passe hashé scrypt).
--   sessions       : sessions actives (révocables -> on peut couper un accès).
--   roles          : rôles nommés (admin, opérateur, viewer…).
--   user_roles     : quels rôles a un utilisateur.
--   grants         : droits d'un rôle = (scope préfixe de tag, action).
--   audit_log      : trace des actions sensibles (écritures, login…).
--
-- Le contrôle d'accès s'appuie sur la convention de nommage `site.ligne.machine.mesure` :
-- un droit porte sur un PRÉFIXE (ex 'brasserie.blonde') et s'applique à tout tag qui
-- commence par ce préfixe. '*' ou '' = tout.

CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,            -- format: scrypt$<saltHex>$<hashHex>
    display_name  TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,            -- jeton opaque aléatoire (cookie httpOnly)
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS roles (
    name        TEXT PRIMARY KEY,
    description TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT   NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role)
);

-- Un droit : ce rôle peut faire `action` sur les tags sous le préfixe `scope`.
CREATE TABLE IF NOT EXISTS grants (
    role   TEXT NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
    scope  TEXT NOT NULL DEFAULT '*',        -- préfixe de tag, '*' = tout
    action TEXT NOT NULL CHECK (action IN ('read', 'write', 'admin')),
    PRIMARY KEY (role, scope, action)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    username  TEXT,
    action    TEXT NOT NULL,                 -- ex: 'login', 'tag.write', 'tag.update'
    target    TEXT,                          -- ex: le tag concerné
    detail    JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- Rôles de base.
INSERT INTO roles (name, description) VALUES
    ('admin',    'Accès complet : gestion des utilisateurs, lecture/écriture tous tags'),
    ('operator', 'Lecture tous tags, écriture sur un périmètre donné'),
    ('viewer',   'Lecture seule'),
    -- Compte technique du microservice IA. Il ne peut ni administrer ni écrire
    -- des consignes : les actions confirmées restent exécutées par la session
    -- réelle de l'opérateur dans la gateway.
    ('assistant_service', 'Compte technique IA : lecture seule via la gateway')
ON CONFLICT DO NOTHING;

-- Droits par défaut des rôles de base.
INSERT INTO grants (role, scope, action) VALUES
    ('admin',    '*', 'admin'),
    ('admin',    '*', 'write'),
    ('admin',    '*', 'read'),
    ('operator', '*', 'read'),
    ('viewer',   '*', 'read'),
    ('assistant_service', '*', 'read')
ON CONFLICT DO NOTHING;
