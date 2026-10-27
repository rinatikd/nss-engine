import tempfile
import unittest
from pathlib import Path

import ezdxf
from ezdxf.lldxf.tagwriter import TagCollector

from tools.cctv.tkk_integrity import tkk_block_fingerprints, verify_tkk_blocks


TKK = "ТКК"


class TkkBlockIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.doc = ezdxf.new("R2010")
        self.doc.layers.new(TKK)
        leaf = self.doc.blocks.new("leaf", base_point=(1, 2, 3))
        self.line = leaf.add_line((0, 0), (1, 0))
        root = self.doc.blocks.new("well", base_point=(4, 5, 0))
        root.add_blockref("leaf", (3, 0))
        self.circle = root.add_circle((0, 0), 2)
        self.doc.modelspace().add_blockref("well", (10, 20), dxfattribs={"layer": TKK})
        unrelated = self.doc.blocks.new("unrelated")
        self.unrelated_line = unrelated.add_line((0, 0), (1, 1))
        self.expected = tkk_block_fingerprints(self.doc, TKK)

    def test_direct_primitive_change_detected(self):
        insert = next(iter(self.doc.modelspace()))
        before = TagCollector.dxftags(insert, self.doc.dxfversion)
        self.circle.dxf.radius = 3
        self.assertEqual(TagCollector.dxftags(insert, self.doc.dxfversion), before)
        with self.assertRaisesRegex(RuntimeError, "well"):
            verify_tkk_blocks(self.doc, TKK, self.expected)

    def test_nested_primitive_change_detected(self):
        self.line.dxf.end = (5, 0, 0)
        with self.assertRaisesRegex(RuntimeError, "leaf"):
            verify_tkk_blocks(self.doc, TKK, self.expected)

    def test_block_base_point_change_detected(self):
        self.doc.blocks["well"].block.dxf.base_point = (5, 5, 0)
        with self.assertRaisesRegex(RuntimeError, "well"):
            verify_tkk_blocks(self.doc, TKK, self.expected)

    def test_block_header_change_detected(self):
        self.doc.blocks["well"].block.dxf.flags = 4
        with self.assertRaisesRegex(RuntimeError, "well"):
            verify_tkk_blocks(self.doc, TKK, self.expected)

    def test_unchanged_save_read_passes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "blocks.dxf"
            self.doc.saveas(path)
            verify_tkk_blocks(ezdxf.readfile(path), TKK, self.expected)

    def test_nested_block_change_after_dxf_roundtrip_is_detected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "blocks.dxf"
            self.doc.saveas(path)
            loaded = ezdxf.readfile(path)
            loaded.blocks["leaf"].query("LINE").first.dxf.end = (7, 0, 0)
            with self.assertRaisesRegex(RuntimeError, "leaf"):
                verify_tkk_blocks(loaded, TKK, self.expected)

    def test_unrelated_block_change_ignored(self):
        self.unrelated_line.dxf.end = (99, 99, 0)
        self.doc.blocks.new("new_unrelated").add_circle((0, 0), 42)
        verify_tkk_blocks(self.doc, TKK, self.expected)
        self.assertEqual(set(self.expected), {"well", "leaf"})

    def test_cycle_terminates_and_nested_change_still_detected(self):
        self.doc.blocks["leaf"].add_blockref("WELL", (0, 0))
        expected = tkk_block_fingerprints(self.doc, TKK)
        self.assertEqual(set(expected), {"well", "leaf"})
        self.line.dxf.end = (9, 0, 0)
        with self.assertRaisesRegex(RuntimeError, "leaf"):
            verify_tkk_blocks(self.doc, TKK, expected)

    def test_missing_nested_definition_fails_explicitly(self):
        self.doc.blocks["leaf"].add_blockref("missing", (0, 0))
        with self.assertRaisesRegex(ValueError, "missing"):
            tkk_block_fingerprints(self.doc, TKK)


if __name__ == "__main__":
    unittest.main()
