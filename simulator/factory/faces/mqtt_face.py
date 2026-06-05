"""Face MQTT : publie l'état du cerveau sur un broker MQTT.

Chaque tag métier `brasserie.blonde.empateur.temperature` devient le topic MQTT
`factory/brasserie/blonde/empateur/temperature` avec un payload {"value": ...}.
Le normaliseur Redpanda Connect (mqtt-to-raw.yaml) retire `factory/` et rejoint
le chemin avec des points -> on retombe exactement sur le tag métier.
"""
from __future__ import annotations

import json

import paho.mqtt.client as mqtt


class MqttFace:
    def __init__(self, url: str = "mosquitto", port: int = 1883,
                 prefix: str = "factory") -> None:
        self.prefix = prefix
        # paho-mqtt 2.x impose de préciser la version de l'API de callbacks.
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id="strata-brewery-sim"
        )
        self.client.reconnect_delay_set(min_delay=1, max_delay=10)
        self._host = url
        self._port = port

    def connect(self) -> None:
        self.client.connect_async(self._host, self._port)
        self.client.loop_start()

    def publish_state(self, state: dict[str, float]) -> None:
        """Publie chaque tag de l'état sur son topic MQTT."""
        for tag, value in state.items():
            topic = f"{self.prefix}/" + tag.replace(".", "/")
            self.client.publish(topic, json.dumps({"value": value}))

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()
