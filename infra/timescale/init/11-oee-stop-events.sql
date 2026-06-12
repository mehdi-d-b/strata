-- Strata — OEE : reclassement opérateur des arrêts (motifs v2). Cf. docs/oee-design.md.
--
-- La DÉTECTION des intervalles d'arrêt se fait à la lecture (gateway) : change-points
-- sur le `running_tag`, par fenêtre bornée → des arrêts discrets (début/fin/durée) avec
-- un motif DÉRIVÉ (état 0 = Arrêt, 2 = Panne). Ici on stocke seulement l'ÉTIQUETTE que
-- l'opérateur pose dessus (le motif RÉEL) ; le motif effectif = label si présent, sinon dérivé.

CREATE TABLE IF NOT EXISTS stop_event_label (
    line        TEXT NOT NULL,                 -- ligne OEE
    start_ts    TIMESTAMPTZ NOT NULL,          -- début de l'arrêt (clé de l'intervalle détecté)
    reason_code TEXT NOT NULL REFERENCES stop_reason(code),
    note        TEXT,
    labeled_by  TEXT,
    labeled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (line, start_ts)
);

-- Palette de motifs « terrain » que l'opérateur peut choisir (au-delà des dérivés
-- fault/stopped/waiting). Inclut des motifs PLANIFIÉS (nettoyage, pause) — 1er pas
-- vers la distinction planifié / non planifié.
INSERT INTO stop_reason (code, label, kind, planned, color) VALUES
    ('changeover',  'Changement de série', 'downtime', false, '#7c3aed'),
    ('material',    'Manque matière',      'downtime', false, '#0891b2'),
    ('maintenance', 'Maintenance',         'downtime', false, '#2563eb'),
    ('cleaning',    'Nettoyage (CIP)',     'downtime', true,  '#0d9488'),
    ('break',       'Pause planifiée',     'downtime', true,  '#65a30d')
ON CONFLICT DO NOTHING;
