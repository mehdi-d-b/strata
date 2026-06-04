.PHONY: up down logs ps clean

up:        ## Démarre le stack en arrière-plan
	docker compose up -d

down:      ## Arrête le stack
	docker compose down

logs:      ## Suit les logs de tous les services
	docker compose logs -f

ps:        ## Affiche l'état des services
	docker compose ps

clean:     ## Arrête et supprime les volumes (reset total)
	docker compose down -v
