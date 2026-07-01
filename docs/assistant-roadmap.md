# Strata — Roadmap de l'assistant IA (terrain → harness → modèle)

> **Le fil conducteur.** Ce document relie *toute* la démarche pour rendre l'assistant
> réellement utile : la préparation de terrain (données), le harness (l'échafaudage de
> raisonnement) et le modèle. Il ne duplique pas les docs existants, il les **ordonne** :
> - **Câblage** de l'assistant (local, Chemin B, MCP/RAG, sécurité) → [llm-integration.md](llm-integration.md)
> - **Terrain côté données** (généalogie de batch, scénarios, verdict) → [simulator-scenarios.md](simulator-scenarios.md)
> - **Phases globales** du projet → [roadmap.md](roadmap.md)

## L'idée-force

> **L'intelligence est dans le harness, pas (seulement) dans le modèle.**

Un assistant qui appelle `get_history` et reçoit min/max/moyenne ne vaut pas mieux qu'un
indicateur : tout le raisonnement est dans le SQL, le LLM ne fait qu'emballer. La valeur
vient de **croiser des domaines** (alarmes + production + consignes + verdict QC + doc) et de
**raisonner** dessus — ce qu'un dashboard ne fait pas. Pour y arriver, trois principes :

1. **Workflow > agent autonome.** Un petit modèle ne planifie pas une bonne enquête tout seul.
   C'est NOTRE code (TypeScript) qui orchestre les phases ; le LLM ne fait que raisonner, à
   chaque étape, sur un dossier qu'on lui sert. (cf. Anthropic, *Building Effective Agents*.)
2. **Servir de la donnée contextualisée, pas des agrégats.** Donner des déviations vs bande
   nominale, des timelines, des événements — pas un min/max qui tue l'analyse.
3. **Le verdict est ingéré, pas inventé.** Le résultat QC (« batch contaminé ») vient du
   labo/opérateur/LIMS ; l'assistant l'**explique** en corrélant les déviations. (Dans le
   simulateur on calcule le verdict car il est l'oracle — artifice de vérité terrain ; cf.
   [simulator-scenarios.md](simulator-scenarios.md) § « oracle vs usine réelle ».)

Corollaires : **observabilité dès le jour 1** (logger chaque tour : tools, latence, où ça
casse) ; **pas de framework** (LangChain & co n'ajoutent aucune intelligence, notre boucle
maison suffit) ; **le plafond reste le modèle** (voir dernière section).

## La chaîne de dépendances

```
TERRAIN (données)              HARNESS (raisonnement)            MODÈLE
─────────────────             ──────────────────────           ────────
généalogie de batch    ─┐
scénarios causaux       ├──►  get_batch_context  ─┐
bandes nominales        │      (le dossier)        ├──► boucle RCA routée ──► (Mac M4 16 Go + 7-14B)
ingestion interlocks   ─┘      search_knowledge   ─┘      + observabilité
                                (RAG incidents/SOP)
```

**Règle de bon sens pour prioriser :** une brique a-t-elle de la valeur *même sans LLM* ? La
table `batches` (→ page « rapport de batch ») : oui. Le workflow RCA : seulement avec un gros
modèle. On construit donc le terrain d'abord, on teste le harness ensuite, on calibre le modèle
au budget RAM disponible (16 Go sur le Mac M4) pour le raisonnement fin.

## 1. Préparation de terrain (données)

| Brique | État | Détail |
|---|---|---|
| Généalogie de batch (entité, fenêtre, verdict) | ✅ | cerveau + table `batches` + `BatchTracker` + `GET /api/batches` |
| Scénarios causaux (1 défaut net/batch, rotatifs) | ✅ | S1–S5, cf. [simulator-scenarios.md](simulator-scenarios.md) |
| Métriques honnêtes (sévérité intégrée, bruit de mesure) | ✅ | base d'une vraie « déviation vs nominal » |
| Bandes nominales `consigne ± tolérance` par tag/recette | ✅ | publiées via `temp_cible`/`temp_tol` ; 3ᵉ recette (jalapeño) |
| Ingestion d'états d'interlock/permissifs (PLC) | ⬜ | prérequis du diagnostic « pourquoi le bouton ne fait rien » |
| Saisie verdict QC (UI/LIMS) — pour une vraie usine | ⬜ | en sim, c'est l'oracle qui calcule |

## 2. Harness (raisonnement) — ce qu'on construit ensuite

