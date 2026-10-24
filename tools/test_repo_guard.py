"""Exercise the guard against actual disposable Git indexes; no real credentials."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).with_name('repo_guard.py')


class RepoGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nss-guard-test-')
        self.root = Path(self.temp.name).resolve()
        # Cleanup is restricted to the newly allocated task fixture.
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith('nss-guard-test-'))
        self.addCleanup(self.temp.cleanup)
        self.env = os.environ.copy()
        for name in tuple(self.env):
            if name.startswith('GIT_'):
                self.env.pop(name)
        self.env['GIT_CONFIG_NOSYSTEM'] = '1'
        self.env['GIT_CONFIG_GLOBAL'] = os.devnull
        self.env['GIT_TERMINAL_PROMPT'] = '0'
        (self.root / 'tools').mkdir()
        shutil.copyfile(GUARD, self.root / 'tools/repo_guard.py')
        self.git('init', '--quiet')

    def git(self, *args):
        return subprocess.run(
            ['git', '-c', 'safe.directory=' + self.root.as_posix(),
             '-c', 'core.autocrlf=false', *args],
            cwd=self.root, env=self.env, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def stage(self, data, path='input.txt'):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.git('add', '--', path)

    def guard(self, *args):
        return subprocess.run(
            [sys.executable, str(self.root / 'tools/repo_guard.py'), *args],
            cwd=self.root, env=self.env, capture_output=True,
        )

    @staticmethod
    def assignment(value):
        # Build synthetic input at runtime, not a stored credential.
        return b'password' + b' = ' + repr(value).encode('ascii') + b'\n'

    def test_passphrase_is_blocked_without_disclosure(self):
        phrase = 'Alpha Bravo Charlie Delta'
        self.stage(self.assignment(phrase))
        result = self.guard('--staged')
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'credential-literal-review:line-1', result.stdout)
        self.assertNotIn(phrase.encode(), result.stdout + result.stderr)

    def test_equals_spacing_does_not_bypass_detection(self):
        self.stage(self.assignment('AlphaBravoCharlieDelta'))
        self.assertEqual(self.guard('--staged').returncode, 1)

    def test_placeholder_is_still_allowed(self):
        self.stage(self.assignment('your example phrase here'))
        self.assertEqual(self.guard('--staged').returncode, 0)

    def test_expression_marker_is_still_allowed(self):
        self.stage(self.assignment('${ENVIRONMENT_VALUE}'))
        self.assertEqual(self.guard('--staged').returncode, 0)

    def test_index_instead_of_unstaged_working_file(self):
        self.stage(b'ordinary source text\n')
        (self.root / 'input.txt').write_bytes(self.assignment('Alpha Bravo Charlie Delta'))
        self.assertEqual(self.guard('--staged').returncode, 0)
        self.git('add', '--', 'input.txt')
        self.assertEqual(self.guard('--staged').returncode, 1)

    def test_committed_tree_instead_of_current_index(self):
        self.stage(b'ordinary source text\n')
        self.git('-c', 'user.name=Guard-Test', '-c', 'user.email=guard@example.invalid',
                 '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture')
        self.stage(self.assignment('Alpha Bravo Charlie Delta'))
        self.assertEqual(self.guard('--tree', 'HEAD').returncode, 0)
        self.assertEqual(self.guard('--staged').returncode, 1)

    def test_artifact_and_json_policy_is_unchanged(self):
        for path, data, expected in [
            ('drawing.dwg', b'ordinary source text', 1),
            ('ordinary.json', b'{}', 1),
            ('skills-lock.json', b'{}', 0),
            ('ordinary.txt', b'ordinary source text', 0),
            ('binary.txt', bytes([65, 0, 66]), 1),
        ]:
            with self.subTest(path=path):
                self.stage(data, path)
                self.assertEqual(self.guard('--staged').returncode, expected)
                self.git('rm', '--cached', '--', path)


if __name__ == '__main__':
    unittest.main()
