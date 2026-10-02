import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'scripts/fork_release_v1.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
TAG = 'fork-v0.10.0-20261002.1'
COMMIT = 'a' * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cwd = Path.cwd()
        os.chdir(self.temp.name)
        Path('docs').mkdir()
        Path('docs/fork-release.md').write_text('Install Amp CLI, then the standalone adapter.\n')
        Path('LICENSE').write_text('Apache-2.0\n')
        Path('CHANGELOG.fork.md').write_text(f'# Fork releases\n\n## {TAG}\n\nRelease fixture.\n')
        Path('binary').write_bytes(b'fixture executable\x00')
        self.directory = Path('release')

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def bundle(self):
        for platform in release.PLATFORMS:
            release.pack(Path('binary'), self.directory, TAG, COMMIT, platform)
        release.assemble(self.directory, TAG, COMMIT)

    def test_complete_offline_release_preserves_binary_and_source_on_all_platforms(self):
        self.bundle()
        manifest = release.verify(self.directory, TAG, COMMIT)
        self.assertEqual(len(manifest['files']), 7)
        for platform in release.PLATFORMS:
            destination = Path('installed') / platform
            binary = release.unpack(self.directory / release.archive_name(platform), destination, platform)
            self.assertEqual(binary.read_bytes(), Path('binary').read_bytes())
            self.assertEqual(json.loads((destination / 'VERSION.json').read_text())['sourceCommit'], COMMIT)

    def test_changed_missing_extra_or_wrong_source_artifacts_cannot_publish(self):
        self.bundle()
        file = self.directory / release.archive_name('linux-x64')
        original = file.read_bytes()
        file.write_bytes(original + b'changed')
        with self.assertRaises(AssertionError):
            release.verify(self.directory, TAG, COMMIT)
        file.write_bytes(original)
        with self.assertRaises(AssertionError):
            release.verify(self.directory, TAG, 'b' * 40)
        extra = self.directory / 'unexpected'
        extra.touch()
        with self.assertRaises(AssertionError):
            release.verify(self.directory, TAG, COMMIT)
        extra.unlink()
        file.unlink()
        with self.assertRaises(AssertionError):
            release.verify(self.directory, TAG, COMMIT)

    def test_incomplete_matrix_and_missing_changelog_stop_assembly(self):
        release.pack(Path('binary'), self.directory, TAG, COMMIT, 'linux-x64')
        with self.assertRaises(FileNotFoundError):
            release.assemble(self.directory, TAG, COMMIT)
        for platform in release.PLATFORMS:
            release.pack(Path('binary'), self.directory, TAG, COMMIT, platform)
        Path('CHANGELOG.fork.md').write_text('No notes for this tag')
        with self.assertRaises(AssertionError):
            release.assemble(self.directory, TAG, COMMIT)

    def test_registry_absence_only_accepts_recognized_404(self):
        for stdout, stderr in [('', 'DNS failure'), ('{"message":"Bad credentials","status":"401"}', 'HTTP 401')]:
            with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, stdout, stderr)):
                with self.assertRaises(RuntimeError):
                    release.gh_json('repos/example/releases/tags/tag', absent=True)
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '{"message":"Not Found","status":"404"}', 'HTTP 404')):
            self.assertIsNone(release.gh_json('repos/example/releases/tags/tag', absent=True))

    def test_existing_public_release_is_verified_without_upload_or_edit(self):
        self.bundle()
        ref = dict(type='tag', sha='b' * 40)
        existing = dict(tag_name=TAG, target_commitish=COMMIT, body=(self.directory / 'release-notes.md').read_text(),
                        id=7, draft=False, prerelease=False, html_url='https://example.test/release')
        with patch.object(release, 'gh_json', side_effect=[dict(full_name='hxy91819/amp-acp'), dict(object=ref),
                dict(object=dict(sha=COMMIT)), [existing], existing, existing, dict(object=ref)]), \
             patch.object(release, 'readback') as readback, patch.object(subprocess, 'run') as mutation:
            release.publish(self.directory, 'hxy91819/amp-acp', TAG, COMMIT)
            mutation.assert_not_called()
            readback.assert_called_once()

    def test_moved_remote_tag_stops_before_creating_release(self):
        self.bundle()
        with patch.object(release, 'gh_json', side_effect=[dict(full_name='hxy91819/amp-acp'),
                dict(object=dict(type='tag', sha='b' * 40)), dict(object=dict(sha='c' * 40))]), patch.object(subprocess, 'run') as mutation:
            with self.assertRaises(AssertionError):
                release.publish(self.directory, 'hxy91819/amp-acp', TAG, COMMIT)
            mutation.assert_not_called()

    def test_draft_resumes_missing_assets_and_verifies_downloads_before_publication(self):
        self.draft_publication(already_exists=True)

    def test_first_publication_creates_and_reads_draft_by_id(self):
        self.draft_publication(already_exists=False)

    def draft_publication(self, already_exists):
        self.bundle()
        ref = dict(type='tag', sha='b' * 40)
        first = release.archive_name('linux-x64')
        remote = {first: (self.directory / first).read_bytes()}
        state = dict(tag_name=TAG, target_commitish=COMMIT, body=(self.directory / 'release-notes.md').read_text(),
                     id=7, exists=already_exists, draft=True, prerelease=False, html_url='https://example.test/release')
        if not already_exists:
            remote.clear()

        def api(endpoint, **kwargs):
            if endpoint.endswith('/git/ref/tags/' + TAG):
                return dict(object=ref)
            if '/git/tags/' in endpoint:
                return dict(object=dict(sha=COMMIT))
            if '/releases/tags/' in endpoint and state['draft']:
                if kwargs.get('absent'):
                    return None
                raise RuntimeError('HTTP 404: tag endpoint only returns published releases')
            if '/releases?' in endpoint:
                return [dict(state)] if state['exists'] else []
            if endpoint.endswith('/releases/7') or '/releases/tags/' in endpoint:
                return dict(state, assets=[dict(name=name) for name in remote])
            return dict(full_name='hxy91819/amp-acp')

        def command(args, **kwargs):
            operation = args[2]
            if operation == 'create':
                self.assertFalse(state['exists'], 'Must not recreate a matching draft')
                state['exists'] = True
            elif operation == 'upload':
                file = Path(args[4])
                self.assertNotIn(file.name, remote)
                remote[file.name] = file.read_bytes()
            elif operation == 'download':
                destination = Path(args[args.index('--dir') + 1])
                for name, data in remote.items():
                    (destination / name).write_bytes(data)
            elif operation == 'edit':
                self.assertEqual(set(remote), {p.name for p in self.directory.iterdir()})
                state['draft'] = False
            else:
                self.fail('Unexpected remote operation')
            return subprocess.CompletedProcess(args, 0)

        with patch.object(release, 'gh_json', side_effect=api), patch.object(subprocess, 'run', side_effect=command):
            release.publish(self.directory, 'hxy91819/amp-acp', TAG, COMMIT)
        self.assertFalse(state['draft'])
        self.assertEqual(remote[first], (self.directory / first).read_bytes())

    def test_downloaded_remote_bytes_must_match(self):
        self.bundle()
        assets = [dict(name=p.name) for p in self.directory.iterdir()]

        def download(args, **kwargs):
            destination = Path(args[args.index('--dir') + 1])
            for file in self.directory.iterdir():
                (destination / file.name).write_bytes(file.read_bytes() + b'changed')

        with patch.object(subprocess, 'run', side_effect=download):
            with self.assertRaises(AssertionError):
                release.readback(self.directory, 'hxy91819/amp-acp', TAG, dict(assets=assets))


if __name__ == '__main__':
    unittest.main()
