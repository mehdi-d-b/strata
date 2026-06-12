# Strata — Intégration d'un LLM (assistant / copilote)

> Document d'aide à la décision et de cadrage. Comment brancher un assistant IA
> sur Strata **proprement** : ce qu'est MCP, l'architecture, MCP vs RAG, les
> niveaux d'usage, la sécurité (règle d'or), et un plan d'adoption progressif.
> Aucune implémentation n'existe encore — c'est la cible. Voir aussi la roadmap P9.

## Décisions techniques actées (2026-06) — 100 % LOCAL, agent in-app

Tranché : **assistant 100 % local / open-source, aucun cloud, aucun service payant.**

- **Runtime** : **Ollama** (démarrer) puis **vLLM** (montée en charge) — exposent une **API
  compatible OpenAI** (`/v1/chat/completions`). « Compatible OpenAI » = un **format de
  requête standard de fait**, **pas** une connexion à OpenAI : tout tourne en local, aucune
  donnée ne sort. Avantage : pas de lock-in (swap de runtime sans changer le code).
- **Modèle** : open-weights avec **tool-calling** natif (**Qwen2.5**, Llama 3.1/3.3). Taille
  selon le matériel (7-8B sur CPU/GPU grand public = Q&A simple ; 70B sur vrai GPU = raisonnement
  multi-étapes fiable). ⚠️ Un petit modèle local est plus faible qu'un frontier sur les
  enchaînements de tools → commencer par du **Q&A en lecture**.
- **Architecture choisie = « Chemin B » (agent in-app)** : un **backend agent dans la gateway**
  (`POST /api/assistant/chat`) qui appelle Ollama avec les tools et **exécute les tools avec la
  session de l'utilisateur connecté** → le LLM hérite **automatiquement de son RBAC + audit**.
  L'**UI chat = côté front** (chat dédié).
- **Pas de MCP pour ce chemin** : MCP sert surtout aux **clients externes** (Claude Desktop,
  Open WebUI). En in-app, les tools sont définis **dans la gateway** (appels internes) → un étage
  et un hop en moins. MCP reste **ajoutable plus tard** si on veut exposer Strata à un client externe.
- **Pas de LangChain** : la boucle d'agent (message → tool calls → exécution → réponse) fait
  **~150 lignes** en TS contre l'API compatible-OpenAI. On garde le contrôle, pas de grosse
  dépendance à breaking changes.
- **Déploiement** : profil Docker **`ai`** (container `ollama` + l'agent dans la gateway ;
  poids du modèle = un volume `ollama pull`). Le launcher gagne une case (cf. launcher-plan §10).
- **RAG (plus tard, si besoin doc métier)** : **100 % local aussi** — `pgvector` (déjà ton
  Postgres) + un modèle d'**embeddings local** (`bge-m3`, `nomic-embed-text` via Ollama).

Le reste du document (règle d'or, niveaux d'usage, sécurité) **reste valable** — seul le runtime
passe de « cloud ou local » à **local**, et on **commence sans MCP** (Chemin B).

## 0. La règle d'or (non négociable)

**Le LLM est UN UTILISATEUR DE PLUS.** Il accède aux données et actions de Strata
**uniquement via l'API de la gateway** (REST), avec un **compte et des droits RBAC**,
et tout passe par l'**audit**. Il ne tape JAMAIS directement TimescaleDB, Redpanda ou
RisingWave.

Pourquoi c'est vital : toute la sécurité de Strata (auth, RBAC par préfixe de tag,
journal d'audit) vit dans la gateway. Court-circuiter l'API = perdre auth + droits +
traçabilité. Donc un agent qui « voit » la base en direct est interdit ; un agent qui
appelle `GET /api/history` avec le compte « assistant-ligne-blonde » est parfait — il
hérite automatiquement des mêmes limites qu'un opérateur humain.

## 1. C'est quoi MCP (Model Context Protocol)

MCP est un **standard ouvert** (Anthropic, 2024) qui permet à un LLM d'utiliser des
**outils** (tools) et des **ressources** exposés par un serveur. Au lieu de coder « en
dur » comment l'IA parle à ton système, tu écris un **serveur MCP** qui *déclare* des
fonctions ; n'importe quel client LLM compatible MCP (Claude Desktop, IDE, agent
custom…) peut alors les appeler.

Analogie : MCP est aux LLM ce qu'un **driver** est à un OS. Tu écris le driver une fois
(le serveur MCP « Strata »), et tous les LLM compatibles savent s'en servir.

