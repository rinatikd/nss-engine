"""Portable checks for opt-in external CAD resource packaging."""
import tempfile
import unittest
from pathlib import Path

import package_candidate as package


class BlockPackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in package.BLOCK_ALLOWLIST:
            content = b'AC1032\x00test-header' if name.endswith('.dwg') else b'0\r\nSECTION\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n'
            (self.root / name).write_bytes(content)

    def test_omitting_resources_preserves_source_only_mode(self):
        self.assertEqual({}, package.block_files(None))

    def test_complete_set_is_mapped_to_root_and_each_runtime(self):
        entries = package.block_files(self.root)
        self.assertEqual(21, len(entries))
        for name in package.BLOCK_ALLOWLIST:
            self.assertEqual(self.root / name, entries['blocks/' + name])
            for host in package.HOSTS:
                self.assertEqual(self.root / name, entries[f'Runtime/{host}/blocks/{name}'])
        self.assertTrue(all(path.stat().st_size for path in entries.values()))

    def test_missing_resource_is_rejected(self):
        (self.root / 'AGPT_UGO.dxf').unlink()
        with self.assertRaisesRegex(ValueError, 'exactly'):
            package.block_files(self.root)

    def test_unreviewed_file_is_rejected(self):
        (self.root / 'extra.dwg').write_bytes(b'AC1032')
        with self.assertRaisesRegex(ValueError, 'exactly'):
            package.block_files(self.root)

    def test_empty_or_invalid_headers_are_rejected(self):
        for name, invalid in [('AGPT_Frame_A3.dwg', b''),
                              ('AGPT_Frame_A3.dwg', b'fake drawing'),
                              ('AGPT_UGO.dxf', b'EOF'),
                              ('AGPT_UGO.dxf', b'0\nSECTION\n')]:
            with self.subTest(name=name, invalid=invalid):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(invalid)
                with self.assertRaisesRegex(ValueError, 'header/EOF'):
                    package.block_files(self.root)
                path.write_bytes(original)

    def test_symlink_resource_and_root_are_rejected(self):
        path = self.root / 'AGPT_UGO.dxf'
        path.unlink()
        path.symlink_to(self.root / 'AGPT_Frame_A3.dxf')
        with self.assertRaisesRegex(ValueError, 'symlink CAD'):
            package.block_files(self.root)
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink blocks root'):
            package.block_files(alias)


if __name__ == '__main__':
    unittest.main()
