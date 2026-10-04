"""Package the compiled Apache-2.0 game engine for a private Kaggle source dataset."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import zipfile

FILES = (
    'package.json', 'LICENSE',
    'lib/game/ai.js', 'lib/game/cards.js', 'lib/game/engine.js',
    'lib/game/rules.js', 'lib/game/types.js',
    'offline/ai-benchmark.js', 'offline/ai-gateway.js', 'offline/strong-ai.js',
    'offline/selfplay.js', 'offline/neural-policy.js',
    'offline/cloud-selfplay.js', 'offline/check-model.mjs',
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--compiled', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--node-tar', type=Path)
    parser.add_argument('--node-shasums', type=Path)
    parser.add_argument('--reference-model', type=Path)
    args = parser.parse_args()
    if not args.owner.isascii() or not args.owner.replace('-', '').replace('_', '').isalnum():
        raise ValueError('Invalid Kaggle owner')
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / 'engine.zip'
    checksums = {}
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for relative in FILES:
            data = (args.compiled / relative).read_bytes()
            checksums[relative] = hashlib.sha256(data).hexdigest()
            bundle.writestr(relative, data)
    node_archive = args.output / 'node-linux-x64.zip'
    if args.node_tar or args.node_shasums:
        if not args.node_tar or not args.node_shasums:
            raise ValueError('Node archive and official checksums are both required')
        expected = next((line.split()[0] for line in args.node_shasums.read_text().splitlines()
                         if line.endswith('  ' + args.node_tar.name)), None)
        actual = hashlib.sha256(args.node_tar.read_bytes()).hexdigest()
        if not expected or actual != expected:
            raise ValueError('Official Node archive checksum mismatch')
        with tarfile.open(args.node_tar, 'r:xz') as source:
            members = [m for m in source.getmembers() if m.name.endswith('/bin/node')]
            if len(members) != 1 or not members[0].isfile():
                raise ValueError('Official Node binary is missing')
            with zipfile.ZipFile(node_archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as target:
                with source.extractfile(members[0]) as binary:
                    target.writestr('node', binary.read())
        checksums['node-linux-x64.zip'] = hashlib.sha256(node_archive.read_bytes()).hexdigest()
    else:
        raise ValueError('A verified Linux Node binary is required for offline Kaggle execution')
    if args.reference_model:
        model = json.loads(args.reference_model.read_text(encoding='utf-8'))
        if model.get('kind') != 'guandan-action-mlp' or model.get('version') != 1:
            raise ValueError('Reference model format mismatch')
        reference = args.output / 'reference-v016.json'
        shutil.copyfile(args.reference_model, reference)
        checksums[reference.name] = hashlib.sha256(reference.read_bytes()).hexdigest()
    metadata = {
        'title': 'Guandan AI Engine v017 Private Training Source',
        'id': f'{args.owner}/guandan-ai-engine-v017',
        'licenses': [{'name': 'apache-2.0'}],
        'description': 'Compiled Apache-2.0 GuanDan Lab offline rules and policy engine, plus official Node.js binary. Private training input; original engine license included.',
    }
    (args.output / 'dataset-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    (args.output / 'checksums.json').write_text(json.dumps(checksums, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': list(checksums), 'dataset': metadata['id'],
                      'bytes': sum(p.stat().st_size for p in args.output.iterdir() if p.is_file())}))


if __name__ == '__main__':
    main()
