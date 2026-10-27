# `ai-service` — référence technique complète

> Checkpoint détaillé de l'état réel du microservice IA de Strata, à date. Ce
> document décrit **ce qui existe et tourne**, fichier par fichier, décision
> par décision — pas un plan, pas une intention. Pour l'historique de comment
> on en est arrivé là (étapes, essais, erreurs corrigées), voir
> [roadmap.md](roadmap.md) et [assistant-roadmap.md](assistant-roadmap.md).
> Ce fichier-ci est la photo du système, pas son journal.

## 1. Vue d'ensemble

`ai-service` est un microservice Python (FastAPI + LangGraph) qui porte tout
le chat/RAG/agent de Strata. Il tourne à côté de la `gateway` (Node/TS,
inchangée par ailleurs) et lui parle exclusivement en HTTP.

**Invariant central, non négociable** : `ai-service` n'a **aucun accès
direct** à Postgres ni à Kafka. La seule porte d'entrée vers les données est
la gateway HTTP — `ai-service` s'y comporte comme n'importe quel client
externe, authentifié par un compte de service dédié (§7). Cette frontière est
répétée dans les docstrings de `gateway.py`, `graph.py`, `ingest.py` : ce
n'est pas un détail, c'est LA raison d'être du découpage en microservice.

**Stack** :
- **FastAPI** — sert `/health` et `/ingest/pdf`, monté à côté du serveur
  LangGraph via `langgraph.json` (`http.app`).
- **LangGraph** (`langgraph-cli[inmem]`) — sert le graphe de conversation lui-
  même via le protocole natif LangGraph Platform (`/threads`, `/runs/stream`).
  C'est le process qui tourne en continu (`langgraph dev --no-reload`), pas
  un outil de debug ponctuel.
- **LangChain** (`langchain-ollama`, `langchain-core`) — wrapper autour
  d'Ollama pour le tool-calling structuré.
- **Ollama** (local, 100% offline) — deux modèles : `qwen3.5:9b` pour le chat/
  raisonnement, `embeddinggemma` pour les embeddings. Plus un reranker
  cross-encoder (`BAAI/bge-reranker-v2-m3`, via `transformers`, §6.1).
- **Docling** — extraction + découpage structuré des PDF ingérés (§6.3).

## 2. Le graphe (`graph.py`)

### 2.1 Structure

```
init (calcule factory_context/recipes)
  │
  ├─ forced_batch        (si diagnostic de batch détecté)  ──┐
  ├─ forced_line_blocked  (si ligne bloquée détectée)        ├──► agent
  └─ agent                (sinon, directement)               ┘
                                                               │
        ┌──────────────────────────────────────────────────────┤
        │                                                       │
        ▼                                                       ▼
  write_intercept (tool(s) d'écriture)              tools (tool(s) de lecture)
  → un interrupt() par action, jamais exécuté ici    → ToolNode(READ_TOOLS)
        │                                                       │
        └──────────────────► agent (boucle) ◄────────────────────┘
                              │
                              ▼
                    END (pas de tool call) / max_steps (10 tours atteints)
```

`build_graph(checkpointer=None)` compile ce graphe. Sans checkpointer explicite
pour l'instance module-level `graph` (utilisée à la fois par LangGraph Studio
et par le serveur `langgraph dev` lui-même, qui gère SA PROPRE persistance
in-memory et refuse un checkpointer custom à la compilation).

### 2.2 État (`AgentState`, `TypedDict`)

| Champ | Type | Rôle |
|---|---|---|
| `messages` | `Annotated[list[AnyMessage], add_messages]` | historique complet, réducteur standard LangGraph |
| `recipes` | `list[str]` | `["blonde", "ipa", "jalapeno"]`, calculé une fois par `init` |
| `factory_context` | `str` | contexte usine textuel injecté dans le system prompt |
| `steps` | `Annotated[int, operator.add]` | compteur de tours, réducteur additif |
| `pending_action` | `dict \| None` | vestige — posé/effacé mais **jamais lu** par le front ni par la logique de routage (le front lit `interrupt.value`, pas cet champ d'état) |

### 2.3 Les nœuds

- **`_init_node`** — inconditionnel, en tête. Appelle
  `context.build_factory_context()` (→ `GET /api/factory-context` sur la
  gateway) pour peupler `factory_context`/`recipes`. Nécessaire car le
  protocole LangGraph standard parlé par assistant-ui n'a aucun moyen
  d'injecter des champs d'état custom au premier message — contrairement à
  l'ancien `/chat` fait main (aujourd'hui supprimé) qui les posait
  directement.

