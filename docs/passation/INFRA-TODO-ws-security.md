# À FAIRE — Sécuriser le WebSocket `/ws` (auth + filtrage RBAC)

> Note de cadrage rédigée par le **chat front**, à traiter **principalement côté
> gateway (chat infra)**, avec un petit raccord front. Pose d'abord le choix
> d'archi (ci-dessous), puis répartit les tâches.

## Problème
`/ws` (gateway, `@fastify/websocket`) est **ouvert** : le flux temps réel contourne
l'auth **et** le RBAC. Un opérateur limité à `brasserie.blonde` reçoit *tout* le
live (et, plus tard, *toutes* les alarmes). À corriger avant tout vrai déploiement.

**Objectif :**
1. **Authentifier** la connexion WS à l'ouverture (handshake).
2. **Filtrer** les messages poussés à chaque socket selon les **droits de lecture**
   de l'utilisateur (préfixes de tags autorisés).

## Décision d'archi à prendre (détermine la part front)

### Option A — Cookie same-origin *(recommandée : la plus simple)*
Servir front + gateway **sous un même origin** (reverse proxy en prod ; proxy
Vite en dev). Le cookie de session `httpOnly` part alors **tout seul** sur le
handshake WS → la gateway le lit comme sur une route HTTP normale.
- **Gateway** : valider la session au handshake, rejeter (401/close) sinon.
- **Front** : connecter le WS sur le **même origin** (`/ws`) au lieu de `:3001` en
  dur, + config proxy. **Quasi rien d'autre.**

### Option B — Ticket court
Le front demande un **ticket** signé à durée de vie courte via REST
(`GET /api/ws-ticket`, authentifié), puis connecte `ws://…/ws?ticket=…`.
- **Gateway** : émettre + valider le ticket (signé, ~30 s, lié au user).
- **Front** : récupérer le ticket avant chaque (re)connexion, l'attacher à l'URL,
  gérer l'expiration/reconnexion. **Plus de travail front.**
- Utile si on ne peut pas garantir le same-origin.

➡️ **Reco : Option A** (same-origin + proxy). On bascule en B seulement si le
déploiement impose du cross-origin non maîtrisé.

## Répartition des tâches

### Gateway (chat infra) — le gros
- [ ] **Auth handshake** : à l'ouverture du WS, résoudre l'utilisateur depuis le
      cookie de session (réutiliser la logique `requireAuth` / résolution de session
      existante). Refuser proprement si pas de session valide.
- [ ] **Filtrage RBAC par socket** : pour chaque socket, ne forwarder un message
      `tags.raw` que si le tag est couvert par un **grant `read`** de l'utilisateur
      (mêmes règles de préfixe `site.ligne.machine` que le reste du RBAC).
- [ ] (Option B uniquement) endpoint `GET /api/ws-ticket` + validation du ticket.
- [ ] *Prépare la Phase C alarmes* : une fois le WS authentifié+filtré, pousser
      aussi les **transitions d'alarme** filtrées (canal/type dédié — voir plus bas).

### Front (ici) — le raccord
- [ ] Connecter le WS sur le **même origin** : remplacer le `:3001` en dur de
      `web/src/useRealtimeBuffers.ts` (`${proto}://${location.host}/ws`) ; garder
      `VITE_WS_URL` comme override.
- [ ] **Proxy dev** : config Vite `server.proxy` pour `/ws` → `localhost:3001`
      (`ws: true`). (Prod : c'est le reverse proxy qui route `/ws`.)
- [ ] Gérer le **WS rejeté** (auth KO) : état « déconnecté », reconnexion raisonnée.
- [ ] (Option B) récupérer le ticket avant connexion + le réattacher à la reco.

## Lien avec les alarmes (Phase C)
Aujourd'hui les alarmes passent par **polling REST** (`/api/alarms`, ~7 s) **exprès**
pour ne pas dépendre de ce chantier. Une fois `/ws` sécurisé, on pourra **pousser
les alarmes en temps réel** sur le même socket (filtré RBAC) — le front a juste à
consommer un message typé `{ type: "alarm", ... }` (ou un `/ws/alarms` dédié). À
décider au moment de la Phase C.

## Test (quand c'est fait)
- Sans session → la connexion WS doit être **refusée**.
- Avec un user limité (ex. droit `read` sur `brasserie.blonde` seulement) →
  l'Explorer ne reçoit **que** les tags `brasserie.blonde.*`, pas les autres.
- Admin (`*`) → reçoit tout, comme avant.

## Repères code
- WS gateway : `gateway/src/index.ts` (plugin `@fastify/websocket`, broadcast `tags.raw`).
- WS front : `web/src/useRealtimeBuffers.ts` (construction de l'URL `…:3001/ws`).
- Résolution de session : `gateway/src/auth.ts` / hook de résolution user existant.
