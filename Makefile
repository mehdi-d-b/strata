.PHONY: up up-ai logs ps down clean

AI_SERVICE_MODEL ?= qwen3.5:9b
EMBED_MODEL ?= embeddinggemma

up:        ## Démarre le stack en arrière-plan (sans profils optionnels)
	docker compose up -d

up-ai:     ## Démarre le stack + assistant IA (Ollama) et télécharge le modèle
	docker compose --profile ai up -d
	docker compose exec ollama ollama pull $(AI_SERVICE_MODEL)
	docker compose exec ollama ollama pull $(EMBED_MODEL)
	docker compose exec ai-service uv run python ingest.py

down:      ## Arrête le stack (tous profils inclus : ai, plc4x, risingwave)
	docker compose --profile ai --profile plc4x --profile risingwave down --remove-orphans

logs:      ## Suit les logs de tous les services
	docker compose logs -f

ps:        ## Affiche l'état des services
	docker compose ps

clean:     ## Arrête et supprime les volumes (reset total, tous profils)
	docker compose --profile ai --profile plc4x --profile risingwave down -v --remove-orphans