- **`_route_entry`** — routage conditionnel après `init`. Regarde le dernier
  message humain : `detect_batch_diagnostic` (routing.py) en premier, sinon
  `detect_line_blocked`, sinon `agent` directement. Un seul routage forcé
  actif à la fois (le batch a priorité si les deux matchent).

- **`_forced_batch_node`** — playbook diagnostic de batch. Appelle
  `get_batch_context` puis, si le batch n'est pas conforme,
  `search_knowledge` avec une requête construite depuis le **défaut réel**
  (`build_knowledge_query`, jamais une déviation supposée par le modèle).
  Injecte ces deux appels comme de vrais tour de `AIMessage`+`ToolMessage`
  dans l'historique — le modèle voit un dossier déjà constitué, il n'a plus
  qu'à corréler/conclure.

- **`_forced_line_blocked_node`** — même principe pour « ma ligne est
  bloquée ». Force `get_line_status(line)` + `search_knowledge(query="ligne
  bloquée {line} panne attente embouteilleuse")`. Si `detect_line_blocked` ne
  trouve pas de ligne (ex. « ma ligne est bloquée » sans préciser laquelle),
  retourne `{}` — pas de faux routage, le modèle demandera lui-même de
  préciser.

- **`_agent_node`** — le tour ReAct standard : `ChatOllama(...).bind_tools(
  ALL_TOOLS)`, invoqué avec `[SystemMessage(prompt+contexte), *messages]`.
  `temperature=0.2` (une valeur plus haute rend l'appel d'outil moins fiable,
  observé en local), `num_ctx=8192` (l'API `/v1` OpenAI-compat d'Ollama
  ignore `num_ctx` et retombe à ~2048, source de troncatures déjà rencontrées
  — d'où l'appel direct à l'API native `/api/chat` via `ChatOllama`, pas
  `/v1/chat/completions`).

- **`_route_after_agent`** — `steps >= MAX_STEPS` (10) → `max_steps`. Sinon :
  pas de tool call → `end` ; au moins un tool d'écriture dans l'appel → tout
  le message part vers `write_intercept` (même s'il y a AUSSI des tools de
  lecture dans le même message — limite connue, cf. §9) ; sinon → `tools`.

- **`write_intercept`** — cf. §3, le cœur du modèle d'exécution.

- **`tools`** — `ToolNode(READ_TOOLS)` standard LangChain, exécute
  directement les tools de lecture (aucune confirmation nécessaire).

- **`_max_steps_node`** — message de repli si la boucle a tourné 10 fois sans
  conclure.

### 2.4 Le prompt système (`SYSTEM_PROMPT_STATIC`)

Un seul bloc de texte, en français, avec des règles **comportementales**
uniquement — aucune connaissance de domaine n'y est codée en dur (ça, c'est le
rôle du RAG, §6). Règles principales :
- Réponses concises, précises, jamais de valeur inventée (toujours passer par
  un tool pour un chiffre).
- Protocole batch : lire `conforme` en premier, ne jamais inventer de défaut,
  `cuves_hors_bande` est la seule source de vérité pour accuser une cuve.
- Router vers `search_knowledge` en premier pour toute question procédurale
  ("comment", "que faire"...).
- Pour agir : `request_operation` / `adjust_setpoint` / `ack_alarm`
  uniquement sur demande explicite, jamais deviner un tag/valeur/séquence
  PLC — la gateway valide tout après confirmation humaine.
- Si plusieurs actions similaires sont demandées en une phrase, proposer
  TOUS les tool calls d'écriture en une seule réponse (chacun confirmé
  séparément).

⚠️ **Deux tentatives de règles plus fines ont été testées en direct et ont
échoué** avec `qwen2.5:7b` : (1) "vérifie le schéma avant de deviner un tag",
(2) "appelle search_knowledge avant toute action de pilotage". Dans les deux
cas, le modèle a ignoré l'instruction et proposé un tag halluciné. Conclusion
opérationnelle : une règle de prompt conditionnelle n'est PAS fiable sur ce
modèle pour ce genre de décision — d'où le choix d'un routage **forcé en
code** (`_forced_line_blocked_node`) plutôt qu'une énième reformulation de
règle, et d'un catalogue d'opérations à schéma fermé (§3) plutôt qu'un outil
à tag libre.

## 3. Modèle d'exécution des écritures (HITL)

### 3.1 Principe : propose → confirme → exécute, jamais côté `ai-service`

`ai-service` ne touche jamais Postgres/Kafka, et son compte de service
(`assistant-service`, §7) est volontairement **lecture seule** — même s'il
voulait exécuter une écriture, il n'en a pas les droits. L'exécution réelle a
lieu **côté navigateur**, avec la vraie session de l'opérateur qui discute,
via les routes gateway déjà protégées par le RBAC existant.

