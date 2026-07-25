-- Base de connaissances vectorielle (RAG) ----------------------------------------
-- Prérequis : pgvector (CREATE EXTENSION vector).
-- Chaque document est découpé en chunks ; chaque chunk est embeddi via
-- nomic-embed-text (768 dimensions) par le gateway avant insertion.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge (
    id          SERIAL PRIMARY KEY,
    category    TEXT NOT NULL,          -- ex: 'sop', 'incident', 'machine', 'recette'
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,          -- texte brut du chunk
    embedding   vector(768),            -- nomic-embed-text produit 768 dims
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index HNSW : recherche ANN rapide (meilleure perf que IVFFlat sur petits corpus).
CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
    ON knowledge USING hnsw (embedding vector_cosine_ops);

-- Les références machine, codes défaut et noms de tags sont mieux retrouvés par
-- recherche lexicale que par seul embedding. Cet index complète HNSW.
CREATE INDEX IF NOT EXISTS knowledge_fts_idx
    ON knowledge USING gin (to_tsvector('french', title || ' ' || body));

ALTER TABLE knowledge
    ADD CONSTRAINT IF NOT EXISTS knowledge_category_title_key UNIQUE (category, title);

-- Accès lecture seule pour le rôle assistant.
GRANT SELECT ON knowledge TO strata_ro;
