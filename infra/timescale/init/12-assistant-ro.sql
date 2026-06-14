-- Strata — rôle READ-ONLY pour le tool `query_readonly` de l'assistant (LLM, Part A).
-- Cf. docs/llm-integration.md. Le LLM écrit un SELECT ; la gateway l'exécute via
-- `SET LOCAL ROLE strata_ro` dans une transaction READ ONLY. Garanties (défense en
-- profondeur) : (1) rôle sans aucun droit d'écriture, (2) SELECT seulement sur les
-- tables de DONNÉES — JAMAIS l'auth (users/sessions/roles/grants/audit_log),
-- (3) transaction READ ONLY + statement_timeout + LIMIT côté gateway.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'strata_ro') THEN
    CREATE ROLE strata_ro NOLOGIN;
  END IF;
END $$;

-- L'utilisateur applicatif (propriétaire des tables) doit pouvoir SET ROLE strata_ro.
GRANT strata_ro TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO strata_ro;

-- Liste EXPLICITE des tables/vues de données interrogeables (moindre privilège).
-- Volontairement SANS : users, sessions, roles, user_roles, grants, audit_log.
GRANT SELECT ON
    mesures, tags, tag_role,
    shift_schedule, shift_active, prod_buckets, prod_by_shift, prod_by_shift_role,
    devices,
    alarm_rules, alarms,
    oee_line, oee_target, oee_state_buckets, oee_reason_buckets,
    oee_state_by_shift, oee_by_shift, oee_downtime_by_shift,
    stop_reason, stop_event_label
TO strata_ro;
