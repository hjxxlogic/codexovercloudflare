"""Compile the project's shared Access configuration into the native programs."""
import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output')
    args = parser.parse_args()
    data = json.loads((ROOT / 'config/cloudflare-service-token.json').read_text())
    for key in ('clientId', 'clientSecret'):
        value = data.get(key)
        if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) <= 32 or ord(c) >= 127 for c in value):
            raise ValueError('Invalid project Cloudflare service token')
    if not isinstance(data.get('origins'), list) or not data['origins']:
        raise ValueError('Trusted project origins are required')
    path = pathlib.Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    contents = '#pragma once\nnamespace coc {\ninline constexpr char access_defaults[] = ' + json.dumps(json.dumps(data, separators=(',', ':'))) + ';\n}\n'
    if not path.exists() or path.read_text() != contents:
        path.write_text(contents)


if __name__ == '__main__':
    main()
