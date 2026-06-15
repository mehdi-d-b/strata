"""Cerveau de la micro-brasserie Strata : simule le procédé, sans aucun protocole.

Deux lignes = deux recettes brassées en parallèle (Blonde, IPA). Chaque ligne
enchaîne 4 cuves : empâtage → ébullition → fermentation → embouteillage.

Le point *smart* : chaque cuve de procédé a une température CIBLE, et s'en écarter
dégrade la qualité de façon crédible (empâtage trop chaud = enzymes dénaturées,
rendement faible ; fermentation trop chaude = batch hors spec). La qualité
cumulée des cuves pilote le taux de rebut à l'embouteillage. Le rebut n'est donc
pas aléatoire : il raconte ce qui s'est mal passé dans le procédé.

Un brassage entre un start et un stop de ligne = un BATCH. À sa clôture, un verdict
QC est CALCULÉ depuis la qualité réelle observée (jamais une étiquette aléatoire) ;
c'est ce que l'assistant IA enquêtera. Cf. docs/simulator-scenarios.md.

Convention de nommage (cf. CLAUDE.md) : site.ligne.machine.mesure.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from enum import Enum


class State(str, Enum):
    STOPPED = "stopped"
    RUNNING = "running"
    FAULT = "fault"


_STATE_CODE = {"stopped": 0, "running": 1, "fault": 2}

# Bruit de MESURE (sur la valeur publiée uniquement) : un capteur réel bruite la
# lecture, il ne fait pas DÉRIVER la température réelle. L'état reste lissé/tenu par
# la régulation ; ce bruit ne s'ajoute qu'au tag publié (cf. Vessel.tags).
_MEAS_NOISE = 0.2  # °C

# Codes de verdict QC d'un batch (NUMÉRIQUES car tags.raw ne transporte que des
# nombres). La gateway mappe ces codes vers un defaut_type texte pour la table
# `batches`. Un verdict = RÉSULTAT QC (le batch est-il conforme, quel défaut), pas la
# forme de la cause : une dérive lente et un emballement rapide donnent le MÊME
# verdict fermentation_hors_spec — c'est la timeline que l'assistant analyse pour
# remonter à la cause. NB : ici c'est le simulateur (oracle) qui calcule le verdict ;
# en usine réelle il vient du QC/labo (cf. docs/simulator-scenarios.md).
VERDICT_OK = 0
VERDICT_FERMENTATION_HORS_SPEC = 1   # fermenteur hors plage (S1 emballement, S5 dérive lente)
VERDICT_RENDEMENT_FAIBLE = 2         # empâtage/ébullition hors plage (S2)
VERDICT_CONTAMINATION = 3            # sanitation insuffisante / CIP écourté (S3)
VERDICT_VOLUME_INSUFFISANT = 4       # objectif de volume manqué, qualité OK (S4)

# Décision du verdict.
_SETTLED_QUALITY = 0.95        # qualité atteinte une 1ère fois = cuve stabilisée à sa cible
_OB_QUALITY_THRESHOLD = 0.85   # bande "bonne" ; en dessous = déviation
# On mesure la SÉVÉRITÉ INTÉGRÉE de la déviation, pas une durée binaire :
#   score = ∫ max(0, seuil - qualité) dt   (aire sous la bande, pondérée par l'ampleur).
# Ainsi une dérive COURTE mais SÉVÈRE est vue, une dérive LENTE aussi, et le bruit de
# stabilisation (qualité au ras du seuil quelques secondes) reste négligeable — la
# détection dépend de la GRAVITÉ réelle, pas du timing.
_SEVERITY_DEFECT = 4.0         # score de sévérité qui qualifie un défaut qualité
_FAULT_SECONDS_DEFECT = 20.0   # durée de panne embouteilleuse → volume_insuffisant
_CONTAM_QUALITY_FACTOR = 0.6   # CIP écourté : qualité de ligne dégradée (indépendante de la temp)


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
    drift_rate: float = 0.0   # dérive lente : vitesse de décalage de l'équilibre (°C/s) (S5)
    _drift_offset: float = 0.0  # décalage d'équilibre accumulé (°C)

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

        # Dérive lente (S5) : l'ÉQUILIBRE thermique se décale peu à peu (ex. groupe
        # froid qui faiblit). On déplace le point d'équilibre, pas la température
        # directement : la régulation suit sans "voir" l'erreur, donc la vraie
        # température part doucement hors plage (et n'est pas compensée).
        if running and self.drift_rate:
            self._drift_offset += self.drift_rate * dt
        # La cuve chauffe vers sa cible quand elle tourne, refroidit à l'arrêt.
        # État LISSÉ (régulation) : pas de bruit ajouté ici — le bruit est une mesure
        # (cf. Vessel.tags), il ne fait pas dériver la température réelle.
        setpoint = (
            self.base_cold + (self.target_temp - self.base_cold) * self._ramp
            + self._drift_offset
        )
        self.temperature += (setpoint - self.temperature) * min(1.0, dt / 25.0)

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
        # Température PUBLIÉE = vraie température + bruit de mesure (le capteur bruite
        # la lecture, pas le procédé). La qualité/verdict se calculent sur la vraie.
        measured = self.temperature + random.gauss(0, _MEAS_NOISE)
        return {
            f"{p}.state": float(_STATE_CODE[self.state.value]),
            f"{p}.temperature": round(measured, 2),
            f"{p}.temp_cible": self.target_temp,
            # Tolérance publiée -> la BANDE NOMINALE [temp_cible ± temp_tol] devient une
            # donnée (par cuve = par phase, par recette via le nom du tag). C'est ce qui
            # rend la déviation calculable génériquement (cf. get_batch_context).
            f"{p}.temp_tol": self.tolerance,
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
    """Une ligne = une recette : 3 cuves de procédé + 1 embouteilleuse.

    Un brassage entre start() et stop() = un BATCH. Pendant le batch, on accumule le
    temps passé hors plage par cuve et le temps de panne embouteilleuse ; à la clôture
    on en DÉDUIT un verdict QC (cf. _decide_verdict). `last_batch` garde le dernier
    batch clôturé pour que la gateway le persiste (la donnée reste sur le bus).
    """
    name: str
    vessels: list[Vessel]
    bottler: Bottler

    # Sanitation (axe NON thermique) : nettoyage conforme avant brassage ? Un CIP
    # écourté contamine le batch sans déviation de température (cause discriminante).
    cip_ok: bool = True                                # consigne CIP du PROCHAIN batch

    # --- Cycle de batch ---
    batch_id: int = 0                                  # 0 = aucun batch actif
    batch_started_at: float = 0.0                      # epoch (s) du début du batch
    _batch_cip_ok: bool = True                         # CIP du batch courant (figé à l'ouverture)
    _severity: dict[str, float] = field(default_factory=dict)  # sévérité intégrée / cuve
    _settled: set[str] = field(default_factory=set)    # cuves ayant atteint leur cible
    _fault_seconds: float = 0.0                        # s de panne embouteilleuse
    _ok_at_start: int = 0
    _rebut_at_start: int = 0
    last_batch: dict | None = None                     # résumé du dernier batch clôturé

    def start(self) -> None:
        for v in self.vessels:
            v.start()
        self.bottler.start()
        if self.batch_id == 0:
            self._open_batch()

    def stop(self) -> None:
        for v in self.vessels:
            v.stop()
        self.bottler.stop()
        if self.batch_id != 0:
            self._close_batch()

    @property
    def upstream_quality(self) -> float:
        """Qualité cumulée des cuves de procédé (produit des qualités).

        Un CIP écourté contamine le moût : qualité dégradée INDÉPENDAMMENT de la
        température (les cuves restent nominales) -> rebut qui monte, mais aucune
        sévérité thermique. C'est ce qui rend la cause discriminable.
        """
        q = 1.0
        for v in self.vessels:
            q *= v.quality
        if self.batch_id != 0 and not self._batch_cip_ok:
            q *= _CONTAM_QUALITY_FACTOR
        return q

    # --- Batch : ouverture / accumulation / clôture ---------------------------

    def _open_batch(self) -> None:
        now = time.time()
        self.batch_id = int(now)            # epoch s ; la gateway compose un id unique avec la ligne
        self.batch_started_at = now
        self._batch_cip_ok = self.cip_ok    # fige le CIP de CE batch
        self.cip_ok = True                  # consigne consommée -> prochain batch propre par défaut
        for v in self.vessels:
            v.drift_rate = 0.0              # aucune dérive héritée du batch précédent
            v._drift_offset = 0.0
        self._severity = {v.name: 0.0 for v in self.vessels}
        self._settled = set()
        self._fault_seconds = 0.0
        self._ok_at_start = self.bottler.bottles_ok
        self._rebut_at_start = self.bottler.bottles_rebut

    def accumulate(self, dt: float) -> None:
        """Intègre la sévérité de déviation (par cuve) et la panne, pendant le batch."""
        if self.batch_id == 0:
            return
        for v in self.vessels:
            if v.state != State.RUNNING:
                continue
            # Tant que la cuve n'a pas atteint sa cible une 1ère fois, on est en
            # warmup : c'est normal (le régime stable met du temps à arriver), on ne
            # compte rien. Une fois stabilisée, on intègre l'aire sous la bande,
            # pondérée par l'ampleur de la chute de qualité (sévérité × durée).
            if v.name not in self._settled:
                if v.quality >= _SETTLED_QUALITY:
                    self._settled.add(v.name)
                continue
            deficit = _OB_QUALITY_THRESHOLD - v.quality
            if deficit > 0:
                self._severity[v.name] = self._severity.get(v.name, 0.0) + deficit * dt
        if self.bottler.state == State.FAULT:
            self._fault_seconds += dt

    def _batch_rebut_pct(self) -> float:
        ok = self.bottler.bottles_ok - self._ok_at_start
        rebut = self.bottler.bottles_rebut - self._rebut_at_start
        total = ok + rebut
        return round(100.0 * rebut / total, 1) if total > 0 else 0.0

    def _decide_verdict(self) -> int:
        """Verdict CALCULÉ depuis l'observé. Défaut qualité prioritaire sur le volume."""
        worst_name, worst = max(
            self._severity.items(), key=lambda kv: kv[1], default=(None, 0.0)
        )
        if worst >= _SEVERITY_DEFECT:
            return (
                VERDICT_FERMENTATION_HORS_SPEC
                if worst_name == "fermenteur"
                else VERDICT_RENDEMENT_FAIBLE
            )
        if not self._batch_cip_ok:
            return VERDICT_CONTAMINATION
        if self._fault_seconds >= _FAULT_SECONDS_DEFECT:
            return VERDICT_VOLUME_INSUFFISANT
        return VERDICT_OK

    def _close_batch(self) -> None:
        self.last_batch = {
            "id": self.batch_id,
            "started_at": self.batch_started_at,
            "ended_at": time.time(),
            "verdict": self._decide_verdict(),
            "rebut_pct": self._batch_rebut_pct(),
        }
        self.batch_id = 0

    def batch_tags(self, prefix: str) -> dict[str, float]:
        """Tags du batch : le batch EN COURS (verdict provisoire) sinon le DERNIER clôturé."""
        p = f"{prefix}.batch"
        if self.batch_id != 0:
            return {
                f"{p}.id": float(self.batch_id),
                f"{p}.phase": 1.0,              # 1 = brassage en cours (phases fines à venir)
                f"{p}.qc_verdict": 0.0,         # provisoire tant que non clôturé
                f"{p}.rebut_pct": self._batch_rebut_pct(),
            }
        if self.last_batch:
            return {
                f"{p}.id": float(self.last_batch["id"]),
                f"{p}.phase": 5.0,              # 5 = clôturé
                f"{p}.qc_verdict": float(self.last_batch["verdict"]),
                f"{p}.rebut_pct": float(self.last_batch["rebut_pct"]),
            }
        return {
            f"{p}.id": 0.0,
            f"{p}.phase": 0.0,                  # 0 = aucun batch
            f"{p}.qc_verdict": 0.0,
            f"{p}.rebut_pct": 0.0,
        }


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
        """Trois recettes, chacune avec ses consignes/bandes par phase (empâtage,
        ébullition, fermentation) : Blonde (lager), IPA (ale) et Jalapeño (ale épicée).
        Le nom du tag portant la recette, les bandes nominales sont de fait par recette.
        """
        def line(name: str, ferment_temp: float, cadence: float,
                 mash_temp: float = 65.0) -> Recipe:
            return Recipe(
                name=name,
                vessels=[
                    # Empâtage : plage enzymatique étroite (au-delà, enzymes dénaturées).
                    Vessel("empateur", target_temp=mash_temp, tolerance=4.0),
                    # Ébullition du moût + houblon : ~100 °C.
                    Vessel("ebullition", target_temp=100.0, tolerance=6.0),
                    # Fermentation : LE paramètre qui distingue le plus les recettes.
                    Vessel("fermenteur", target_temp=ferment_temp, tolerance=3.0),
                ],
                bottler=Bottler(nominal_cadence=cadence),
            )
        return cls(recipes=[
            line("blonde", ferment_temp=12.0, cadence=50, mash_temp=65.0),   # lager, ferment. froide
            line("ipa", ferment_temp=20.0, cadence=40, mash_temp=66.0),      # ale, ferment. chaude
            line("jalapeno", ferment_temp=19.0, cadence=35, mash_temp=64.0), # ale épicée
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
            r.accumulate(dt)  # comptabilise hors-plage / panne pour le verdict du batch

    def state(self) -> dict[str, float]:
        s: dict[str, float] = {}
        for r in self.recipes:
            prefix = f"{self.site}.{r.name}"
            for v in r.vessels:
                s.update(v.tags(prefix))
                # Tag d'alarme BOOLÉEN dérivé (façon tag d'alarme PLC / Type B) :
                # 1 quand la cuve s'écarte fortement de sa cible. Corrélé aux
                # incidents du scénario (surchauffe, coup de chaud…), pas aléatoire.
                drift = abs(v.temperature - v.target_temp)
                running = v.state == State.RUNNING
                s[f"{prefix}.{v.name}.defaut_thermique"] = (
                    1.0 if running and drift > 2 * v.tolerance else 0.0
                )
                # Bit de panne de la cuve (état FAULT).
                s[f"{prefix}.{v.name}.panne"] = 1.0 if v.state == State.FAULT else 0.0
            s.update(r.bottler.tags(prefix))
            s[f"{prefix}.{r.bottler.name}.panne"] = (
                1.0 if r.bottler.state == State.FAULT else 0.0
            )
            # Qualité de ligne, pratique pour un widget de synthèse.
            q = round(r.upstream_quality * 100, 1)
            s[f"{prefix}.qualite_ligne"] = q
            # Warning qualité basse (event booléen de ligne).
            s[f"{prefix}.qualite_basse"] = 1.0 if q < 80 else 0.0
            # Sanitation du batch courant (1 = CIP conforme) : cause discriminante.
            s[f"{prefix}.cip_ok"] = 1.0 if r._batch_cip_ok else 0.0
            # Tags du batch (en cours ou dernier clôturé) : id, phase, verdict, rebut.
            s.update(r.batch_tags(prefix))
        return s
