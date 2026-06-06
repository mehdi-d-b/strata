# À FAIRE (infra/gateway) — Dashboards (persistance + CRUD)

> Note de passation du **chat front**. Le front des Dashboards (pages multi-plots
> sauvegardées) est construit côté `web/`. Il a besoin d'un **CRUD persistant**
> côté gateway. Tant qu'il manque, la liste s'affiche vide et la création échoue
> proprement (toast d'erreur) — pas de crash. Une fois fait, **rien à retoucher
> côté front**.

## Décisions actées (avec l'utilisateur)
- **Privés par utilisateur** : chacun ne voit/édite que SES dashboards.
- Données des panneaux = **refresh périodique REST** (réutilise `/api/history`),
  donc rien de spécial côté gateway pour le streaming.

## Modèle de données

Table `dashboards` :
- `id`          text (uuid ou slug) — PK
- `owner_id`    → user (FK), indexé
- `name`        text
- `spec`        jsonb (voir ci-dessous)
- `created_at`  timestamptz default now()
- `updated_at`  timestamptz default now()

Le **`spec`** est opaque pour la gateway (le front en est seul maître) ; forme
indicative (à NE PAS valider en dur côté serveur, pour ne pas se coupler) :
```json
{
  "panels": [
    { "id": "p1", "title": "Fermenteur", "series": [
      { "tag": "brasserie.ipa.fermenteur.temperature", "axis": "left" },
      { "tag": "brasserie.ipa.fermenteur.pression", "axis": "right" }
    ]}
  ],
  "range": { "mode": "relative", "sec": 900 },
  "refreshSec": 10
}
```

## Endpoints (tous `requireAuth`, scope = propriétaire courant)

| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/dashboards` | — | `DashboardSummary[]` |
| GET | `/api/dashboards/:id` | — | `Dashboard` (404 si pas à soi) |
| POST | `/api/dashboards` | `{ name, spec }` | `Dashboard` (id généré) |
| PUT | `/api/dashboards/:id` | `{ name, spec }` | `Dashboard` (404 si pas à soi) |
| DELETE | `/api/dashboards/:id` | — | `204` (404 si pas à soi) |

Formes :
```ts
DashboardSummary = { id: string; name: string; updated_at: string };  // ISO
Dashboard        = { id: string; name: string; spec: object; updated_at: string };
```

## Règles
- **Isolation par propriétaire** : toutes les routes filtrent sur `owner_id = userCourant`.
  Accéder au dashboard d'un autre → `404` (pas `403`, pour ne pas révéler l'existence).
- `PUT` met `updated_at = now()`.
- `name` non vide (sinon `400`).
- `spec` stocké tel quel (jsonb). Pas de validation de schéma côté serveur.
- Audit (optionnel, cohérent avec l'existant) : log create/update/delete.

## Où
Côté **gateway** (Fastify), à côté des autres routes `/api/*`. Réutiliser le
helper d'auth/session existant (`requireAuth`) et le pool `pg`.

## Test rapide (quand c'est fait)
```bash
# (avec un cookie de session valide)
curl -s -X POST localhost:3001/api/dashboards \
  -H 'content-type: application/json' \
  -d '{"name":"Test","spec":{"panels":[],"range":{"mode":"relative","sec":300}}}'
curl -s localhost:3001/api/dashboards          # -> [{id,name,updated_at}]
```

## Côté front (déjà en place)
- Appels : `web/src/api.ts` → `fetchDashboards / fetchDashboard / createDashboard /
  updateDashboard / deleteDashboard`.
- Pages : `web/src/DashboardsView.tsx` (liste) et `web/src/DashboardView.tsx` (détail).
