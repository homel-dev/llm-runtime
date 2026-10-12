"""Create the MCP session key once, preserving existing Helm release state."""

import base64
import json
import os
from pathlib import Path
import secrets
import ssl
from urllib.error import HTTPError
from urllib.request import Request, urlopen


SERVICE_ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
token = (SERVICE_ACCOUNT / "token").read_text().strip()
namespace = (SERVICE_ACCOUNT / "namespace").read_text().strip()
context = ssl.create_default_context(cafile=str(SERVICE_ACCOUNT / "ca.crt"))
endpoint = "https://{}:{}/api/v1/namespaces/{}/secrets".format(
    os.environ["KUBERNETES_SERVICE_HOST"],
    os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443"),
    namespace,
)


def request(method, suffix="", payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = Request(endpoint + suffix, data=body, headers=headers, method=method)
    try:
        with urlopen(req, context=context, timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404 and method == "GET":
            return None
        raise


current = request("GET", "/llm-runtime-mcp-session")
if current is not None:
    if not (current.get("data") or {}).get("seed"):
        raise RuntimeError("Existing llm-runtime-mcp-session has no seed")
    print("llm-runtime-mcp-session already exists; preserving its seed")
else:
    seed = secrets.token_hex(32)
    request(
        "POST",
        payload={
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "llm-runtime-mcp-session", "namespace": namespace},
            "type": "Opaque",
            "data": {"seed": base64.b64encode(seed.encode("utf-8")).decode("ascii")},
        },
    )
    print("llm-runtime-mcp-session created")
