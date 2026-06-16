-- Strata — batchs de production (généalogie de batch pour l'assistant / RCA).
--
-- Un batch = un brassage entre le start et le stop d'une ligne. Le SIMULATEUR
-- calcule le verdict QC depuis la qualité réellement observée (jamais aléatoire) et
-- l'expose via les tags `<ligne>.batch.{id,phase,qc_verdict,rebut_pct}`. La GATEWAY
-- (BatchTracker) persiste ici une ligne à l'ouverture, puis la complète à la
-- clôture (phase=5). C'est ce que lira get_batch_context. Cf. docs/simulator-scenarios.md.

CREATE TABLE IF NOT EXISTS batches (
    id           TEXT PRIMARY KEY,             -- "<recette>-<epoch_début>"
    recipe       TEXT NOT NULL,                -- "ipa", "blonde"...
    line         TEXT NOT NULL,                -- "brasserie.ipa"
    started_at   TIMESTAMPTZ NOT NULL,
    ended_at     TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
    qc_verdict   TEXT,                         -- "ok" | "fermentation_hors_spec" | ...
    defaut_type  TEXT,                         -- NULL si conforme
    rebut_pct    REAL,
    qc_notes     TEXT
);

-- "Dernier batch de la recette X" = ORDER BY started_at DESC.
CREATE INDEX IF NOT EXISTS idx_batches_recipe_started ON batches(recipe, started_at DESC);

-- Lecture pour l'assistant (rôle read-only créé en 12-assistant-ro.sql).
GRANT SELECT ON batches TO strata_ro;
