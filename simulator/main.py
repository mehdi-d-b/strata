"""Simulateur d'usine Strata — micro-brasserie (P5).

Assemble : cerveau (Brewery) + scénario (journée de brassage) + face MQTT.
Boucle de simulation à fréquence fixe ; à chaque tick le cerveau évolue, le
scénario applique ses événements, et la face publie l'état.

Variables d'environnement :
  MQTT_URL       hôte du broker MQTT       (défaut: mosquitto)
  MQTT_PORT      port                      (défaut: 1883)
  KAFKA_BROKERS  brokers Redpanda (cmd)    (défaut: redpanda:9092)
  TICK_HZ        fréquence de simulation   (défaut: 2.0)
  SPEED          accélération du temps     (défaut: 1.0 ; 5 = 5x plus rapide)
  SCENARIO       active le scénario auto   (défaut: 1 ; 0 = piloté seulement par commandes)
"""
from __future__ import annotations

import os
import time

from factory.brain import Brewery
from factory.faces.command_face import CommandFace
from factory.faces.mqtt_face import MqttFace
from factory.scenario import CYCLE_PLANS, CYCLE_SECONDS, ScenarioRunner, single_plan

MQTT_URL = os.environ.get("MQTT_URL", "mosquitto")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
KAFKA_BROKERS = os.environ.get("KAFKA_BROKERS", "redpanda:9092")
TICK_HZ = float(os.environ.get("TICK_HZ", "2.0"))
SPEED = float(os.environ.get("SPEED", "1.0"))
SCENARIO = os.environ.get("SCENARIO", "1") != "0"
# Mode déclenché : force un seul scénario à chaque cycle (sur SCENARIO_LINE, défaut ipa).
# Ex : SCENARIO_FORCE=volume_insuffisant. Vide = rotation normale (CYCLE_PLANS).
SCENARIO_FORCE = os.environ.get("SCENARIO_FORCE", "").strip()
SCENARIO_LINE = os.environ.get("SCENARIO_LINE", "ipa").strip()


def main() -> None:
    brewery = Brewery.default()
    plans = single_plan(SCENARIO_FORCE, SCENARIO_LINE) if SCENARIO_FORCE else CYCLE_PLANS
    runner = ScenarioRunner(plans, CYCLE_SECONDS)
    face = MqttFace(url=MQTT_URL, port=MQTT_PORT)
    face.connect()

    # Face de commande : reçoit les consignes d'écriture (P8) et les applique.
    cmd_face = CommandFace(KAFKA_BROKERS, brewery.apply_command)
    cmd_face.start()

    mode = "OFF" if not SCENARIO else (
        f"forcé:{SCENARIO_FORCE}@{SCENARIO_LINE}" if SCENARIO_FORCE else "rotation")
    print(f"[sim] brasserie démarrée — MQTT {MQTT_URL}:{MQTT_PORT}, "
          f"cmd {KAFKA_BROKERS}, {TICK_HZ} Hz, vitesse x{SPEED}, "
          f"scénario {mode}")

    period = 1.0 / TICK_HZ
    dt = period * SPEED  # temps simulé par tick (accéléré si SPEED>1)
    try:
        while True:
            if SCENARIO:
                runner.tick(brewery, dt)
            brewery.tick(dt)
            face.publish_state(brewery.state())
            time.sleep(period)
    except KeyboardInterrupt:
        pass
    finally:
        cmd_face.stop()
        face.close()


if __name__ == "__main__":
    main()
