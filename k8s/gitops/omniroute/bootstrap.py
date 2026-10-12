"""Create the initial OmniRoute Kubernetes Secret without writing keys to Git."""

import base64
import json
import os
from pathlib import Path
import secrets
import ssl
from urllib.error import HTTPError
from urllib.request import Request, urlopen


SERVICE_ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
TOKEN = (SERVICE_ACCOUNT / "token").read_text().strip()
NAMESPACE = (SERVICE_ACCOUNT / "namespace").read_text().strip()
CONTEXT = ssl.create_default_context(cafile=str(SERVICE_ACCOUNT / "ca.crt"))
API = "https://{}:{}/api/v1/namespaces/{}/secrets".format(
    os.environ["KUBERNETES_SERVICE_HOST"],
    os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443"),
    NAMESPACE,
)


def request(method, suffix="", payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = Request(API + suffix, data=data, headers=headers, method=method)
    try:
        with urlopen(req, context=CONTEXT, timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404 and method == "GET":
            return None
        raise


existing = request("GET", "/omniroute-runtime")
required = {
    "initial-password",
    "jwt-secret",
    "api-key-secret",
    "storage-encryption-key",
    "machine-id-salt",
    "ws-bridge-secret",
}
if existing is not None:
    missing = required - set(existing.get("data") or {})
    if missing:
        raise RuntimeError(f"Existing omniroute-runtime Secret lacks keys: {sorted(missing)}")
    print("omniroute-runtime already exists; preserving every key")
else:
    # A new key must never be applied to an existing encrypted OmniRoute DB.
    if (Path("/app/data") / "storage.sqlite").exists():
        raise RuntimeError(
            "OmniRoute database exists but omniroute-runtime is missing; restore original keys"
        )

    values = {
        "initial-password": secrets.token_urlsafe(24),
        "jwt-secret": base64.b64encode(secrets.token_bytes(48)).decode("ascii"),
        "api-key-secret": secrets.token_hex(32),
        "storage-encryption-key": secrets.token_hex(32),
        "machine-id-salt": secrets.token_hex(32),
        "ws-bridge-secret": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
    }
    request(
        "POST",
        payload={
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "omniroute-runtime", "namespace": NAMESPACE},
            "type": "Opaque",
            "data": {
                key: base64.b64encode(value.encode("utf-8")).decode("ascii")
                for key, value in values.items()
            },
        },
    )
    print("omniroute-runtime created with six generated secrets")
