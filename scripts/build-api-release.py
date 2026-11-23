"""Build a source-only API archive from clean tracked runtime paths.

No credentials, private evidence or ignored working files are selected. This
does not deploy or modify a server. Run after committing runtime changes.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SELECTION = ('backend', 'deploy/certs', 'scripts/measurements/columns.json')
REQUIRED = {
    'backend/app.py', 'backend/requirements.txt',
    'scripts/measurements/columns.json',
    'deploy/certs/supabase-prod-ca-2021.crt',
}


def git(*args):
    return subprocess.check_output(('git', *args), cwd=ROOT)


def build(output):
    paths = sorted(git('ls-files', '-z', '--', *SELECTION).decode().strip('\0').split('\0'))
    if not REQUIRED <= set(paths):
        raise ValueError('Required API runtime source/dictionary/CA is not tracked')
    if git('status', '--porcelain', '--untracked-files=no', '--', *SELECTION).strip():
        raise ValueError('Commit selected API runtime changes before packaging')
    for path in paths:
        p = Path(path)
        if ('data' in p.parts or p.name.startswith('.env') or p.suffix in ('.key', '.pem', '.sqlite', '.db', '.mmdb')
                or not (ROOT / p).is_file() or (ROOT / p).is_symlink()):
            raise ValueError(f'Unexpected private or nonregular runtime path: {path}')
    output = output.resolve()
    if not str(output).endswith('.tar.gz'):
        raise ValueError('Output must end in .tar.gz')
    commit = git('rev-parse', 'HEAD').decode().strip()
    epoch = int(git('show', '-s', '--format=%ct', 'HEAD'))
    manifest = {'sourceCommit': commit, 'selectedRuntimePathsClean': True,
                'files': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths}}
    payload = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)

    def normalized(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        info.mtime = epoch
        return info

    with output.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=epoch) as compressed:
        os.chmod(output, 0o600)
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for path in paths:
                archive.add(ROOT / path, arcname=path, recursive=False, filter=normalized)
            info = normalized(tarfile.TarInfo('skymeasure-release.json'))
            info.size, info.mode = len(payload), 0o600
            archive.addfile(info, io.BytesIO(payload))
    companion = output.with_suffix(output.suffix + '.manifest.json')
    companion.write_bytes(payload)
    os.chmod(companion, 0o600)
    return {'archive': str(output), 'sourceCommit': commit, 'files': len(paths),
            'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.out), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{error}\n')
