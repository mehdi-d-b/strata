# Passation — switch Windows/WSL2 → MacBook Air M4 (assistant LLM)

> **Pour le nouveau chat (sur le Mac).** On change de machine de dev pour l'assistant
> IA. Cette note dit (1) **pourquoi**, (2) l'**adaptation Windows→Mac** à faire, (3) **où
> reprendre** par rapport au debug en cours et à la roadmap. Lis aussi le fil conducteur
> [docs/assistant-roadmap.md](../assistant-roadmap.md) et le terrain
> [docs/simulator-scenarios.md](../simulator-scenarios.md).
>
> ⚠️ **Règles de commit (CLAUDE.md)** : ne JAMAIS committer sans le feu vert explicite de
> Mehdi ; pas de modif UI committée avant test visuel ; pas de trailer `Co-Authored-By`.

## 1. Pourquoi on switch

Sous Windows/WSL2 (Dell, **CPU only**, **7,4 Gio** de RAM vus par WSL, swap plein), l'assistant
plantait : `qwen2.5:7b` + `num_ctx=8192` + le bloc `tools` complet → **OOM** → Ollama renvoie
`500 unexpected EOF` (le *runner* du modèle se fait tuer). Un appel simple passait (≈20 s), mais
l'appel assistant complet crashait.

Le **MacBook Air M4 (16 Go unifiés)** apporte le **GPU Metal** + ~16 Go pour le modèle →
réponses en **secondes**, et permet même un **14b** (meilleur suivi d'instructions). Pas de risque
de « casse » : au pire l'Air (fanless) *throttle* sur une génération longue.

## 2. Adaptation Windows → Mac (à faire EN PREMIER)

**Le piège :** lancer Ollama dans le `docker compose` (profil `ai`) sur Mac = il tourne dans la VM
Linux de Docker Desktop → **pas de Metal** → aussi lent qu'avant. Il faut Ollama **natif macOS**,
hors Docker, et faire pointer la gateway (qui reste dans Docker) vers l'hôte.

À faire :
1. **Ollama natif** : `brew install ollama` (ou l'app), puis `ollama serve` (tourne en fond).
2. **Modèle** : `ollama pull qwen2.5:14b` (recommandé sur 16 Go) — ou `qwen2.5:7b` pour rester léger.
   Penser à aligner `ASSISTANT_MODEL` (cf. docker-compose / `.env`).
3. **Gateway → Ollama hôte** : `OLLAMA_URL=http://host.docker.internal:11434`
   (au lieu de `http://ollama:11434`). `host.docker.internal` résout l'hôte depuis Docker Desktop Mac.
   Le mettre via un `.env` ou override compose ; **ne pas** démarrer le profil `ai`.
4. **Démarrer le stack** : `make up` (SANS le profil ai, puisque Ollama est natif). `make down`/`clean`
   incluent déjà tous les profils (sans effet si ai non lancé).
5. **Vérif** : `curl http://localhost:11434/api/tags` (modèle présent) puis tester l'assistant.

> Optionnel : créer une cible Make `up-host-ai` ou un `.env.mac` pour figer `OLLAMA_URL`. À voir avec Mehdi.

## 3. Où reprendre — état du travail

**Branche `feat/batches`.** Le **terrain (étapes 1→5 de simulator-scenarios.md) est complet et
committé** : généalogie de batch (cerveau + table `batches` + `BatchTracker`), scénarios rotatifs
causaux S1–S5 (un défaut net/batch, `SCENARIO_FORCE` pour forcer), métriques honnêtes (sévérité
intégrée, bruit de mesure), bandes nominales publiées (`temp_cible`/`temp_tol`), 3 recettes
(blonde/ipa/jalapeno).

**Harness — 1ʳᵉ brique faite et committée** : tool `get_batch_context` (dossier de batch
auto-conclusif : `conforme`, `defaut_type`, `cuves_hors_bande`, `cip_ok`, déviations vs bande
**après régime établi** pour exclure le transitoire de chauffe). Endpoint `GET /api/batches`.

**Debug en cours (à finir sur le Mac avec un modèle plus gros) :**
- ✅ Cas **contamination** : le 7b répond juste (« contamination, aucune cuve déviée »).
- ❌ Cas **thermique** (`ipa-1781539207`, vrai `fermentation_hors_spec`, fermenteur +5 °C / 14 % hors
  bande) : le 7b a répondu « contamination, aucune cuve déviée » — **faux**. Données + dossier
  **corrects** (vérifiés en SQL) ; le modèle a soit **recopié sa réponse du tour précédent**
  (écho d'historique), soit buté sur son **plafond**.
- ⏳ **Test diagnostic non terminé** (Ollama a OOM avant) : **rouvrir un chat NEUF** et reposer la
  question sur `ipa-1781539207`. Réponse correcte en historique vide ⇒ c'était l'écho (fixable côté
  harness : ne pas laisser un vieux diagnostic polluer). Toujours faux ⇒ plafond du 7b → tester 14b.

**Prochaines étapes (cf. assistant-roadmap.md) :**
1. Refaire ce test de discrimination (thermique vs contamination) sur **14b/M4** — ça doit passer.
2. **Routing** (question simple → boucle ; diagnostic → s'assurer que `get_batch_context` est appelé).
3. **Observabilité** des tours d'agent (cheap, à faire tôt).
4. **`search_knowledge` / RAG** (pgvector + `nomic-embed-text`), d'abord bouché puis réel.

## Pour tester un batch (rappel)
```bash
docker compose exec timescaledb psql -U strata -d strata \
  -c "SELECT id,recipe,defaut_type FROM batches WHERE defaut_type IS NOT NULL ORDER BY started_at DESC LIMIT 5;"
# puis dans le chat : « pourquoi le batch <id> est hors spec ? »
# attendu : contamination -> CIP ; thermique -> la bonne cuve (cuves_hors_bande)
```
