"""Client HTTP vers la gateway — seule porte d'entrée aux données Strata (pas
d'accès direct à Postgres/Kafka depuis ce service, cf. docs/roadmap.md).

Authentifié via un compte de service (login + cookie de session), comme
n'importe quel client HTTP de la gateway. Ce n'est PAS l'identité de
l'opérateur qui discute avec l'assistant, et ça ne le sera jamais : ce client
ne sert qu'à LIRE (tools de lecture, résumé d'une action proposée). Les
actions d'écriture confirmées sont exécutées par le NAVIGATEUR (vraie session,
vraie RBAC), jamais par ce client — cf. graph.py::_write_intercept_node.
"""
import os

import httpx

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://localhost:3001")
AI_SERVICE_USERNAME = os.environ.get("AI_SERVICE_USERNAME", "assistant-service")
AI_SERVICE_PASSWORD = os.environ.get("AI_SERVICE_PASSWORD", "")

_client = httpx.AsyncClient(base_url=GATEWAY_URL, timeout=30.0)
_logged_in = False


async def _ensure_login() -> None:
    global _logged_in
    if _logged_in:
        return
    if not AI_SERVICE_PASSWORD:
        raise RuntimeError("AI_SERVICE_PASSWORD doit être défini pour ai-service")
    resp = await _client.post(
        "/api/auth/login",
        json={"username": AI_SERVICE_USERNAME, "password": AI_SERVICE_PASSWORD},
    )
    resp.raise_for_status()
    _logged_in = True


async def get(path: str, params: dict | None = None) -> httpx.Response:
    await _ensure_login()
    resp = await _client.get(path, params=params)
    if resp.status_code == 401:
        # session expirée ou premier appel avant tout login : reessaie une fois.
        global _logged_in
        _logged_in = False
        await _ensure_login()
        resp = await _client.get(path, params=params)
    return resp


async def post(path: str, json: dict) -> httpx.Response:
    await _ensure_login()
    resp = await _client.post(path, json=json)
    if resp.status_code == 401:
        global _logged_in
        _logged_in = False
        await _ensure_login()
        resp = await _client.post(path, json=json)
    return resp
