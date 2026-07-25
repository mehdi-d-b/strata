"""Régressions de contrat pour les outils d'écriture exposés au LLM.

Ces tests ne lancent ni Ollama ni la gateway : ils vérifient le garde-fou le
plus important, à savoir qu'un modèle ne peut plus recevoir un outil générique
permettant de choisir un tag/une valeur PLC arbitraires.
"""
import unittest

from routing import detect_line_blocked
from tools import ALL_TOOLS, WRITE_TOOLS, adjust_setpoint, request_operation


class OperationToolContractTests(unittest.TestCase):
    def test_only_catalogued_write_tools_are_exposed(self) -> None:
        self.assertEqual(WRITE_TOOLS, {"request_operation", "adjust_setpoint", "ack_alarm"})
        self.assertNotIn("set_command", {tool.name for tool in ALL_TOOLS})

    def test_line_operation_has_no_free_tag_or_value(self) -> None:
        schema = request_operation.args_schema.model_json_schema()
        self.assertEqual(set(schema["properties"]), {"operation_id", "line"})
        self.assertEqual(schema["properties"]["operation_id"]["enum"], ["start_line", "stop_line"])

    def test_setpoint_has_no_free_tag_only_a_closed_vessel_enum(self) -> None:
        schema = adjust_setpoint.args_schema.model_json_schema()
        self.assertEqual(set(schema["properties"]), {"line", "vessel", "value"})
        self.assertEqual(schema["properties"]["vessel"]["enum"], ["empateur", "ebullition", "fermenteur"])
        self.assertEqual(schema["properties"]["value"]["type"], "number")

    def test_blocked_line_router_requires_one_known_line(self) -> None:
        recipes = ["blonde", "ipa", "jalapeno"]
        self.assertEqual(detect_line_blocked("La ligne blonde ne bouge plus", recipes), "brasserie.blonde")
        self.assertIsNone(detect_line_blocked("Ma ligne est bloquée", recipes))
        self.assertIsNone(detect_line_blocked("Pourquoi la blonde est conforme ?", recipes))


if __name__ == "__main__":
    unittest.main()