| Brique | État | Rôle |
|---|---|---|
| Boucle d'agent (tool-calls, lecture/écriture encadrée) | ✅ | `gateway/src/assistant.ts` |
| Text-to-SQL read-only (`describe_schema` + `query_readonly`) | ✅ | questions ad-hoc, rôle `strata_ro` |
| `get_batch_context(batch_ref)` | ✅ | dossier batch : déviations par cuve vs `[temp_cible ± temp_tol]`, transitoire exclu, alarmes, consignes, CIP ; résolution par id ou recette |
| `get_line_status` / `get_shift_summary` / `get_oee_breakdown` / `get_active_batches` | ✅ | état temps réel machines, résumé shift, cascade pertes OEE, batches en cours |
| `search_knowledge` / **RAG** (pgvector + `nomic-embed-text` local) | ✅ | SOPs, causes de défauts, incidents passés ; tool guidé par le system prompt |
| **Observabilité** des tours d'agent | ✅ | `agentLog` JSON par tour (start/llm/tool/done) + SSE live trace dans l'UI |
| Routing (question simple → boucle ; diagnostic → workflow) | ✅ | `detectBatchDiagnostic` : heuristique légère (verbe diagnostic + batch/recette/id) |
| Boucle **RCA** orchestrée en code (phases) | 🟡 | hypothèses (`get_batch_context`) + preuves (`search_knowledge` ciblé sur le défaut réel) **forcées en code**, avant la boucle ReAct existante ; corrélation/conclusion = le modèle sur le dossier déjà servi (pas de phase séparée) |

## 3. Classes de questions (la vraie carte d'usage)

Le pattern est toujours le même : *router → connaissance pertinente → context-tool adapté →
raisonner → répondre / proposer une action confirmée*. Ce qui change : le context-tool, la
source de vérité, et si c'est du calcul ou du raisonnement.

| Question type | Source de vérité | Context-tool | Effort | Raisonnement |
|---|---|---|---|---|
| « Vais-je atteindre l'objectif du shift ? » | séries (déjà là) | projection OEE | faible | calcul |
| « Tendance / dernière alarme ? » | séries (déjà là) | `get_history`/`list_alarms` | faible | nul |
| « Comment résoudre cette alarme ? » | procédures (RAG) | `search_knowledge` (SOP) | moyen | moyen |
| « Pourquoi ce batch est hors spec ? » | séries + déviations + incidents | `get_batch_context` + RCA | élevé | élevé |
| « Pourquoi le bouton ne réagit pas ? » | logique d'interlock + état live | RAG interlocks + tags | élevé | **bloqué si non ingéré** |

> Méthode : lister 15–20 vraies questions d'opérateur, les ranger ici → 4–5 *playbooks*
> couvrent ~80 % des cas. Chaque nouvelle classe = un playbook + éventuellement un corpus à indexer.

## 4. État actuel & prochaine action

- **Fait** : terrain batch + scénarios + métriques honnêtes ; boucle d'agent v1/v2/v3 ; text-to-SQL ;
  `get_batch_context` (déviations vs bande nominale, transitoire exclu, alarmes, CIP) ; RAG pgvector ;
  SSE live trace ; outils d'investigation (line status, shift summary, OEE breakdown, active batches) ;
  **routing + hypothèses/preuves forcées** (`gateway/src/assistant.ts` : `detectBatchDiagnostic` +
  appels forcés `get_batch_context`/`search_knowledge` avant la boucle ReAct — plus besoin de compter
  sur le prompt pour que le modèle y pense).
- **Prochaine action** : évaluer en live avec `qwen2.5:14b` (Mac M4) ; si besoin, enrichir le routeur
  avec plus de cas réels (liste des 15-20 questions d'opérateur, §3).
- **Plafond restant** : choisir le meilleur modèle tenant dans 16 Go de RAM unifiée (Mac M4, GPU
  Metal via Ollama) pour le raisonnement multi-étapes et le streaming token.

## 5. Le plafond : matériel & modèle

L'architecture peut être complète et correcte ; l'**usabilité** dépend du **modèle**, borné par
la RAM unifiée de la machine — **MacBook Air M4, 16 Go, GPU Metal via Ollama** (plus de plafond
CPU). Dans ce budget : 7-8B confortable, **14B en q4 le plafond réaliste** (contexte à surveiller),
32B+ hors de portée sur cette machine. **Toute la plomberie (terrain + harness) se construit et
se teste maintenant** ; le réglage fin du raisonnement se fait avec le meilleur modèle qui rentre
dans ces 16 Go. Ne pas confondre « assistant nul » (souvent : harness minimal) et « modèle trop
petit » (vrai plafond, mais second).
