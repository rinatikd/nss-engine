"""Integration checks for the committed-tree publication guard."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SOURCE_GUARD = Path(__file__).resolve().parents[1] / "repo_guard.py"


class RepoGuardTests(unittest.TestCase):
    def run_guard(self, source):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / "tools"
            tools.mkdir()
            guard = tools / "repo_guard.py"
            shutil.copyfile(SOURCE_GUARD, guard)
            (root / "sample.py").write_text(source, encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Guard Test"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "guard-test@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(root), "add", "tools/repo_guard.py", "sample.py"], check=True)
            subprocess.run(
                [
                    "git", "-C", str(root),
                    "-c", "commit.gpgsign=false",
                    "-c", "core.hooksPath=",
                    "commit", "-qm", "fixture",
                ],
                check=True,
            )
            return subprocess.run(
                [sys.executable, str(guard), "--tree", "HEAD"],
                cwd=root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )

    def test_provider_tokens_are_blocked_even_with_placeholder_substrings(self):
        for marker in ("test", "your"):
            with self.subTest(marker=marker):
                token = "ghp_" + ("A" * 27) + marker + ("B" * 8)
                result = self.run_guard("TOKEN = " + repr(token) + "\n")
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("BLOCK sample.py: github-token", result.stdout)
                self.assertNotIn(token, result.stdout)

    def test_clean_documentation_and_source_pass(self):
        result = self.run_guard(
            '"""Use os.environ.get("API_KEY") for credentials."""\n'
            "def describe():\n    return 'portable source'\n"
        )
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("PASS:", result.stdout)


if __name__ == "__main__":
    unittest.main()
