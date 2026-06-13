.PHONY: up down logs ps clean

up:        ## Démarre le stack en arrière-plan
	docker compose up -d

down:      ## Arrête le stack (tous profils inclus : ai, plc4x, risingwave)
	docker compose --profile ai --profile plc4x --profile risingwave down --remove-orphans

logs:      ## Suit les logs de tous les services
	docker compose logs -f

ps:        ## Affiche l'état des services
	docker compose ps

clean:     ## Arrête et supprime les volumes (reset total, tous profils)
	docker compose --profile ai --profile plc4x --profile risingwave down -v --remove-orphans
