"""The v09 finalizer must not modify the builder script it executes.

The test copies only ``finalize_package_v09.py`` into a temporary directory and
places synthetic stand-ins for ``build_package_v09.py`` and ``tkk_integrity.py``
next to it. No private drawing, ezdxf, Autodesk product or real build is used.
The stub builder stops the run right after the finalizer reaches its first
drawing read, so the run ends abnormally on purpose; the builder file must be
untouched in that case too.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CCTV = Path(__file__).resolve().parents[1] / "cctv"
FINALIZER = CCTV / "finalize_package_v09.py"
SENTINEL = "FINALIZE_REACHED_DRAWING_READ"
# Text the finalizer used to patch inside the builder source.
LEGACY_PATCH_TARGET = "s.arrow((375,137),(615,137),5,.4)"
OLD_MTIME_NS = 946_684_800 * 10**9

STUB_TKK_INTEGRITY = '''def tkk_block_fingerprints(*args, **kwargs):
    raise AssertionError("synthetic stub must not be called")


def verify_tkk_blocks(*args, **kwargs):
    raise AssertionError("synthetic stub must not be called")
'''

STUB_BUILDER = '''from pathlib import Path


class _Ezdxf:
    @staticmethod
    def readfile(path):
        raise RuntimeError("%(sentinel)s")


Path(__file__).with_name("builder_ran.marker").write_text("ran", encoding="utf-8")
ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
SOURCE = ROOT / "synthetic_source.dxf"
ezdxf = _Ezdxf()
%(payload)s
'''


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class FinalizerDoesNotRewriteBuilderTests(unittest.TestCase):
    def _run_finalizer(self, payload, newline):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            shutil.copy2(FINALIZER, work / FINALIZER.name)
            (work / "tkk_integrity.py").write_text(STUB_TKK_INTEGRITY, encoding="utf-8")
            builder = work / "build_package_v09.py"
            text = STUB_BUILDER % {"sentinel": SENTINEL, "payload": payload}
            with open(builder, "w", encoding="utf-8", newline=newline) as handle:
                handle.write(text)
            os.utime(builder, ns=(OLD_MTIME_NS, OLD_MTIME_NS))
            before = (_sha256(builder), builder.stat().st_mtime_ns)

            env = os.environ.copy()
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            result = subprocess.run(
                [sys.executable, str(work / FINALIZER.name)],
                cwd=work,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            after = (_sha256(builder), builder.stat().st_mtime_ns)
            marker = (work / "builder_ran.marker").exists()
        return before, after, marker, result

    def _check(self, payload, newline):
        before, after, marker, result = self._run_finalizer(payload, newline)
        # The run must end abnormally, exactly at the stub drawing read; this
        # also proves the builder was still executed by the finalizer.
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(SENTINEL, result.stderr)
        self.assertTrue(marker, "finalizer no longer executes the builder")
        self.assertEqual(before[0], after[0], "builder content was changed")
        self.assertEqual(before[1], after[1], "builder file was rewritten (mtime changed)")

    def test_builder_with_legacy_patch_target_is_not_modified(self):
        self._check("# legacy: %s\n" % LEGACY_PATCH_TARGET, newline="\n")

    def test_builder_without_patch_target_is_not_rewritten(self):
        self._check("# nothing for the finalizer to replace\n", newline="\n")

    def test_builder_with_crlf_line_endings_is_byte_identical(self):
        self._check("# crlf builder\n", newline="\r\n")


if __name__ == "__main__":
    unittest.main()