Séquence complète :
1. Le modèle propose un tool d'écriture (`request_operation`,
   `adjust_setpoint`, `ack_alarm`) — jamais exécuté (chaque outil, dans
   `tools.py`, retourne littéralement une erreur s'il est appelé
   directement : garde-fou de code, pas seulement de convention).
2. `_route_after_agent` détecte le tool call et route vers
   `write_intercept`.
3. `_write_intercept_node` boucle sur TOUS les appels d'écriture du message
   (pas juste le premier — cf. §3.4), et pour chacun : construit un résumé
   humain (`_summarize_write`), puis `interrupt(pending_action)` — suspend le
   graphe, exposé par le serveur LangGraph comme un interrupt standard.
4. Le front (`InterruptCard`, `web/src/AssistantView.tsx`) affiche
   `interrupt.value.summary` avec deux boutons.
5. **Sur "Confirmer"** : le front appelle DIRECTEMENT la route gateway
   correspondante (`executeOperation`/`adjustSetpoint`/`ackAlarm` dans
   `web/src/api.ts`), avec le cookie de session réel de l'utilisateur. La
   gateway revérifie le RBAC (`can(user,"write",tag)`) et applique ses
   propres garde-fous métier (§3.2, §3.3).
6. Le résultat réel (succès/échec + message) est renvoyé au graphe via
   `sendCommand({resume: JSON.stringify({confirmed, ok, error?})})` — la
   reprise contient donc le VRAI résultat, pas une confirmation aveugle.
7. `_parse_write_decision` décode ce JSON (tolérant aussi aux formats bruts
   string/dict pour les tests directs), et `_write_intercept_node` construit
   un `ToolMessage` fidèle : "..., c'est fait." / "Échec : ... (raison)." /
   "Action annulée." — jamais de texte de simulation codé en dur.
8. Le graphe boucle vers `agent` (pas `END`) : le modèle voit le résultat
   réel dans l'historique et formule une réponse finale cohérente, pouvant
   enchaîner d'autres actions si plusieurs étaient demandées.

⚠️ **Détail d'implémentation non-évident** : le type `resume` exposé par
`useLangGraphSendCommand()` (package `@assistant-ui/react-langgraph`) est
typé `string` seulement — pas le vrai protocole LangGraph, qui accepte
n'importe quelle valeur JSON. Le front encode donc l'objet en JSON string
avant de l'envoyer, et `_parse_write_decision` le décode côté Python. Sans
ça : erreur de type TypeScript à la compilation si on essaie de passer un
objet directement.

### 3.2 Le catalogue d'opérations (`request_operation`)

Remplace un ancien tool générique `set_command(tag, value)` (retiré) qui
laissait le modèle choisir un tag PLC arbitraire — source de tags hallucinés
en pratique (ex. `brasserie.blonde.ebullition.state` au lieu du vrai
`running_tag` de la ligne, ou `brasserie.blonde.state`, un tag qui n'existe
même pas). `request_operation(operation_id: Literal["start_line",
"stop_line"], line: str)` : le modèle ne choisit qu'un **identifiant
d'opération métier** dans un enum fermé, jamais un tag.

Résolution côté gateway (`POST /api/operations/execute`,
`gateway/src/index.ts`) :
1. Valide `operation_id` contre `OPERATION_LABELS` (enum fermé, même liste
   que côté Python).
2. Résout le VRAI tag de commande via `oee_line.running_tag` (même
   convention que la page Production → Pilotage, qui utilise désormais la
   MÊME route — front chat et front manuel appliquent les mêmes garde-fous).
3. Revérifie `can(user, "write", running_tag)` avec la VRAIE identité de
   l'utilisateur.
