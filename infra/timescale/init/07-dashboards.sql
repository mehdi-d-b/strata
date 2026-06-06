-- Strata — dashboards sauvegardés (pages multi-plots), privés par utilisateur.
--
-- Le `spec` est OPAQUE pour la gateway (le front en est seul maître) : on le
-- stocke en jsonb tel quel, sans validation de schéma côté serveur, pour ne pas
-- se coupler à la forme du front.

CREATE TABLE IF NOT EXISTS dashboards (
    id         TEXT PRIMARY KEY,                          -- uuid/slug généré
    owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    spec       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(owner_id);
