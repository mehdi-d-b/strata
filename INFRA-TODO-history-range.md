# À FAIRE (infra/gateway) — Historique sur plage absolue `from`/`to`

> Note de passation rédigée par le **chat front**. Le front du « mode historique »
> de l'Explorer (page Temps réel) est **déjà fait et mergé** sur la branche
> `feat/web-ui-overhaul`. Il appelle un endpoint qui **n'existe pas encore côté
> gateway**. Tant qu'il manque, le mode historique s'affiche vide (dégradation
> propre, pas d'erreur). Une fois ce point fait, **rien à retoucher côté front**.

## Besoin

Étendre `GET /api/history` pour accepter une **plage absolue** `from`/`to`, en
plus du paramètre `minutes` existant (qui reste supporté tel quel).

## Contrat exact

### Requête
```
GET /api/history?tag=<nom>&from=<ISO8601>&to=<ISO8601>
```
- `tag` : inchangé (nom métier du tag).
- `from`, `to` : timestamps **ISO 8601**. Le front envoie de l'UTC via
  `Date.toISOString()`, ex. `2026-06-05T08:00:00.000Z`.
- `minutes` (existant) reste valide. `from`/`to` est une **alternative**, pas un
  remplacement. Si `from`/`to` sont présents, ils priment.

### Réponse — **identique à l'existant** (le front la consomme déjà à l'identique)
```json
[ { "ts": "2026-06-05T08:00:01.000Z", "value": 42.0 }, ... ]
```
- **valeurs déjà scalées** (`× scale + offset`), comme aujourd'hui — cohérence
  direct/historique.
- **triées par `ts` ascendant**.
- `ts` en ISO 8601.

## Règles & garde-fous

1. **RBAC** : même droit de **lecture** que le `GET /api/history` actuel (ne pas
   créer de chemin qui contourne l'auth).
2. **Validation** : exiger `from < to`, sinon `400`. Dates invalides -> `400`.
3. **Volume / down-sampling** (important) : une plage large écroule le navigateur
   (ex. 24 h @ 10 Hz ≈ 864 000 points). Prévoir un **plafond de points** avec
   réduction côté serveur :
   - soit un bucket par intervalle (moyenne/min/max via `time_bucket` Timescale),
   - soit LTTB (Largest-Triangle-Three-Buckets) pour préserver la forme.
   - Idéalement, accepter un paramètre optionnel **`maxPoints`** (défaut ~2000–5000).
     Le front pourra le passer plus tard ; pour l'instant, un plafond serveur par
     défaut suffit.

## Où

Côté **gateway** (Node/TS, Fastify) — la route `GET /api/history` qui sert
aujourd'hui le paramètre `minutes` à partir de la table `mesures` (TimescaleDB).
C'est le même handler à étendre.

## Test rapide (quand c'est fait)
```bash
curl -s "http://localhost:3001/api/history?tag=brasserie.blonde.four.temperature\
&from=2026-06-05T08:00:00Z&to=2026-06-05T09:00:00Z" | head
# attendu : [{"ts":"...Z","value": <number>}, ...] trié par ts asc, volume borné
```

## Côté front (pour info, déjà en place)
- Appel : `web/src/api.ts` → `fetchHistoryRange(tag, fromIso, toIso)`.
- Usage : `web/src/LiveView.tsx` (mode `range = { mode: "absolute", from, to }`).