Un serveur MCP expose typiquement :
- des **tools** : des actions/fonctions (ex. `get_tag_history`, `list_active_alarms`,
  `get_production`) — l'IA les appelle avec des arguments, reçoit un résultat ;
- des **resources** : des données contextuelles lisibles (ex. la liste des tags, la
  description des lignes) ;
- des **prompts** : des gabarits réutilisables (optionnel).

## 2. Architecture d'intégration dans Strata

```
        ┌─────────────┐      MCP       ┌──────────────────┐    HTTP/REST   ┌──────────┐
  LLM ──│ client MCP  │ ◀───tools────▶ │ serveur MCP      │ ─────────────▶ │ gateway  │
 (local │ (Claude     │                │ « Strata »       │  (compte +     │ (RBAC +  │
  ou    │  Desktop,   │                │ wrappe les API   │   cookie de    │  audit)  │
  API)  │  agent…)    │                │ gateway en tools │   session)     └────┬─────┘
        └─────────────┘                └──────────────────┘                     │
                                                                    Timescale / Redpanda / RisingWave
```

Points clés :
- Le **serveur MCP** est un petit service (Node/Python, container de plus, **sans JVM**).
  Il ne contient PAS de logique métier : il **traduit** des tools MCP en appels HTTP à la
  gateway, avec un compte de service Strata (donc RBAC + audit).
- Le **LLM local** (option) : Ollama / vLLM dans un container, pour rester on-premise
  (usine sans cloud). Ou une API (Claude) si le cloud est acceptable.
- Strata **ne change pas** : on réutilise les routes existantes (`/api/history`,
  `/api/production`, `/api/alarms`, et `/api/command` pour les actions). C'est tout
  l'intérêt des contrats stables qu'on a bâtis.

### 2.1 Où vit le LLM ? (déploiement & launcher)

Deux scénarios de déploiement, et la frontière **in-band / out-of-band** (cf.
[launcher-plan.md](launcher-plan.md)) les tranche proprement :

- **LLM local** (Ollama/vLLM — usine sans cloud) = **un container** → un **profil
  Docker** dédié (`--profile ai`), au même titre que `plc4x` ou `risingwave`. Le
  **serveur MCP** est un autre petit container sous ce même profil.
- **LLM cloud** (API Claude) = **aucun container**, juste une **clé/config** côté
  gateway/MCP → rien à lancer.

**Conséquence : le launcher est déjà prêt.** Comme il gère les profils de façon
générique, ajouter l'assistant = **une entrée** dans sa liste de profils
(`{ id: "ai", … }`) → une case à cocher apparaît, avec start/stop/santé gratuits.
Aucun câblage en dur (payoff du design générique des profils).

Répartition des responsabilités (la même règle que pour le reste du launcher) :

| Côté **launcher** (cycle de vie infra, out-of-band) | Côté **app / gateway** (données métier, in-band) |
|---|---|
| démarrer/arrêter le service LLM + serveur MCP (profil `ai`) | quel modèle utiliser, prompts, configuration RAG |
| **présence des poids** du modèle (`ollama pull …`, comme une image/un volume) | **compte RBAC** de l'agent + audit |
| voyant de santé du container LLM | périmètre de tags autorisé à l'assistant |

