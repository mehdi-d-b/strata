# Notes de passation front → infra (archivées)

Ces notes ont été rédigées par le **chat front** pour spécifier des endpoints/tables
à implémenter côté gateway/infra. **Toutes traitées** — conservées pour l'historique
et comme exemples de specs bien cadrées.

| Note | Sujet | État | Implémenté dans |
|---|---|---|---|
| `INFRA-TODO-history-range.md` | `/api/history?from&to` + down-sampling | ✅ fait | `gateway/src/index.ts` |
| `INFRA-TODO-dashboards.md` | CRUD dashboards privés | ✅ fait | `07-dashboards.sql` + gateway |
| `INFRA-TODO-alarms.md` | alarmes Phase A (seuils) | ✅ fait | `08-alarms.sql` + `gateway/src/alarms.ts` |
| `INFRA-TODO-ws-security.md` | auth + filtrage RBAC du WS | ✅ fait | `gateway/src/index.ts` |

Vue d'ensemble : [../infra-architecture.md](../infra-architecture.md).
