.PHONY: up up-ai logs ps down clean

ASSISTANT_MODEL ?= qwen2.5:7b

up:        ## Démarre le stack en arrière-plan (sans profils optionnels)
	docker compose up -d

up-ai:     ## Démarre le stack + assistant IA (Ollama) et télécharge le modèle
	docker compose --profile ai up -d
	docker compose exec ollama ollama pull $(ASSISTANT_MODEL)

down:      ## Arrête le stack (tous profils inclus : ai, plc4x, risingwave)
	docker compose --profile ai --profile plc4x --profile risingwave down --remove-orphans

logs:      ## Suit les logs de tous les services
	docker compose logs -f

ps:        ## Affiche l'état des services
	docker compose ps

clean:     ## Arrête et supprime les volumes (reset total, tous profils)
	docker compose --profile ai --profile plc4x --profile risingwave down -v --remove-orphans
