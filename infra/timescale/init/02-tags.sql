-- Strata — table de configuration des tags (Phase 2).
-- Source de vérité du paramétrage : métadonnées + scaling appliqué À LA LECTURE.
-- La valeur stockée dans `mesures` reste TOUJOURS la valeur brute.

CREATE TABLE IF NOT EXISTS tags (
    name        TEXT PRIMARY KEY,           -- ex: ligne1.compteur (= contrat tags.raw)
    label       TEXT,                       -- libellé lisible, ex: "Compteur ligne 1"
    unit        TEXT,                       -- ex: "pcs", "°C", "tr/min"
    scale       DOUBLE PRECISION NOT NULL DEFAULT 1,   -- valeur affichée = brut * scale + offset
    offset_val  DOUBLE PRECISION NOT NULL DEFAULT 0,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
