# simulator/ — micro-brasserie 🍺

Simulateur d'usine Strata pour démos et tests. Thème : une **micro-brasserie** qui
brasse deux recettes en parallèle (**Blonde** lager, **IPA** ale).

## Pourquoi c'est (un peu) malin

Chaque cuve de procédé a une **température cible**, et s'en écarter dégrade la
qualité de façon crédible (empâtage trop chaud = enzymes grillées → moût trouble ;
fermentation trop chaude = esters → « goût de banane »). La qualité cumulée pilote
le **taux de rebut** à l'embouteillage. Le rebut n'est donc pas aléatoire : il
raconte ce qui s'est mal passé dans le procédé — parfait pour démontrer les
dashboards prod/shift et la corrélation dérive→qualité.

## Architecture cerveau / faces

```
factory/
  brain.py            # le CERVEAU : procédé brassicole, zéro notion de protocole
  scenario.py         # scénarios scriptés (journée de brassage, incidents)
  faces/
    mqtt_face.py      # FACE MQTT : publie l'état du cerveau (P5)
    # P6 : modbus_face.py, s7_face.py, eip_face.py (vrais serveurs protocolaires)
main.py               # boucle : tick cerveau + scénario + face
```

Le cerveau expose un état `{tag_métier: valeur}` (`brasserie.blonde.empateur.temperature`…).
Les faces lisent cet état et le présentent dans un protocole, **sans jamais modifier
le cerveau**. Ajouter un protocole en P6 = ajouter une face, rien d'autre à toucher.

## Réglages (env)

| Var | Défaut | Rôle |
|---|---|---|
| `MQTT_URL` | `mosquitto` | hôte du broker |
| `MQTT_PORT` | `1883` | port |
| `TICK_HZ` | `2.0` | fréquence de simulation |
| `SPEED` | `1.0` | accélération du temps (`5` = 5× plus vite) |

Le scénario de démo dure ~6 min puis boucle (ouverture, incidents thermiques,
panne d'embouteilleuse, réparation, fin de poste).
