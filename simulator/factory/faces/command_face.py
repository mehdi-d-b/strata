"""Face de commande : reçoit les consignes (topic Redpanda `tags.cmd`) et les
applique au cerveau.

C'est le pendant « écriture » des faces de lecture : là où la face MQTT EXPOSE
l'état, celle-ci ACCEPTE des consignes venues de la gateway (POST /api/command,
après vérif des droits). Elle tourne dans un thread de fond et se contente
d'appeler `brewery.apply_command(tag, value)`.

En conditions réelles (P6+), c'est l'équivalent de l'automate qui reçoit une
écriture sur un de ses registres.
"""
from __future__ import annotations

import json
import threading
from collections.abc import Callable

from kafka import KafkaConsumer  # kafka-python (pur Python)


class CommandFace:
    def __init__(
        self,
        brokers: str,
        apply: Callable[[str, float], bool],
        topic: str = "tags.cmd",
        log: Callable[[str], None] = print,
    ) -> None:
        self.brokers = brokers
        self.apply = apply
        self.topic = topic
        self.log = log
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        # On retente la CONNEXION si le broker tarde, mais une fois connecté on
        # reste en écoute continue (pas de timeout : sinon on churn et on rate des
        # messages à cause du repositionnement 'latest').
        while not self._stop.is_set():
            try:
                consumer = KafkaConsumer(
                    self.topic,
                    bootstrap_servers=self.brokers.split(","),
                    group_id="strata-sim-command",
                    auto_offset_reset="latest",  # n'applique que les consignes récentes
                    value_deserializer=lambda b: json.loads(b.decode()),
                )
            except Exception as e:  # broker pas prêt -> on retente
                self.log(f"[cmd] connexion KO ({e}); retry dans 3s")
                self._stop.wait(3.0)
                continue

            self.log(f"[cmd] écoute des consignes sur {self.topic}")
            try:
                for msg in consumer:  # bloque en continu
                    if self._stop.is_set():
                        break
                    cmd = msg.value
                    tag, value = cmd.get("tag"), cmd.get("value")
                    if tag is None or value is None:
                        continue
                    ok = self.apply(tag, float(value))
                    self.log(
                        f"[cmd] consigne {tag} = {value} "
                        f"({'appliquée' if ok else 'ignorée'})"
                    )
            except Exception as e:
                self.log(f"[cmd] lecture interrompue ({e}); reconnexion dans 3s")
                self._stop.wait(3.0)

    def stop(self) -> None:
        self._stop.set()
