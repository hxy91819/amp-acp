#!/usr/bin/env python3
"""Version 1 of this fork's GitHub binary release adapter (stdlib + gh)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import zipfile

PLATFORMS = ('linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64')
TAG = re.compile(r'fork-v(\d+\.\d+\.\d+)-\d{8}\.[1-9]\d*')


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def archive_name(platform):
    return f'amp-acp-{platform}.' + ('zip' if platform == 'windows-x64' else 'tar.gz')


def identity(tag, commit):
    match = TAG.fullmatch(tag)
    if not match or not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('Invalid fork tag or source commit')
    return match[1]


def source(tag, commit):
    version = identity(tag, commit)
    assert run('git', 'rev-parse', 'HEAD') == commit, 'Checkout differs from source'
    assert run('git', 'cat-file', '-t', f'refs/tags/{tag}') == 'tag', 'Use an annotated tag'
    assert run('git', 'rev-parse', f'refs/tags/{tag}^{{commit}}') == commit, 'Tag moved'
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'origin/local/aggregate'], check=True)
    assert json.loads(Path('package.json').read_text())['version'] == version, 'Package/tag version mismatch'


def metadata(tag, commit, platform):
    assert platform in PLATFORMS, 'Unsupported platform'
    return dict(format=1, tag=tag, sourceCommit=commit, platform=platform,
                packageVersion=identity(tag, commit), requires='Amp CLI installed and authenticated')


def pack(binary, output, tag, commit, platform):
    assert binary.is_file() and not binary.is_symlink(), 'Missing regular binary'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        name = 'amp-acp.exe' if platform == 'windows-x64' else 'amp-acp'
        (stage / name).write_bytes(binary.read_bytes())
        (stage / name).chmod(0o755)
        (stage / 'LICENSE').write_bytes(Path('LICENSE').read_bytes())
        (stage / 'INSTALL.md').write_bytes(Path('docs/fork-release.md').read_bytes())
        (stage / 'VERSION.json').write_text(json.dumps(metadata(tag, commit, platform), indent=2) + '\n')
        archive = output / archive_name(platform)
        if platform == 'windows-x64':
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
                for file in sorted(stage.iterdir()):
                    bundle.write(file, file.name)
        else:
            with tarfile.open(archive, 'w:gz') as bundle:
                for file in sorted(stage.iterdir()):
                    bundle.add(file, arcname=file.name)
    return archive


def unpack(archive, destination, platform):
    expected = {'amp-acp.exe' if platform == 'windows-x64' else 'amp-acp', 'LICENSE', 'INSTALL.md', 'VERSION.json'}
    destination.mkdir(parents=True, exist_ok=True)
    if platform == 'windows-x64':
        with zipfile.ZipFile(archive) as bundle:
            assert set(bundle.namelist()) == expected and len(bundle.infolist()) == len(expected), 'Unexpected archive entries'
            for member in bundle.infolist():
                assert (member.external_attr >> 16) & 0o170000 != 0o120000, 'Archive symlink'
                (destination / member.filename).write_bytes(bundle.read(member))
    else:
        with tarfile.open(archive) as bundle:
            members = bundle.getmembers()
            assert {m.name for m in members} == expected and len(members) == len(expected), 'Unexpected archive entries'
            for member in members:
                assert member.isfile(), 'Archive contains a link or special file'
                (destination / member.name).write_bytes(bundle.extractfile(member).read())
    binary = destination / ('amp-acp.exe' if platform == 'windows-x64' else 'amp-acp')
    binary.chmod(0o755)
    return binary


def smoke(archive, tag, commit, platform):
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        binary = unpack(archive, stage, platform)
        assert json.loads((stage / 'VERSION.json').read_text()) == metadata(tag, commit, platform), 'Wrong archive identity'
        env = {k: v for k, v in os.environ.items() if not k.startswith(('AMP_', 'BB_'))}
        env.update(AMP_ACP_MODE_SOURCE='local', AMP_ACP_DISABLE_PLUGIN_LIST='1',
                   XDG_CONFIG_HOME=str(stage / 'config'), XDG_STATE_HOME=str(stage / 'state'))
        request = json.dumps(dict(jsonrpc='2.0', id=1, method='initialize', params=dict(protocolVersion=1, clientCapabilities={}))) + '\n'
        result = subprocess.run([str(binary)], input=request, text=True, capture_output=True, env=env, timeout=20, check=True)
        reply = next(json.loads(line)['result'] for line in result.stdout.splitlines() if json.loads(line).get('id') == 1)
        assert reply['agentInfo']['name'] == 'amp-acp'
        assert reply['agentInfo']['version'] == identity(tag, commit)
        assert reply['agentCapabilities']['promptCapabilities']['image'] is True
        assert reply['_meta']['midTurnSteering'] is True
    print(f'Installed archive ACP smoke passed: {platform}')


def notes(tag, commit):
    changelog = Path('CHANGELOG.fork.md').read_text()
    match = re.search(r'^## ' + re.escape(tag) + r'\n(.*?)(?=^## |\Z)', changelog, re.M | re.S)
    assert match and match[1].strip(), 'Missing committed release notes'
    return match[1].strip() + f'\n\nSource commit: `{commit}`\nRelease tag: `{tag}`\n'


def assemble(directory, tag, commit):
    files = {}
    for platform in PLATFORMS:
        archive = directory / archive_name(platform)
        with tempfile.TemporaryDirectory() as temporary:
            unpack(archive, Path(temporary), platform)
            assert json.loads((Path(temporary) / 'VERSION.json').read_text()) == metadata(tag, commit, platform)
        files[archive.name] = dict(sha256=digest(archive), size=archive.stat().st_size)
    (directory / 'SHA256SUMS').write_text(''.join(f'{record["sha256"]}  {name}\n' for name, record in sorted(files.items())))
    (directory / 'release-notes.md').write_text(notes(tag, commit))
    for name in ('SHA256SUMS', 'release-notes.md'):
        file = directory / name
        files[name] = dict(sha256=digest(file), size=file.stat().st_size)
    (directory / 'manifest.json').write_text(json.dumps(dict(format=1, tag=tag, sourceCommit=commit,
        packageVersion=identity(tag, commit), platforms=list(PLATFORMS), files=files), indent=2) + '\n')
    verify(directory, tag, commit)


def verify(directory, tag, commit):
    identity(tag, commit)
    manifest = json.loads((directory / 'manifest.json').read_text())
    assert (manifest['format'], manifest['tag'], manifest['sourceCommit'], manifest['packageVersion'], manifest['platforms']) == (
        1, tag, commit, identity(tag, commit), list(PLATFORMS)), 'Manifest source mismatch'
    expected = {archive_name(p) for p in PLATFORMS} | {'SHA256SUMS', 'release-notes.md'}
    assert set(manifest['files']) == expected, 'Incomplete asset manifest'
    assert {p.name for p in directory.iterdir()} == expected | {'manifest.json'}, 'Unexpected bundle entries'
    for name, record in manifest['files'].items():
        file = directory / name
        assert file.is_file() and not file.is_symlink(), 'Asset is not a regular file'
        assert record == dict(sha256=digest(file), size=file.stat().st_size), f'Asset changed: {name}'
    return manifest


def gh_json(*args, absent=False):
    result = subprocess.run(['gh', 'api', *args], capture_output=True, text=True)
    if result.returncode:
        try:
            error = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(result.stderr)
        if absent and str(error.get('status')) == '404' and error.get('message') == 'Not Found':
            return None
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


def readback(directory, repo, tag, release):
    assert {a['name'] for a in release['assets']} == {p.name for p in directory.iterdir()}, 'Remote asset set differs'
    with tempfile.TemporaryDirectory() as temporary:
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--dir', temporary], check=True)
        for file in directory.iterdir():
            assert digest(Path(temporary) / file.name) == digest(file), f'Remote bytes differ: {file.name}'


def find_release(repo, tag):
    # List releases includes drafts for our publishing identity; the tag lookup
    # endpoint only returns published releases. Pin subsequent reads to the ID.
    matches = []
    page = 1
    while True:
        releases = gh_json(f'repos/{repo}/releases?per_page=100&page={page}')
        matches.extend(r for r in releases if r['tag_name'] == tag)
        if len(releases) < 100:
            break
        page += 1
    assert len(matches) <= 1, 'Multiple releases for this tag'
    return gh_json(f'repos/{repo}/releases/{matches[0]["id"]}') if matches else None


def publish(directory, repo, tag, commit):
    verify(directory, tag, commit)
    assert repo == 'hxy91819/amp-acp', 'Publish only to the personal fork'
    assert gh_json(f'repos/{repo}')['full_name'] == repo
    ref = gh_json(f'repos/{repo}/git/ref/tags/{tag}')['object']
    assert ref['type'] == 'tag', 'Remote tag must be annotated'
    assert gh_json(f'repos/{repo}/git/tags/{ref["sha"]}')['object']['sha'] == commit, 'Remote tag moved'
    release = find_release(repo, tag)
    note_text = (directory / 'release-notes.md').read_text()
    if release is None:
        subprocess.run(['gh', 'release', 'create', tag, '--repo', repo, '--verify-tag', '--draft',
                        '--target', commit, '--title', tag, '--notes-file', str(directory / 'release-notes.md')], check=True)
        release = find_release(repo, tag)
        assert release is not None, 'Created release not visible'
    endpoint = f'repos/{repo}/releases/{release["id"]}'
    assert release['tag_name'] == tag and release['target_commitish'] == commit and release['body'] == note_text, 'Release identity/notes differ'
    if release['draft']:
        current = {a['name'] for a in release['assets']}
        expected = {p.name for p in directory.iterdir()}
        assert current <= expected, 'Draft has unexpected assets'
        if current:
            with tempfile.TemporaryDirectory() as temporary:
                subprocess.run(['gh', 'release', 'download', tag, '--repo', repo, '--dir', temporary], check=True)
                for name in current:
                    assert digest(Path(temporary) / name) == digest(directory / name), 'Existing draft asset differs'
        for file in sorted(directory.iterdir()):
            if file.name not in current:
                subprocess.run(['gh', 'release', 'upload', tag, str(file), '--repo', repo], check=True)
        readback(directory, repo, tag, gh_json(endpoint))
        subprocess.run(['gh', 'release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'], check=True)
    final = gh_json(endpoint)
    assert not final['draft'] and not final['prerelease'], 'Release is not public/final'
    readback(directory, repo, tag, final)
    assert gh_json(f'repos/{repo}/git/ref/tags/{tag}')['object'] == ref, 'Tag changed during publication'
    print(final['html_url'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('source', 'pack', 'smoke', 'assemble', 'verify', 'publish'))
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--platform', choices=PLATFORMS)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--directory', type=Path, default=Path('release'))
    parser.add_argument('--repository', default='hxy91819/amp-acp')
    args = parser.parse_args()
    if args.command == 'source':
        source(args.tag, args.commit)
    elif args.command == 'pack':
        pack(args.binary, args.directory, args.tag, args.commit, args.platform)
    elif args.command == 'smoke':
        smoke(args.directory / archive_name(args.platform), args.tag, args.commit, args.platform)
    elif args.command == 'assemble':
        assemble(args.directory, args.tag, args.commit)
    elif args.command == 'verify':
        verify(args.directory, args.tag, args.commit)
    else:
        publish(args.directory, args.repository, args.tag, args.commit)


if __name__ == '__main__':
    main()