4. **`stop_line` refuse (409) si un batch est encore en cours** sur la ligne
   (`SELECT id FROM batches WHERE line=$1 AND ended_at IS NULL`) — la
   précaution documentée dans le manuel ("ne pas interrompre un batch en
   cours") est **appliquée en code**, pas juste écrite dans une SOP que le
   modèle pourrait ignorer.
5. Idempotent : si la ligne est déjà dans l'état demandé, ne republie pas de
   commande inutile (`already_in_desired_state`).
6. Audite (`operation.execute`) avec le détail complet (operation_id, tag
   résolu, valeur, était-déjà-dans-l'état-demandé).

### 3.3 Ajustement de consigne (`adjust_setpoint`)

`adjust_setpoint(line: str, vessel: Literal["empateur","ebullition",
"fermenteur"], value: float)`. Même principe : la cuve est un enum fermé (les
3 seules qui existent réellement dans le simulateur, `brain.py::Recipe.
vessels`), la valeur numérique reste libre mais est **bornée côté gateway**
(`POST /api/operations/setpoint`) :
1. Résout le tag `{line}.{vessel}.temp_cible`, vérifie le RBAC.
2. Lit la consigne actuelle ET la tolérance publiée par le simulateur
   (`{line}.{vessel}.temp_tol`, tag réel, cf. `brain.py::Vessel.tags`).
3. **Refuse (409) tout écart de plus de ±2×tolérance** autour de la valeur
   actuelle — "changement de recette hors périmètre du chat". Empêche
   concrètement un modèle qui hallucine une valeur absurde (observé en test
   réel : demande d'augmenter la consigne de 2°C, le modèle a proposé 35°C
   pour un fermenteur qui tourne normalement à 12-14°C — la gateway a
   refusé avant toute écriture).
4. Audite (`operation.setpoint`) avec valeur précédente/nouvelle.

### 3.4 Enchaînement de plusieurs actions

`_write_intercept_node` boucle sur **tous** les tool calls d'écriture du
dernier message (pas seulement le premier — c'était une limite de l'ancienne
version). Chaque action obtient son propre `interrupt()` ; côté LangGraph,
plusieurs `interrupt()` dans un même nœud se rejouent dans l'ordre à chaque
`resume()` (mécanique standard du replay de checkpoint — aucune plomberie
custom nécessaire). Le front n'affiche donc qu'**une carte à la fois**, et
enchaîne naturellement à la suivante après chaque confirmation.

Le prompt encourage explicitement le modèle à proposer tous les tool calls
d'un coup si la demande le justifie ("acquitte ces deux alarmes") — validé en
direct : le modèle propose bien 2 `ack_alarm` en un seul message, chacun
confirmé séparément, réponse finale cohérente sur les deux résultats.

**Limite connue, non traitée** : si un message mélange un tool de LECTURE et
un tool d'ÉCRITURE, seuls les tools d'écriture sont traités par
`write_intercept` — le tool de lecture resterait sans `ToolMessage`
correspondant. Non observé en pratique avec Ollama/qwen (qui ne mélange pas
les deux types dans un même message), donc pas corrigé.

## 4. Catalogue des tools (`tools.py`)

Tous les tools appellent la gateway en HTTP (jamais Postgres/Kafka
directement). `WRITE_TOOLS = {"request_operation", "adjust_setpoint",
"ack_alarm"}` ; `READ_TOOLS = ALL_TOOLS - WRITE_TOOLS`.

| Tool | Route gateway | Rôle |
|---|---|---|
| `get_oee` | `GET /api/oee` | OEE (A×P×Q) par ligne/shift sur N jours |
| `get_production` | `GET /api/production` | production par shift (ok/scrap/produced) |
| `list_alarms` | `GET /api/alarms` | alarmes actives ou non acquittées (plafonné à 20 — 601 alarmes ont fait déborder le contexte en pratique) |
| `get_history` | `GET /api/history` | tendance d'un tag, sous-échantillonné à ~20 points |
| `get_batch_context` | `GET /api/batches/:ref/context` | dossier complet d'un batch (verdict, déviations, alarmes, CIP) |
| `describe_schema` | `GET /api/schema` | catalogue tables/colonnes (avec commentaires SQL, cf. §4.1), pour `query_readonly` |
| `query_readonly` | `POST /api/query-readonly` | SQL libre en lecture seule (rôle Postgres `strata_ro`, transaction READ ONLY, timeout, LIMIT 500) |
| `search_knowledge` | `POST /api/knowledge/search` | RAG hybride (§6) |
| `get_line_status` | `GET /api/lines/status` | état temps réel machine par machine |
| `get_shift_summary` | `GET /api/oee` + `/api/batches` + `/api/alarms` | vue d'ensemble du shift en cours |
| `get_oee_breakdown` | `GET /api/oee` + `/api/oee/downtime` | cascade des pertes OEE |
| `get_active_batches` | `GET /api/batches` | batches non terminés |
| `request_operation` ✍️ | — (jamais exécuté ici) | proposition start/stop ligne, cf. §3.2 |
| `adjust_setpoint` ✍️ | — (jamais exécuté ici) | proposition ajustement consigne, cf. §3.3 |
| `ack_alarm` ✍️ | — (jamais exécuté ici) | proposition acquittement alarme |

### 4.1 Schéma auto-documenté

`GET /api/schema` (gateway) ne remonte pas seulement `nom:type` par colonne,
mais aussi les `COMMENT ON COLUMN` **déjà présents dans les migrations SQL**
(`col_description()`). Exemple concret : `oee_line.running_tag` porte déjà un
commentaire ("Tag d'état marche/arrêt. Convention canonique : valeur = 1
quand la machine tourne...") écrit dans `infra/timescale/init/09-oee.sql`
bien avant ce chantier — la gateway le fait maintenant remonter au modèle via
`describe_schema`. Principe : la documentation du schéma vit dans le schéma
lui-même, pas dans le prompt système ni dans le code de l'agent — un
commentaire SQL ajouté un jour est automatiquement visible, sans jamais
toucher à `ai-service`.

## 5. Playbooks forcés (`routing.py`)

Deux heuristiques légères (regex), même esprit : ne pas faire confiance au
modèle pour décider seul de la séquence d'investigation sur un cas à enjeu.

- **`detect_batch_diagnostic(text, recipes)`** — verbe de diagnostic
  (pourquoi/diagnostique/analyse/explique/cause) + (id de batch OU mot
  "batch/brassage/lot" OU (nom de recette + mot-clé qualité)). La mention
  seule d'une recette ne suffit pas : une recette est aussi un nom de ligne,
  la mention seule serait ambiguë avec une question d'état machine.
- **`detect_line_blocked(text, recipes)`** — mot-clé de blocage
  (bloqué/bouge plus/panne/bourrage/attente/arrêt inattendu) **ET** exactement
  UNE recette/ligne connue mentionnée. "Ma ligne est bloquée" (aucune ligne
  citée) retourne `None` délibérément — mieux vaut que l'agent demande de
  préciser que d'enquêter au hasard.
- **`build_knowledge_query(ctx)`** — construit la requête `search_knowledge`
  forcée après un `get_batch_context`, à partir du `defaut_type` RÉEL (jamais
  d'une déviation que le modèle aurait supposée lui-même). Retourne `None` si
  le batch est conforme (rien à chercher).

## 6. RAG (base de connaissances)

### 6.1 Embedding

`embeddinggemma` (multilingue, 300M) via Ollama, **768 dimensions**. Même
modèle aux deux bouts, sinon les vecteurs ne seraient pas comparables, avec le
**préfixe de tâche** attendu par le modèle (`task: search result | query: `
pour une question, `title: none | text: ` pour un document) :
- `ai-service/embeddings.py::embed_document()` — à l'ingestion (Docling →
  chunks → embed → upsert, avec `embed_model`).
- `gateway/src/embeddings.ts::embedQuery()` — à la requête (`search_knowledge`).

Choisi le 2026-10-27 sur une éval de recherche (dense seule) sur le corpus
réel : 27 questions reformulées façon opérateur, chunks pertinents connus.
Bon chunk dans le top 5 : `nomic-embed-text` (l'ancien modèle, entraîné sur de
l'anglais, sans préfixes) 74 % ; avec préfixes 85 % ; `bge-m3` 96 % ;
`qwen3-embedding:0.6b` 96 % ; `embeddinggemma` 100 % (85 % en 1re position).

**Changement de modèle** : la colonne `knowledge.embed_model` trace le modèle
de chaque vecteur ; au boot, la gateway ré-embedde tout chunk dont
`embed_model ≠ EMBED_MODEL` (`reembedStaleKnowledge`) à partir de `body`
(le texte exact embeddé à l'ingestion). Changer de dimension (≠ 768)
demanderait en plus de migrer la colonne `vector(768)`.

**Reranker** (`ai-service/reranker.py`) : `search_knowledge` demande 10
candidats à la gateway (`limit`), un cross-encoder (`BAAI/bge-reranker-v2-m3`,
multilingue) note chaque paire (question, chunk) lue ensemble, on garde les 5
meilleurs. Sur la même éval : 1re position 85 % → 93 %. Coût ~4 s par
recherche dans Docker (CPU, pas de GPU Metal), linéaire en nombre de
candidats — d'où 10 et pas 20 (8 s) ; modèle (~2,3 Go) téléchargé depuis Hugging Face au premier
appel (volume `hf-cache`). Indisponible → ordre RRF conservé (dégradé, pas en
panne). Désactivable avec `RERANK_MODEL=` (vide).

### 6.2 Stockage et recherche : hybride dense + lexical, fusion RRF

Pas de base vectorielle dédiée — `pgvector` dans le TimescaleDB déjà utilisé
par tout le projet. Table `knowledge` (`category`, `title`, `body`,
`embedding vector(768)`), deux index :
- `knowledge_embedding_idx` — HNSW, `vector_cosine_ops` (dense).
- `knowledge_fts_idx` — GIN, `to_tsvector('french', title || ' ' || body)`
  (lexical, plein texte français).

`POST /api/knowledge/search` (gateway) fusionne les deux classements par
**Reciprocal Rank Fusion** (constante standard k=60) :
```sql
score = COALESCE(1.0/(60+rang_dense), 0) + COALESCE(1.0/(60+rang_lexical), 0)
```
via une requête à base de CTE (`dense`, `lexical`, `fused`), `FULL OUTER
JOIN` sur l'id du chunk, top `limit` retournés (5 par défaut, 10 quand
ai-service reclasse ensuite avec le reranker). Chaque résultat porte une `source`
identifiable (`id`, `category`, `title`) — permet d'afficher une citation
côté futur front si besoin, pas exploité pour l'instant.

⚠️ Les scores RRF sont petits par construction (max théorique ~0.033, un
chunk classé #1 dans les deux listes) — ne pas les comparer à une similarité
cosinus brute (échelle 0-1). C'est un score de FUSION/classement relatif, pas
une mesure de confiance absolue.

### 6.3 Ingestion : Docling (`ingest.py`)

**Deux points d'entrée**, même fonction `ingest_pdf_bytes(filename, data:
bytes)` :
- CLI : `uv run python ingest.py` — relit tout `knowledge-pdfs/*.pdf`.
- HTTP : `POST /ingest/pdf` (main.py) — appelé par la gateway
  (`POST /api/knowledge/upload`, page Admin), qui relaie le fichier reçu du
  front (FileReader → base64) en base64.

Pipeline : `DocumentStream` (bytes en mémoire, pas de fichier temporaire) →
`DocumentConverter.convert()` (OCR et extraction de tableaux **désactivés** :
nos PDF sont du texte natif, jamais scanné, inutile de charger ces modèles)
→ `HybridChunker.chunk()` → `chunker.contextualize()` (préfixe chaque chunk
du fil de titres parents — pas `chunk.text` brut) → `embed()` → `POST
/api/knowledge/ingest` (upsert, `ON CONFLICT (category, title) DO UPDATE`,
titre = `"<fichier> — chunk i/N"`, catégorie toujours `manuel`).

**Pourquoi Docling et pas pypdf + découpage par taille** (approche initiale,
abandonnée après l'avoir testée en vrai) : pypdf n'a aucune notion de mise en
page — un titre en gras et son corps ne sont qu'un flux de caractères
identique. `RecursiveCharacterTextSplitter` (découpage par taille de
caractères) recolle alors arbitrairement page de garde, titres et contenu de
plusieurs fiches dans un même chunk. Vérifié en direct sur ce projet : pour
la requête "comment débloquer une embouteilleuse en attente", la bonne fiche
ne remontait même plus dans le top 5 (diluée dans un chunk mêlant page de
titre + section suivante). Un premier correctif (marqueur de structure
invisible imprimé dans le PDF, texte blanc 1pt) a fonctionné mais ne
profitait qu'aux PDF générés par nous-mêmes — inutile pour un vrai manuel
uploadé par un admin. Docling comprend la mise en page nativement (modèle de
détection de layout) et résout le problème pour N'IMPORTE QUEL PDF, pas
seulement les nôtres.

**Coût mesuré, pas supposé** :
- Dépendance lourde assumée : `docling` tire `torch`/`torchvision`/
  `transformers` (~100 paquets additionnels).
- Piège rencontré : le résolveur par défaut choisit le wheel CUDA de
  `torch`, embarquant des bibliothèques NVIDIA totalement inutiles ici
  (aucun GPU) — image Docker montée à **8,91 Go**. Corrigé en forçant les
  wheels CPU via `[tool.uv.sources]` + un index PyPI dédié
  (`https://download.pytorch.org/whl/cpu`), avec `torch`/`torchvision`
  **explicitement listés** dans `dependencies` (un override `tool.uv.sources`
  sur un paquet purement transitif est silencieusement ignoré par uv). Image
  finale : **2,17 Go**. Torch et torchvision DOIVENT venir du même index
  (ABI liée) — un premier essai avec seulement `torch` forcé a cassé
  `torchvision` à l'import (`operator torchvision::nms does not exist`).
- Le modèle de mise en page (770 tenseurs) charge une fois en mémoire, au
  premier appel après le démarrage du conteneur (`_CONVERTER`/`_CHUNKER`
  sont des singletons module-level, jamais recréés par appel).
- Le premier téléchargement du modèle se fait depuis HuggingFace Hub — un
  téléchargement ponctuel (~qq dizaines de Mo), pas un appel cloud permanent
  : comparable à `ollama pull qwen2.5:7b`, pas à un appel API OpenAI/
  LangSmith (ces derniers explicitement écartés ailleurs dans le projet pour
  rester 100% local — la nuance a son importance et a fait débat).
- Docling est un appel **synchrone, CPU-bound**. Appelé nu dans une route
  async, `langgraph dev` (qui sert aussi `/ingest/pdf` via `main.py`) le
  détecte comme un appel bloquant de la boucle événementielle et fait
  échouer la requête HTTP (`blockbuster.BlockingError`) — invisible en CLI
  (pas de serveur ASGI, donc pas ce garde-fou), donc un bug qui n'est apparu
  qu'en testant la VRAIE route d'upload Admin, jamais en CLI. Corrigé :
  `_convert_and_chunk` isolée et appelée via `asyncio.to_thread(...)`.

### 6.4 Contenu actuel

3 PDF dans `knowledge-pdfs/`, tous catégorie `manuel` :
- `manuel-exploitation-brasserie.pdf` — généré par `generate_manual_pdf.py`
  (script gardé, dépendance `fpdf2` en `[dependency-groups] dev` uniquement).
  Porte les 22 fiches qui vivaient auparavant à la main dans
  `gateway/src/seed-knowledge.ts` (fichier **supprimé** — plus aucune
  connaissance métier écrite en dur dans le code de l'app, tout passe par le
  pipeline PDF générique, comme un vrai manuel d'automaticien).
- `manuel-groupe-froid.pdf`, `procedure-cO2-embouteilleuse.pdf` — PDF de démo
  antérieurs, contenu inventé mais non triviaux (tableaux/mise en page
  simples), conservés tels quels.

`gateway/src/seed-knowledge-pdf.ts` (ancien pipeline JS d'ingestion PDF,
`pdfjs-dist`) était déjà du code mort avant ce chantier — remplacé de longue
date par `ai-service/ingest.py`, jamais nettoyé jusqu'à cette session.
Supprimé avec `pdfjs-dist`/`@langchain/textsplitters` (plus aucun usage côté
gateway).

## 7. Sécurité

### 7.1 Compte de service dédié, lecture seule

`gateway/src/index.ts::seedAssistantService()` (exécutée au boot, migration-
safe même sur un volume Postgres déjà initialisé) crée :
- un rôle `assistant_service` avec un seul grant : `('*', 'read')` — jamais
  `write`, jamais `admin`.
- un compte `assistant-service`, mot de passe = `AI_SERVICE_PASSWORD` (var
  d'env dédiée, **distincte** de `ADMIN_PASSWORD` — ne réutilise jamais le
  secret admin).

`ai-service/gateway.py` s'authentifie avec ce compte (login + cookie de
session httpx, ré-auth automatique sur 401). Un endpoint technique
(`POST /api/knowledge/ingest`, le callback d'écriture de chunks) est gated
`requireAssistantService` — vérifie le rôle, pas juste `requireAuth`.

⚠️ **Piège rencontré** : `AI_SERVICE_PASSWORD` n'était déclaré QUE dans le
bloc `environment` du service `ai-service` de `docker-compose.yml` — pas
dans celui de `gateway`, qui a pourtant besoin de cette même valeur pour
CRÉER le compte. La gateway démarrait donc avec le warning "AI_SERVICE_
PASSWORD absent", ai-service ne pouvait jamais se logger. Trouvé en testant
en direct (pas en relisant le diff), corrigé en dupliquant la variable dans
les deux blocs.

### 7.2 Port non exposé à l'hôte

`ai-service` ne publie plus de port sur l'hôte (`ports:` retiré de son bloc
docker-compose) — seule la gateway (réseau Docker interne,
`http://ai-service:8000`) peut l'atteindre. Avant ce durcissement, le port
8000 était publié, permettant en théorie d'atteindre l'API LangGraph
directement depuis la machine hôte, en contournant totalement
l'authentification de la gateway. Conséquence assumée : LangGraph Studio
(cf. étape 5 du roadmap) n'est plus utilisable tel quel (il a besoin d'un
accès direct navigateur→ai-service) — l'onglet Admin correspondant explique
le compromis plutôt que de proposer un lien mort.

### 7.3 Appartenance des threads de conversation

Table `assistant_threads (thread_id TEXT PRIMARY KEY, user_id BIGINT
REFERENCES users, created_at)`. La création d'un thread passe désormais par
`POST /api/assistant/threads` (gateway, PAS un appel direct du front à
`ai-service`/proxy) — la gateway crée le thread côté LangGraph puis
enregistre `(thread_id, user_id)` avant de renvoyer l'id au front.

Toute requête ultérieure vers `/api/langgraph/threads/:id/...` (le reverse-
proxy `@fastify/http-proxy` vers `ai-service`) passe par
`requireOwnedAssistantThread` : vérifie que `thread_id` appartient bien à
`req.user.id`, sinon `404 "conversation introuvable"` (pas 403 — ne pas
confirmer l'existence du thread à qui ne le possède pas). Empêche un
utilisateur authentifié de deviner/reprendre la conversation (et les
interrupts en attente) d'un autre.

### 7.4 Aucune écriture libre

Résumé du fil rouge sécurité de ce chantier : plus aucun outil n'accepte un
tag ou une valeur PLC arbitraires (`set_command` supprimé). Chaque action
possible passe par un identifiant fermé (`operation_id` enum, `vessel`
enum) résolu et validé côté gateway, jamais par du texte libre interprété
par le modèle. Testé en conditions réelles : un modèle qui hallucine une
valeur (35°C pour un fermenteur à ajuster de 2°C) est bloqué par la gateway
avant toute écriture — le garde-fou est dans le code, pas dans le prompt.

## 8. Intégration frontend

- **assistant-ui** (`@assistant-ui/react`, `@assistant-ui/react-langgraph`)
  + **`@langchain/langgraph-sdk`** — parle le protocole natif LangGraph
  Platform, pas de couche de traduction AG-UI (contrairement à l'ancien
  CopilotKit, retiré — cf. roadmap.md étape 6bis pour l'historique complet
  de cette migration).
- `web/src/lib/chatApi.ts` — un `Client` unique (partagé avec
  `unstable_createLangGraphStream`), `apiUrl` construit en URL absolue
  same-origin (le SDK fait `new URL(apiUrl+path)` sans base, un chemin
  relatif fait planter le constructeur `URL` dans un navigateur — piège
  trouvé en testant, pas documenté par le SDK).
- `web/src/Layout.tsx` — monte `AssistantRuntimeProvider`/
  `useLangGraphRuntime` **une seule fois**, au niveau du layout (pas dans
  `AssistantView.tsx`) : sans backend "cloud" assistant-ui, la liste de
  threads vit en mémoire React et serait perdue à chaque démontage — testé
  en direct, la conversation ne survivait pas à un changement d'onglet tant
  que le runtime était monté au niveau de la vue.
- `web/src/AssistantView.tsx` — cf. §3.1 pour `InterruptCard`. `
  WriteActionResult` (rendu via `MessagePrimitive.Parts`'s prop `tools.
  by_name`) affiche le résultat de chaque action DIRECTEMENT depuis le
  `ToolMessage` déjà présent dans l'historique du thread — historique
  persistant gratuit (survit à la navigation, à un rechargement de thread),
  sans état client parallèle à maintenir.
- Reverse-proxy `@fastify/http-proxy` (`/api/langgraph` → `ai-service`),
  streaming géré nativement (pas de rejeu de corps à la main, contrairement
  à l'ancien runtime CopilotKit).

## 9. Limites connues, assumées

- Mélange lecture+écriture dans un même message modèle : seuls les tools
  d'écriture sont traités par `write_intercept`, cf. §3.4. Non observé en
  pratique, pas corrigé.
- `pending_action` dans `AgentState` : posé/effacé mais jamais lu nulle
  part (vestige d'une itération antérieure). Inoffensif, pas nettoyé.
- Pas de chunking sémantique/contextual retrieval au-delà de ce que fait
  Docling — pas jugé nécessaire vu la taille et la propreté actuelles du
  corpus (décision déjà actée avant ce chantier, cf. roadmap.md).

## 10. Carte des fichiers (`ai-service/`)

| Fichier | Rôle |
|---|---|
| `graph.py` | le graphe LangGraph, le prompt système, tout le HITL |
| `tools.py` | tous les tools exposés au modèle |
| `routing.py` | heuristiques de routage forcé (regex) |
| `context.py` | contexte usine dynamique pour le prompt |
| `gateway.py` | client HTTP vers la gateway, compte de service |
| `embeddings.py` | embeddings documents (`embeddinggemma`) via Ollama |
| `reranker.py` | reranker cross-encoder de `search_knowledge` |
| `ingest.py` | pipeline d'ingestion PDF (Docling) |
| `generate_manual_pdf.py` | génère `manuel-exploitation-brasserie.pdf` (dev only) |
| `main.py` | FastAPI minimal : `/health`, `/ingest/pdf` |
| `langgraph.json` | config serveur LangGraph (graphe + app HTTP montée) |
| `Dockerfile` | image du service (`langgraph dev` comme process principal) |
| `pyproject.toml` / `uv.lock` | dépendances (uv) |
| `knowledge-pdfs/` | les 3 PDF sources du RAG |
| `tests/test_operation_tools.py` | tests de contrat (schémas fermés, routing) |
