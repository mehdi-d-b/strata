# À FAIRE (infra/gateway) — Alarmes Phase A : seuils (détection + persistance)

> Note de passation du **chat front**. On démarre les alarmes par les **seuils
> calculés par Strata** (Type A), détection **dans la gateway**, exposés en **REST**
> (le front *poll* — pas de WebSocket en Phase A, pour ne pas dépendre de la
> sécurisation du WS). Le front est construit côté `web/` et **dégrade proprement**
> tant que ces endpoints n'existent pas (listes vides, pas de crash).
>
> **Principe directeur** : garder un **modèle d'alarme stable** indépendant du
> détecteur. Aujourd'hui la gateway détecte ; demain RisingWave pourra produire les
> mêmes événements sans rien changer à l'UI. Le Type B (tags d'alarme PLC) viendra
> alimenter le **même** modèle d'alarme (Phase B) — donc concevoir `alarms` pour
> accueillir une `source` = `rule` | `tag`.

## Sévérités (figées, communes A et B)
`critical` (alarme) · `warning` · `info` (événement).

## Modèle de données

### `alarm_rules` — définitions de seuils (Type A)
| col | type | notes |
|---|---|---|
| id | text (uuid) | PK |
| tag | text | tag surveillé |
| operator | text | un de `>`, `>=`, `<`, `<=`, `==`, `!=` |
| threshold | double | seuil |
| severity | text | `critical`/`warning`/`info` |
| message | text null | texte custom (sinon généré : `"<tag> <op> <seuil>"`) |
| for_ms | int default 0 | anti-rebond : la condition doit tenir ce temps (optionnel) |
| hysteresis | double default 0 | bande morte au retour normal (optionnel) |
| enabled | bool default true | |

Plusieurs règles par tag autorisées (→ hi/hihi/lo/lolo).

### `alarms` — journal des transitions / état
| col | type | notes |
|---|---|---|
| id | text (uuid) | PK = instance d'alarme |
| rule_id | text null | FK alarm_rules (null si source=tag, Phase B) |
| source | text | `rule` (Phase A) \| `tag` (Phase B) |
| tag | text | |
| severity | text | |
| message | text | |
| value | double null | valeur ayant déclenché (dernière connue) |
| state | text | `active` \| `cleared` |
| raised_at | timestamptz | |
| cleared_at | timestamptz null | |
| acked | bool default false | |
| acked_by | text null | username |
| acked_at | timestamptz null | |

## Détection (gateway, sur le flux `tags.raw`)
À chaque mesure entrante, pour chaque règle `enabled` du tag :
- **Condition vraie** (après `for_ms` si fourni) et pas déjà active → **raise** :
  créer une ligne `alarms` (state=active, raised_at=now, value), audit `alarm.raise`.
- **Condition fausse** (en tenant compte de `hysteresis`) et active → **clear** :
  state=cleared, cleared_at=now, audit `alarm.clear`.
- L'**ack** est indépendant (action opérateur) et **ne clôt pas** l'alarme.
- Garde-fou anti-spam : une seule alarme active par (rule_id) à la fois.

## Endpoints REST

### Règles (config) — **admin**
| Méthode | Route | Corps | Réponse |
|---|---|---|---|
| GET | `/api/alarm-rules` | — | `AlarmRule[]` |
| POST | `/api/alarm-rules` | `AlarmRule` (sans id) | `AlarmRule` |
| PUT | `/api/alarm-rules/:id` | `AlarmRule` | `AlarmRule` |
| DELETE | `/api/alarm-rules/:id` | — | `204` |

### Alarmes (consultation / ack) — **requireAuth**
| Méthode | Route | Réponse |
|---|---|---|
| GET | `/api/alarms` | `Alarm[]` — set « courant » : `state=active` **OU** (`cleared` ET `acked=false`) ; trié raised_at desc |
| POST | `/api/alarms/:id/ack` | `Alarm` (acked=true, acked_by, acked_at) ; audit `alarm.ack` |
| GET | `/api/alarms/history?from&to&limit` | `Alarm[]` (optionnel, pour plus tard) |

Formes (TS) :
```ts
type Severity = "critical" | "warning" | "info";
type AlarmRule = {
  id: string; tag: string;
  operator: ">" | ">=" | "<" | "<=" | "==" | "!=";
  threshold: number; severity: Severity;
  message: string | null; for_ms?: number; hysteresis?: number; enabled: boolean;
};
type Alarm = {
  id: string; rule_id: string | null; source: "rule" | "tag";
  tag: string; severity: Severity; message: string; value: number | null;
  state: "active" | "cleared";
  raised_at: string; cleared_at: string | null;
  acked: boolean; acked_by: string | null; acked_at: string | null;
};
```

## RBAC
- Config des règles : **admin**.
- Lecture `/api/alarms` + ack : `requireAuth` (un opérateur peut acquitter).
  *(Filtrage par droits de lecture sur le tag = amélioration ultérieure, comme pour le WS.)*

## Pourquoi REST/poll et pas WS (Phase A)
Le front poll `/api/alarms` toutes les ~7 s (badge + détection des nouvelles →
toast). Ça évite de dépendre de la sécurisation du WebSocket. Le **push WS
instantané** est une optim Phase C (une fois `/ws` authentifié + filtré).

## Côté front (déjà en place)
- `web/src/api.ts` : types + `fetchAlarmRules/saveAlarmRule/deleteAlarmRule`,
  `fetchAlarms/ackAlarm`.
- `web/src/alarms.tsx` : provider qui poll, expose comptes par sévérité + toasts.
- `web/src/AlarmsView.tsx` : page (alarmes actives + ack + config des règles).
