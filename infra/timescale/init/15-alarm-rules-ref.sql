-- Strata — alarmes en "bande vs tag de référence" (généralisation de alarm_rules).
--
-- Jusqu'ici une règle compare un tag à un SEUIL FIXE (operator/threshold). On ajoute
-- un mode "bande" : comparer un tag à la valeur ACTUELLE d'un autre tag (ex. une
-- consigne) ± une tolérance. Couvre la dérive consigne↔mesure (cf. la logique déjà
-- prouvée dans get_batch_context) en continu, hors du cadre d'un batch.
--
-- ref_tag NULL (défaut) : comportement inchangé, seuil fixe. ref_tag NOT NULL :
-- mode bande, condition = abs(value - valeur_actuelle(ref_tag)) > tolerance ;
-- operator/threshold sont alors ignorés par AlarmEngine.

ALTER TABLE alarm_rules ADD COLUMN IF NOT EXISTS ref_tag   TEXT REFERENCES tags(name) ON DELETE SET NULL;
ALTER TABLE alarm_rules ADD COLUMN IF NOT EXISTS tolerance DOUBLE PRECISION;

COMMENT ON COLUMN alarm_rules.ref_tag IS
  'Si renseigné : mode bande — compare `tag` à la valeur courante de ref_tag ± tolerance, au lieu du seuil fixe operator/threshold.';
COMMENT ON COLUMN alarm_rules.tolerance IS
  'Tolérance du mode bande (ignorée si ref_tag est NULL).';
