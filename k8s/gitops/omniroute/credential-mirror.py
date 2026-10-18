"""Sync only approved provider credentials from llm-runtime into rr Secrets."""
import base64
import json
import os
from pathlib import Path
import ssl
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SA = Path('/var/run/secrets/kubernetes.io/serviceaccount')
BEARER = (SA / 'token').read_text().strip()
CONTEXT = ssl.create_default_context(cafile=str(SA / 'ca.crt'))
ROOT = 'https://{}:{}'.format(os.environ['KUBERNETES_SERVICE_HOST'], os.environ.get('KUBERNETES_SERVICE_PORT_HTTPS', '443'))


def kube(method, path, data=None):
    payload = None if data is None else json.dumps(data).encode('utf-8')
    req = Request(ROOT + path, data=payload, method=method, headers={
        'Authorization': 'Bearer ' + BEARER, 'Accept': 'application/json',
        **({'Content-Type': 'application/merge-patch+json' if method == 'PATCH' else 'application/json'} if payload is not None else {}),
    })
    try:
        with urlopen(req, timeout=15, context=CONTEXT) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404 and method == 'GET':
            return None
        raise RuntimeError('Kubernetes {} {} HTTP {}'.format(method, path, error.code)) from None


def read_secret(name):
    source = kube('GET', '/api/v1/namespaces/llm-runtime/secrets/' + name)
    if source is None or not (source.get('data') or {}).get('api-key'):
        raise RuntimeError('Missing source Secret ' + name)
    return source['data']['api-key']


def read_oauth(path):
    raw = Path(path).read_bytes().strip()
    if not raw:
        raise RuntimeError('Empty OAuth file ' + path)
    return base64.b64encode(raw).decode('ascii')


def sync(name, field, encoded):
    root = '/api/v1/namespaces/rr/secrets'
    old = kube('GET', root + '/' + name)
    if old is not None and (old.get('data') or {}).get(field) == encoded:
        return False
    if old is None:
        kube('POST', root, {
            'apiVersion':'v1', 'kind':'Secret', 'metadata':{'name':name,'namespace':'rr',
                'labels':{'app.kubernetes.io/managed-by':'omniroute-credential-mirror'}},
            'type':'Opaque', 'data':{field:encoded},
        })
    else:
        kube('PATCH', root + '/' + name, {'data':{field:encoded}})
    return True


def reconcile():
    data = [
        ('rr-omniroute-codex','auth-json',read_oauth('/codex-auth/auth.json')),
        ('rr-omniroute-agy','auth-json',read_oauth('/agy-auth/.gemini/antigravity-cli/antigravity-oauth-token')),
        ('rr-omniroute-glm','api-key',read_secret('rr-zai-coding')),
        ('rr-omniroute-opencode','api-key',read_secret('rr-opencode-zen')),
    ]
    changed = sum(sync(*entry) for entry in data)
    if changed:
        print('OmniRoute credentials synced: {} Secret(s) updated'.format(changed), flush=True)


while True:
    try:
        reconcile()
    except Exception as error:
        # No keys or OAuth material ever written to logs.
        print('OmniRoute credential mirror: {}: {}'.format(type(error).__name__, str(error)[:200]), flush=True)
    time.sleep(30)