Sur **figer un seul modèle vs en proposer plusieurs** : avec MCP, les *tools* sont
**agnostiques au modèle** (n'importe quel client MCP les appelle) → le **choix du
modèle peut rester configurable** sans tout figer. Ce qui est réellement lié à un
modèle donné, c'est l'**embedding du RAG** (changer d'embeddings ⇒ réindexer les
docs) — à garder en tête si/quand on fait du RAG (§3).

## 3. MCP vs RAG — ne pas confondre

Ce sont deux briques **orthogonales et complémentaires** :

| | MCP (tools) | RAG (documents) |
|---|---|---|
| Donne accès à… | les **données live** de Strata (tags, alarmes, prod) | des **documents** (manuels, procédures, historique maintenance) |
| Mécanisme | l'IA **appelle des fonctions** (ton API) | l'IA **cherche dans un index vectoriel** puis lit des extraits |
| Besoin d'abord ? | **OUI** — c'est le cœur de l'utilité dans Strata | **NON** — optionnel, vient après |
| Exemple de question | « température moyenne du fermenteur ce shift ? » | « comment réarmer le défaut F12 sur la presse ? » |

**Conclusion : commencer par MCP, pas par RAG.** Le premier besoin est d'accéder aux
données temps réel/historiques — c'est MCP + les API. Le RAG ne devient utile que pour
répondre sur de la **documentation métier** (manuels machine, modes opératoires). On
l'ajoute *seulement si* ce cas d'usage est demandé. Beaucoup de valeur sans RAG.

Si on fait du RAG plus tard : un **vector store** (pgvector dans Postgres/Timescale, ou
Qdrant) + un pipeline d'ingestion des docs. Brique séparée, ne touche pas au cœur Strata.

## 4. Niveaux d'usage (du plus utile/simple au plus ambitieux)

1. **Copilote de questions (lecture seule)** — le meilleur rapport valeur/effort.
   L'IA répond en langage naturel en appelant les routes de lecture. Compte de service
   en **lecture seule** (RBAC). Ex : « combien d'alarmes critiques aujourd'hui ? »,
   « montre la tendance de température IPA sur 1 h ». **Le nommage métier
   `site.ligne.machine.mesure` rend les tags auto-explicatifs** pour le LLM — gros
   avantage gratuit.

2. **Analyste d'anomalies (lecture + RisingWave)** — synergie avec ce qui existe.
   RisingWave fournit les **faits** (anomalies détectées, stats glissantes) ; l'IA les
   **explique** en croisant plusieurs tags : « le rebut blonde a grimpé car l'empâtage
   est sorti de plage il y a 10 min ». Les données pré-agrégées/nommées sont exactement
   ce qu'un LLM exploite bien (vs des millions de points bruts).

3. **Assistant d'action (écriture, ENCADRÉ)** — puissant mais sensible.
   L'IA peut *proposer* une consigne (`POST /api/command`), mais avec un compte aux
   droits `write` **restreints** et idéalement une **confirmation humaine** avant
   exécution. Le RBAC + l'audit existants couvrent déjà le risque ; ne jamais donner un
   compte `admin` à un agent.

4. **RAG sur docs internes (optionnel)** — pour les questions sur la documentation.
   Manuels, procédures, historique d'interventions. Se combine avec les niveaux 1-2.

## 5. Sécurité — checklist

- [ ] L'agent a un **compte Strata dédié** (pas un compte humain), nommé (ex.
      `assistant`), traçable dans l'audit.
- [ ] Droits **minimaux** : lecture seule par défaut ; `write` seulement si nécessaire
      et **scopé** à un périmètre (préfixe de tag).
- [ ] Toute action passe par l'**API gateway** (jamais d'accès direct base/broker).
- [ ] Les **écritures** (consignes) requièrent idéalement une **validation humaine**.
- [ ] Le serveur MCP ne stocke pas de secret en clair ; il s'authentifie auprès de la
      gateway comme n'importe quel client (session/cookie ou token de service).
- [ ] LLM **local** (Ollama/vLLM) si les données ne doivent pas sortir du site.

## 6. Plan d'adoption proposé

1. **Pré-requis (déjà en place ✅)** : API REST stable, RBAC par tag, audit, nommage
   métier, RisingWave pour les faits temps réel. Strata est **déjà prêt** à accueillir un
   agent — c'est le bénéfice des contrats stables.
2. **MVP** : un serveur MCP exposant 3-4 tools de **lecture** (`get_tags`,
   `get_tag_history`, `list_alarms`, `get_production`) → branché sur un client LLM. Compte
   de service lecture seule. Prouve la valeur (copilote de questions) sans aucun risque.
3. **Étendre** : tool d'**explication d'anomalie** (lit RisingWave via la gateway).
4. **Action encadrée** : tool d'écriture de consigne avec confirmation + droits restreints.
5. **RAG** : seulement si le besoin « questions sur la doc métier » émerge.

## 7. Pourquoi Strata est bien placé pour ça (récap)

- **Contrats stables** (`tags.raw`, API REST) → l'agent se branche sans refonte.
- **Nommage métier** → les tags sont auto-descriptifs, l'IA comprend `brasserie.ipa.fermenteur.temperature` sans dictionnaire.
- **RBAC + audit** → l'agent est sécurisé et traçable *gratuitement*, comme un utilisateur.
- **RisingWave** → fournit des faits agrégés/anomalies, le bon niveau d'abstraction pour un LLM.
- **Sans JVM, Docker Compose** → le serveur MCP + un LLM local sont juste « des containers de plus ».

**En une phrase** : grâce aux fondations (API + RBAC + nommage + RisingWave), intégrer un
LLM utile = écrire un **serveur MCP qui wrappe l'API existante** et lui donner un **compte
de service à droits minimaux**. Commencer par un copilote de lecture ; le RAG est optionnel
et ultérieur.
