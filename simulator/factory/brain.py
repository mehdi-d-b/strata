"""Cerveau de la micro-brasserie Strata : simule le procédé, sans aucun protocole.

Deux lignes = deux recettes brassées en parallèle (Blonde, IPA). Chaque ligne
enchaîne 4 cuves : empâtage → ébullition → fermentation → embouteillage.

Le point *smart* : chaque cuve de procédé a une température CIBLE, et s'en écarter
dégrade la qualité de façon crédible (empâtage trop chaud = enzymes tuées, bière
trouble ; fermentation trop chaude = esters, « goût de banane »). La qualité
cumulée des cuves pilote le taux de rebut à l'embouteillage. Le rebut n'est donc
pas aléatoire : il raconte ce qui s'est mal passé dans le procédé.

Convention de nommage (cf. CLAUDE.md) : site.ligne.machine.mesure.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from enum import Enum


class State(str, Enum):
    STOPPED = "stopped"
    RUNNING = "running"
    FAULT = "fault"


_STATE_CODE = {"stopped": 0, "running": 1, "fault": 2}


@dataclass
class Vessel:
    """Une cuve de procédé avec une température cible.

    La qualité (0..1) mesure à quel point la cuve tient sa cible : 1 = parfait,
    elle s'effondre quand la température sort de la plage tolérée.
    """
    name: str
    target_temp: float       # température cible du procédé (°C)
    tolerance: float          # écart toléré avant chute de qualité (°C)
    base_cold: float = 20.0   # température au repos (ambiante) à l'arrêt

    state: State = State.STOPPED
    temperature: float = 20.0
    _ramp: float = 0.0        # 0..1 montée en régime thermique

    def start(self) -> None:
        if self.state != State.FAULT:
            self.state = State.RUNNING

    def stop(self) -> None:
        self.state = State.STOPPED

    def trip(self) -> None:
        self.state = State.FAULT

    def reset_fault(self) -> None:
        if self.state == State.FAULT:
            self.state = State.STOPPED

    def tick(self, dt: float) -> None:
        running = self.state == State.RUNNING
        target_ramp = 1.0 if running else 0.0
        self._ramp += (target_ramp - self._ramp) * min(1.0, dt / 10.0)

        # La cuve chauffe vers sa cible quand elle tourne, refroidit à l'arrêt.
        setpoint = self.base_cold + (self.target_temp - self.base_cold) * self._ramp
        self.temperature += (setpoint - self.temperature) * min(1.0, dt / 25.0)
        self.temperature += random.gauss(0, 0.2)  # bruit capteur

    @property
    def quality(self) -> float:
        """Qualité 0..1 selon l'écart à la cible.

        Plateau « bon » à l'intérieur de la tolérance (une petite erreur ou le
        bruit capteur ne pénalisent quasi pas), puis chute rapide au-delà. À
        l'arrêt, la cuve ne traite rien : qualité neutre (1).
        """
        if self.state != State.RUNNING:
            return 1.0
        # Écart en nombre de tolérances, avec une zone morte d'1/2 tolérance.
        err = abs(self.temperature - self.target_temp)
        slack = max(0.0, err - 0.5 * self.tolerance) / self.tolerance
        return math.exp(-2.0 * slack * slack)

    def tags(self, prefix: str) -> dict[str, float]:
        p = f"{prefix}.{self.name}"
        return {
            f"{p}.state": float(_STATE_CODE[self.state.value]),
            f"{p}.temperature": round(self.temperature, 2),
            f"{p}.temp_cible": self.target_temp,
            f"{p}.qualite": round(self.quality * 100, 1),  # %
        }


@dataclass
class Bottler:
    """Embouteilleuse : produit les bouteilles, OK ou rebut selon la qualité amont."""
    name: str = "embouteilleuse"
    nominal_cadence: float = 50.0   # bouteilles/min
    # Seuil de qualité amont en dessous duquel on n'embouteille pas (moût pas prêt :
    # chauffe en cours, ou incident grave -> on attend plutôt que de gâcher).
    ready_threshold: float = 0.55
    state: State = State.STOPPED
    cadence: float = 0.0
    waiting: bool = False           # en attente d'un moût prêt
    bottles_ok: int = 0
    bottles_rebut: int = 0
    _ramp: float = 0.0
    _accum: float = 0.0

    def start(self) -> None:
        if self.state != State.FAULT:
            self.state = State.RUNNING

    def stop(self) -> None:
        self.state = State.STOPPED

    def trip(self) -> None:
        self.state = State.FAULT

    def reset_fault(self) -> None:
        if self.state == State.FAULT:
            self.state = State.STOPPED

    def tick(self, dt: float, upstream_quality: float) -> None:
        running = self.state == State.RUNNING
        # On n'embouteille que si le moût amont est prêt (sinon on attend).
        self.waiting = running and upstream_quality < self.ready_threshold
        active = running and not self.waiting

        target_ramp = 1.0 if active else 0.0
        self._ramp += (target_ramp - self._ramp) * min(1.0, dt / 8.0)
        self.cadence = round(self.nominal_cadence * self._ramp if active else 0.0, 1)

        if active and self.cadence > 0:
            self._accum += self.cadence * (dt / 60.0)
            while self._accum >= 1.0:
                self._accum -= 1.0
                # Proba de rebut = défaut de qualité amont (+ petit bruit incompressible).
                p_scrap = min(0.95, (1.0 - upstream_quality) + 0.01)
                if random.random() < p_scrap:
                    self.bottles_rebut += 1
                else:
                    self.bottles_ok += 1

    def tags(self, prefix: str) -> dict[str, float]:
        p = f"{prefix}.{self.name}"
        return {
            f"{p}.state": float(_STATE_CODE[self.state.value]),
            f"{p}.cadence": self.cadence,
            f"{p}.en_attente": 1.0 if self.waiting else 0.0,
            f"{p}.bouteilles_ok": float(self.bottles_ok),
            f"{p}.bouteilles_rebut": float(self.bottles_rebut),
        }


@dataclass
class Recipe:
    """Une ligne = une recette : 3 cuves de procédé + 1 embouteilleuse."""
    name: str
    vessels: list[Vessel]
    bottler: Bottler

    def start(self) -> None:
        for v in self.vessels:
            v.start()
        self.bottler.start()

    def stop(self) -> None:
        for v in self.vessels:
            v.stop()
        self.bottler.stop()

    @property
    def upstream_quality(self) -> float:
        """Qualité cumulée des cuves de procédé (produit des qualités)."""
        q = 1.0
        for v in self.vessels:
            q *= v.quality
        return q


@dataclass
class Brewery:
    """La brasserie complète : le cerveau. Protocol-agnostique.

    Expose `state()` -> {tag_métier: valeur}. Ne sait rien des protocoles.
    """
    site: str = "brasserie"
    recipes: list[Recipe] = field(default_factory=list)
    _t: float = 0.0

    @classmethod
    def default(cls) -> "Brewery":
        """Deux recettes : une Blonde (lager, ferment. froide) et une IPA (ale, chaude)."""
        def line(name: str, ferment_temp: float, cadence: float) -> Recipe:
            return Recipe(
                name=name,
                vessels=[
                    # Empâtage : plage enzymatique étroite ~65 °C (au-delà, enzymes tuées).
                    Vessel("empateur", target_temp=65.0, tolerance=4.0),
                    # Ébullition du moût + houblon : ~100 °C.
                    Vessel("ebullition", target_temp=100.0, tolerance=6.0),
                    # Fermentation : LE paramètre qui distingue les recettes.
                    Vessel("fermenteur", target_temp=ferment_temp, tolerance=3.0),
                ],
                bottler=Bottler(nominal_cadence=cadence),
            )
        return cls(recipes=[
            line("blonde", ferment_temp=12.0, cadence=50),  # lager, fermentation froide
            line("ipa", ferment_temp=20.0, cadence=40),     # ale, fermentation chaude
        ])

    def find_vessel(self, recipe: str, vessel: str) -> Vessel | None:
        for r in self.recipes:
            if r.name == recipe:
                for v in r.vessels:
                    if v.name == vessel:
                        return v
        return None

    def find_recipe(self, name: str) -> Recipe | None:
        return next((r for r in self.recipes if r.name == name), None)

    def apply_command(self, tag: str, value: float) -> bool:
        """Applique une consigne reçue (topic tags.cmd) à l'usine.

        Tags pilotables :
          <site>.<recette>.<cuve>.temp_cible  -> change la température cible de la cuve
          <site>.<recette>.<machine>.state    -> 0=stop, 1=run (cuve ou embouteilleuse)
        Renvoie True si la commande a été comprise et appliquée.
        """
        parts = tag.split(".")
        if len(parts) < 4 or parts[0] != self.site:
            return False
        _, recipe_name, machine, field = parts[0], parts[1], parts[2], parts[3]
        recipe = self.find_recipe(recipe_name)
        if not recipe:
            return False

        if field == "temp_cible":
            v = self.find_vessel(recipe_name, machine)
            if v:
                v.target_temp = float(value)
                return True
        elif field == "state":
            run = value >= 1
            target = self.find_vessel(recipe_name, machine)
            obj = target if target else (
                recipe.bottler if recipe.bottler.name == machine else None
            )
            if obj:
                obj.start() if run else obj.stop()
                return True
        return False

    def tick(self, dt: float) -> None:
        self._t += dt
        for r in self.recipes:
            for v in r.vessels:
                v.tick(dt)
            r.bottler.tick(dt, r.upstream_quality)

    def state(self) -> dict[str, float]:
        s: dict[str, float] = {}
        for r in self.recipes:
            prefix = f"{self.site}.{r.name}"
            for v in r.vessels:
                s.update(v.tags(prefix))
            s.update(r.bottler.tags(prefix))
            # Qualité de ligne, pratique pour un widget de synthèse.
            s[f"{prefix}.qualite_ligne"] = round(r.upstream_quality * 100, 1)
        return s
