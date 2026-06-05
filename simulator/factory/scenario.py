"""Moteur de scénarios : scripte la journée de la brasserie.

Un scénario = des étapes (instant en secondes -> action sur le cerveau). Le runner
applique chaque étape au bon moment puis boucle (démo continue). Les actions ne
connaissent aucun protocole : elles manipulent le cerveau (start/stop/trip/dérive).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .brain import Brewery

Action = Callable[[Brewery], None]


@dataclass
class Step:
    at: float
    label: str
    action: Action


# ─── Actions ──────────────────────────────────────────────────────────────

def brew_all() -> Action:
    def _a(b: Brewery) -> None:
        for r in b.recipes:
            r.start()
    return _a


def stop_all() -> Action:
    def _a(b: Brewery) -> None:
        for r in b.recipes:
            r.stop()
    return _a


def nudge_temp(recipe: str, vessel: str, delta: float) -> Action:
    """Pousse la température d'une cuve (incident de régulation → qualité qui chute)."""
    def _a(b: Brewery) -> None:
        v = b.find_vessel(recipe, vessel)
        if v:
            v.temperature += delta
    return _a


def trip_bottler(recipe: str) -> Action:
    def _a(b: Brewery) -> None:
        r = b.find_recipe(recipe)
        if r:
            r.bottler.trip()
    return _a


def repair_bottler(recipe: str) -> Action:
    def _a(b: Brewery) -> None:
        r = b.find_recipe(recipe)
        if r:
            r.bottler.reset_fault()
            r.bottler.start()
    return _a


# ─── Scénario de démo : une « journée » à la brasserie (~6 min, en boucle) ──

DEMO_SCENARIO: list[Step] = [
    Step(5,   "🍺 Ouverture : on lance le brassage des deux cuvées", brew_all()),
    Step(90,  "🌡️  Le thermostat du fermenteur IPA s'emballe (+8°C) → esters, goût de banane",
              nudge_temp("ipa", "fermenteur", 8.0)),
    Step(150, "🔧 Le brasseur recale le fermenteur IPA",
              nudge_temp("ipa", "fermenteur", -8.0)),
    Step(200, "💥 Bourrage sur l'embouteilleuse Blonde → panne",
              trip_bottler("blonde")),
    Step(230, "🔧 Embouteilleuse Blonde débloquée et relancée",
              repair_bottler("blonde")),
    Step(280, "🥵 Coup de chaud sur l'empâteur Blonde (+10°C) → enzymes grillées, moût trouble",
              nudge_temp("blonde", "empateur", 10.0)),
    Step(320, "❄️  Refroidissement de l'empâteur Blonde, retour dans la plage",
              nudge_temp("blonde", "empateur", -10.0)),
    Step(350, "🌙 Fin de poste : arrêt des cuves",
              stop_all()),
]
CYCLE_SECONDS = 360.0


class ScenarioRunner:
    """Applique un scénario en boucle au fil du temps simulé."""

    def __init__(self, steps: list[Step], cycle_seconds: float,
                 log: Callable[[str], None] = print) -> None:
        self.steps = sorted(steps, key=lambda s: s.at)
        self.cycle = cycle_seconds
        self.log = log
        self._elapsed = 0.0
        self._next_idx = 0

    def tick(self, brewery: Brewery, dt: float) -> None:
        self._elapsed += dt
        while (self._next_idx < len(self.steps)
               and self._elapsed >= self.steps[self._next_idx].at):
            step = self.steps[self._next_idx]
            self.log(f"[scénario] t={self._elapsed:5.0f}s — {step.label}")
            step.action(brewery)
            self._next_idx += 1
        if self._elapsed >= self.cycle:
            self._elapsed = 0.0
            self._next_idx = 0
            self.log("[scénario] —— nouvelle journée de brassage ——")
