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


def skip_cip(recipe: str) -> Action:
    """Saute le nettoyage avant brassage → contamination (cause NON thermique)."""
    def _a(b: Brewery) -> None:
        r = b.find_recipe(recipe)
        if r:
            r.cip_ok = False   # consommé à l'ouverture du prochain batch
    return _a


def drift_temp(recipe: str, vessel: str, rate_per_min: float) -> Action:
    """Installe une dérive LENTE de l'équilibre (°C/min). rate=0 stoppe ET recale
    (l'équilibre revient à la cible : le technicien a corrigé)."""
    def _a(b: Brewery) -> None:
        v = b.find_vessel(recipe, vessel)
        if v:
            v.drift_rate = rate_per_min / 60.0  # le cerveau l'applique par seconde simulée
            if rate_per_min == 0.0:
                v._drift_offset = 0.0
    return _a


# ─── Catalogue de scénarios : UN défaut net par batch ───────────────────────
#
# Chaque scénario construit les étapes d'incident d'UNE ligne, dans la fenêtre d'un
# cycle (= un batch). Objectif : que « le dernier batch IPA » ait une cause unique et
# nette, exploitable pour tester l'assistant (cf. docs/simulator-scenarios.md).

CYCLE_SECONDS = 360.0
_CIP_AT = 2.0         # nettoyage AVANT brassage (doit précéder l'ouverture du batch)
_BREW_AT = 5.0        # ouverture du brassage (= ouverture du batch)
_INCIDENT_AT = 60.0   # début de l'incident (cuves stabilisées à leur cible)
_RECOVER_AT = 300.0   # retour à la normale (déviation ~240 s, bien au-delà du seuil)
_STOP_AT = 350.0      # fin de poste (= clôture du batch, verdict calculé)

# Catalogue : nom de scénario -> (ligne) -> étapes d'incident. "nominal" = aucun
# incident (batch conforme). Aligné avec les verdicts de brain.py.
SCENARIOS: dict[str, Callable[[str], list[Step]]] = {
    "nominal": lambda line: [],
    "fermentation_hors_spec": lambda line: [
        Step(_INCIDENT_AT, f"🌡️  Emballement du fermenteur {line} (+8°C) → fermentation hors spec",
             nudge_temp(line, "fermenteur", 8.0)),
        Step(_RECOVER_AT, f"🔧 Recalage du fermenteur {line}",
             nudge_temp(line, "fermenteur", -8.0)),
    ],
    "rendement_faible": lambda line: [
        Step(_INCIDENT_AT, f"🥵 Coup de chaud sur l'empâteur {line} (+10°C) → enzymes dénaturées",
             nudge_temp(line, "empateur", 10.0)),
        Step(_RECOVER_AT, f"❄️  Refroidissement de l'empâteur {line}",
             nudge_temp(line, "empateur", -10.0)),
    ],
    "volume_insuffisant": lambda line: [
        Step(_INCIDENT_AT, f"💥 Panne de l'embouteilleuse {line} → débit à l'arrêt",
             trip_bottler(line)),
        Step(_RECOVER_AT, f"🔧 Embouteilleuse {line} réparée et relancée",
             repair_bottler(line)),
    ],
    # Cause NON thermique : temp nominale, mais nettoyage écourté → contamination.
    # C'est le cas qui force l'assistant à DISCRIMINER (écarter la piste thermique).
    "contamination": lambda line: [
        Step(_CIP_AT, f"🧽 CIP écourté sur la ligne {line} → risque de contamination",
             skip_cip(line)),
    ],
    # Dérive LENTE (groupe froid qui faiblit) : même verdict que S1 (fermentation hors
    # spec) mais la timeline raconte une montée graduelle, détectée tard.
    "derive_lente": lambda line: [
        Step(_INCIDENT_AT, f"📉 Dérive lente du fermenteur {line} (+1.5 °C/min) → détection tardive",
             drift_temp(line, "fermenteur", 1.5)),
        Step(_RECOVER_AT, f"🔧 Dérive du fermenteur {line} stoppée",
             drift_temp(line, "fermenteur", 0.0)),
    ],
}

# Rotation des cycles : chaque entrée = {ligne: scénario} pour un cycle. On varie
# pour accumuler des batchs aux verdicts différents (dont des batchs conformes). Une
# ligne absente d'un plan = nominale (brew_all/stop_all démarrent toutes les lignes).
CYCLE_PLANS: list[dict[str, str]] = [
    {"ipa": "fermentation_hors_spec"},
    {"blonde": "rendement_faible"},
    {"ipa": "volume_insuffisant"},
    {"ipa": "contamination"},
    {"blonde": "derive_lente"},
    {"jalapeno": "rendement_faible"},
    {},  # cycle tout-nominal
]


def single_plan(scenario: str, line: str = "ipa") -> list[dict[str, str]]:
    """Rotation à un seul plan : force `scenario` sur `line` à chaque cycle (mode
    déclenché). Les autres lignes restent nominales (absentes du plan)."""
    return [{line: scenario}]


class ScenarioRunner:
    """Déroule une ROTATION de scénarios : à chaque cycle, reconstruit les étapes
    (ouverture → incidents par ligne → clôture) selon le plan du cycle courant."""

    def __init__(self, cycle_plans: list[dict[str, str]], cycle_seconds: float,
                 log: Callable[[str], None] = print) -> None:
        self.plans = cycle_plans or [{}]
        self.cycle = cycle_seconds
        self.log = log
        self._elapsed = 0.0
        self._cycle_idx = 0
        self._next_idx = 0
        self.steps = self._build_cycle(0)

    def _build_cycle(self, idx: int) -> list[Step]:
        plan = self.plans[idx % len(self.plans)]
        steps = [Step(_BREW_AT, "🍺 Ouverture : lancement du brassage", brew_all())]
        for line, scenario in plan.items():
            builder = SCENARIOS.get(scenario)
            if builder:
                steps.extend(builder(line))
            else:
                self.log(f"[scénario] inconnu: {scenario!r} (ligne {line}) — ignoré")
        steps.append(Step(_STOP_AT, "🌙 Fin de poste : arrêt et clôture des batchs", stop_all()))
        return sorted(steps, key=lambda s: s.at)

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
            self._cycle_idx += 1
            self.steps = self._build_cycle(self._cycle_idx)
            plan = self.plans[self._cycle_idx % len(self.plans)]
            self.log(f"[scénario] —— nouvelle journée — plan: {plan} ——")
