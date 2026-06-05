"""Simulateur d'usine Strata — micro-brasserie (P5).

Assemble : cerveau (Brewery) + scénario (journée de brassage) + face MQTT.
Boucle de simulation à fréquence fixe ; à chaque tick le cerveau évolue, le
scénario applique ses événements, et la face publie l'état.

Variables d'environnement :
  MQTT_URL   hôte du broker MQTT      (défaut: mosquitto)
  MQTT_PORT  port                     (défaut: 1883)
  TICK_HZ    fréquence de simulation  (défaut: 2.0)
  SPEED      accélération du temps    (défaut: 1.0 ; 5 = 5x plus rapide)
"""
from __future__ import annotations

import os
import time

from factory.brain import Brewery
from factory.faces.mqtt_face import MqttFace
from factory.scenario import CYCLE_SECONDS, DEMO_SCENARIO, ScenarioRunner

MQTT_URL = os.environ.get("MQTT_URL", "mosquitto")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
TICK_HZ = float(os.environ.get("TICK_HZ", "2.0"))
SPEED = float(os.environ.get("SPEED", "1.0"))


def main() -> None:
    brewery = Brewery.default()
    runner = ScenarioRunner(DEMO_SCENARIO, CYCLE_SECONDS)
    face = MqttFace(url=MQTT_URL, port=MQTT_PORT)
    face.connect()

    print(f"[sim] brasserie démarrée — MQTT {MQTT_URL}:{MQTT_PORT}, "
          f"{TICK_HZ} Hz, vitesse x{SPEED}")

    period = 1.0 / TICK_HZ
    dt = period * SPEED  # temps simulé par tick (accéléré si SPEED>1)
    try:
        while True:
            runner.tick(brewery, dt)
            brewery.tick(dt)
            face.publish_state(brewery.state())
            time.sleep(period)
    except KeyboardInterrupt:
        pass
    finally:
        face.close()


if __name__ == "__main__":
    main()
