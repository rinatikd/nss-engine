import copy
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
import ezdxf
from nss_engine.contract_v042 import validate_entity, validate_snapshot, length_units
from nss_engine.snapshot_v042 import analyze
from nss_engine.dxf_audit_v042 import audit, convert, read_units
from nss_engine.runtime_validation_v041 import validate as validate_old


def entity(**kw):
    return dict(dict(handle='A', layer='NSS', type='LINE', vertices=[[0, 0, 0], [0, 0, 5]],
                     bulges=[], closed=False, block_name='', attributes={}, normal=[0, 0, 1], is_xref=False), **kw)


def snapshot():
    return dict(schema_version='0.42', kind='snapshot3d', drawing=dict(id='fingerprint', name='site.dwg', insunits_code=4, coordinate_system='unverified'),
                entities=[entity()], warnings=[], coverage=dict(visited=1, exported=1, skipped=0, truncated=False, complete=True))


class ContractTests(unittest.TestCase):
    def test_z_preserved_vertical_line_length(self):
        self.assertEqual(length_units(entity()), 5)
        self.assertEqual(analyze(snapshot())['total_length_meters'], .005)

    def test_bulge_exact_semicircle_and_closing_edge(self):
        e = entity(type='LWPOLYLINE', vertices=[[0, 0, 2], [2, 0, 2]], bulges=[1, 0], closed=True)
        self.assertAlmostEqual(length_units(e), math.pi + 2)

    def test_tilted_plane_keeps_z(self):
        e = entity(type='LWPOLYLINE', vertices=[[0, 0, 0], [0, 0, 2]], bulges=[-1, 0], normal=[0, 1, 0])
        self.assertAlmostEqual(length_units(e), math.pi)

    def test_invalid_coordinates_and_bulges(self):
        for bad in (float('nan'), float('inf'), True, '2'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_entity(entity(vertices=[[0, 0, 0], [bad, 0, 0]]))
        with self.assertRaises(ValueError):
            validate_entity(entity(type='LWPOLYLINE', bulges=[float('nan'), 0]))

    def test_unknown_units_are_never_assumed_meters(self):
        d = snapshot(); d['drawing']['insunits_code'] = 0
        self.assertIsNone(analyze(d)['total_length_meters'])
        self.assertFalse(validate_snapshot(d)['units_confirmed'])

    def test_duplicate_handle_and_coverage_lie_rejected(self):
        d = snapshot(); d['entities'].append(entity(handle='a'))
        with self.assertRaises(ValueError): validate_snapshot(d)
        d = snapshot(); d['coverage']['skipped'] = 1
        with self.assertRaises(ValueError): validate_snapshot(d)

    def test_partial_inventory_valid_but_not_complete(self):
        d = snapshot(); d['coverage'].update(visited=2, skipped=1, complete=False)
        self.assertFalse(analyze(d)['inventory_complete'])

    def test_flags_counts_and_warnings_strict(self):
        for path, value in (('warnings', ['oops']), ('entities', {})):
            d = snapshot(); d[path] = value
            with self.assertRaises(ValueError): validate_snapshot(d)
        with self.assertRaises(ValueError): validate_entity(entity(closed=0))
        with self.assertRaises(ValueError): validate_entity(entity(normal=[0, 0, 0]))

    def test_legacy_cannot_accept_new_schema(self):
        from nss_engine.native_v033 import normalize
        with self.assertRaises(ValueError): normalize(snapshot(), {})

    def test_invalid_bulge_length_is_reported(self):
        d = snapshot(); d['entities'] = [entity(type='LWPOLYLINE', vertices=[[0, 0, 0], [0, 0, 0]], bulges=[1, 0])]
        self.assertEqual(len(analyze(d)['length_failures']), 1)

    def test_insert_attributes_and_ocs(self):
        doc = ezdxf.new(); b = doc.modelspace().add_blockref('B', (1, 2, 3), dxfattribs={'extrusion': (0, 1, 0)})
        b.add_attrib('CODE', 'ККС')
        e = convert(b)
        self.assertEqual(e['vertices'][0], list(b.ocs().to_wcs(b.dxf.insert)))
        self.assertEqual(e['attributes']['CODE'], 'ККС')
        self.assertIsNone(length_units(e))

    def test_duplicate_attributes_rejected(self):
        b = ezdxf.new().modelspace().add_blockref('B', (0, 0))
        b.add_attrib('CODE', '1'); b.add_attrib('code', '2')
        with self.assertRaises(ValueError): convert(b)

    def test_dxf_errors_isolated_and_original_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder); d = ezdxf.new('R2018'); d.units = 6
            d.modelspace().add_line((0, 0, 2), (0, 0, 5)); d.modelspace().add_circle((0, 0), 2)
            source = p/'source.dxf'; d.saveas(source); before = source.read_bytes()
            result = audit(source, p/'out')
            self.assertEqual((result['exported'], result['skipped']), (1, 1))
            self.assertEqual(result['length_meters'], 3)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(read_units(source), 6)

    def test_legacy_invalid_units_rejected(self):
        d = dict(schema_version='0.41', drawing_name='site.dwg', insunits='bananas', counts=dict(lines=1, polylines=0, blocks=0, other=0, failed=0))
        self.assertFalse(validate_old(d)['valid'])

    def test_nonplanar_polyline_rejected(self):
        with self.assertRaises(ValueError):
            validate_entity(entity(type='LWPOLYLINE', vertices=[[0, 0, 0], [1, 0, 1]], bulges=[1, 0]))

    def test_cs_fixture_roundtrip(self):
        path = Path(os.environ.get('NSS_CONTRACT_FIXTURE', Path(__file__).resolve().parents[1] / 'contract_fixture_v042.json'))
        if not path.exists():
            self.skipTest('C# fixture not generated; run contract_tests first')
        data = json.loads(path.read_text(encoding='utf8'))
        self.assertTrue(validate_snapshot(data)['valid'])
        self.assertEqual(length_units(data['entities'][0]), 5)

    def test_coordinate_bounds_and_huge_json_integer(self):
        for x in (1e13, 10**1000):
            with self.subTest(value=str(x)[:20]), self.assertRaises(ValueError):
                validate_entity(entity(vertices=[[0, 0, 0], [x, 0, 0]]))

    def test_real_ezdxf_polyline_bulges_are_normalized_to_json_numbers(self):
        doc = ezdxf.new()
        poly = doc.modelspace().add_lwpolyline([(0, 0, 1), (2, 0, 0)], format='xyb', close=True)
        record = convert(poly)
        self.assertIs(type(record['bulges'][0]), float)
        self.assertAlmostEqual(length_units(record), math.pi + 2)
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder); doc.saveas(p/'poly.dxf')
            report = audit(p/'poly.dxf', p/'out')
            self.assertEqual((report['exported'], report['skipped']), (1, 0))
            self.assertAlmostEqual(report['length_units'], math.pi + 2)
