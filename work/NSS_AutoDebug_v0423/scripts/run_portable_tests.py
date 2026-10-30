"""Run tracked synthetic contracts without private fixtures or an Autodesk host."""
import argparse
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
# Explicit selection: adding a new test module requires reviewing its inputs.
MODULES = (
    'test_analyzer', 'test_autodebug_v0421', 'test_build_diagnostics_v040', 'test_diagnostics_v034',
    'test_host_diagnostics_v0422', 'test_loader_isolation_v0423',
    'test_observability_v036', 'test_preflight_v039', 'test_preview_v031',
    'test_release_v042', 'test_runtime_v035', 'test_v022', 'test_v023',
    'test_v024', 'test_v025', 'test_v026', 'test_v027', 'test_v028', 'test_v029',
    'test_v030', 'test_v032', 'test_v033', 'test_v038', 'test_v041', 'test_v042',
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract-fixture', type=Path,
                        help='snapshot emitted by the C# contract executable')
    args = parser.parse_args()
    if args.contract_fixture:
        if not args.contract_fixture.is_file():
            parser.error('C# contract fixture does not exist')
        os.environ['NSS_CONTRACT_FIXTURE'] = str(args.contract_fixture.resolve())
    sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
    print('Excluded fixture suite: test_v037 (examples snapshot and plan). '
          'Collector tests use synthetic reports; AutoCAD runtime NOT_TESTED.', flush=True)
    suite = unittest.defaultTestLoader.loadTestsFromNames(MODULES)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
