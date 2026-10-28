"""Private project service token configuration for release and verification tools."""
import json
import os
import pathlib
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Access credentials require an HTTPS origin')
    return (parsed.scheme, parsed.hostname.lower(), parsed.port or 443)


def configuration():
    configured = os.environ.get('COC_ACCESS_CONFIG')
    path = pathlib.Path(configured) if configured else ROOT / 'config/cloudflare-service-token.json'
    if not path.exists():
        if configured:
            raise ValueError('Access credential file is missing')
        return None
    if configured and os.name != 'nt' and (path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid()):
        raise ValueError('Access credential file must be private (0600) and owned by the current user')
    if path.stat().st_size > 16384:
        raise ValueError('Access credential file too large')
    try:
        data = json.loads(path.read_text())
    except ValueError:
        raise ValueError('Invalid Access configuration JSON') from None
    for key in ('clientId', 'clientSecret'):
        value = data.get(key)
        if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) <= 32 or ord(c) >= 127 for c in value):
            raise ValueError('Invalid Access credential format')
    if not isinstance(data.get('origins'), list) or not data['origins'] or len(data['origins']) > 32:
        raise ValueError('Trusted Access origins are required')
    for value in data['origins']:
        parsed = urllib.parse.urlsplit(value)
        origin(value)
        if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('Access origins cannot contain paths or queries')
    return data


def request_headers(url):
    data = configuration()
    if not data:
        return None
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or origin(url) not in [origin(value) for value in data['origins']]:
        return None
    return ('CF-Access-Client-Id: ' + data['clientId'] + '\nCF-Access-Client-Secret: ' + data['clientSecret'] + '\n').encode()
