import copy
import json
from pathlib import Path
import tempfile
import unittest

from diagnostics import write_reports
from tkk_editor_core import analyze


def sample():
    return dict(protected={'A': 1}, wells=[dict(id='A', xyz=[0, 0, 0]), dict(id='B', xyz=[20, 10, 0])],
                routes=[dict(id='10', points=[[0, 0, 0], [20, 0, 0]])])


class DiagnosticsTests(unittest.TestCase):
    def test_locations_candidates_and_geometry_are_read_only(self):
        data = sample(); before = copy.deepcopy(data); result = analyze(data)
        self.assertEqual(data, before)
        self.assertEqual(result['diagnostics']['by_code'], {'UNRESOLVED_CONNECTION': 1, 'WELL_OFF_ROUTE': 1})
        off = next(i for i in result['warnings'] if i['code'] == 'WELL_OFF_ROUTE')
        self.assertEqual(off['bounds'], [20, 10, 20, 10])
        nearest = off['endpoints'][0]['nearby_routes'][0]
        self.assertEqual((nearest['id'], nearest['distance_m'], nearest['xy']), ('10', 10, [20, 0]))
        loose = next(i for i in result['warnings'] if i['code'] == 'UNRESOLVED_CONNECTION')
        self.assertEqual(loose['length_m'], 20)
        self.assertEqual(loose['source_ids'], ['10'])
        self.assertEqual(loose['endpoints'][-1]['reason'], 'OPEN_ENDPOINT')
        self.assertFalse(result['diagnostics']['connectivity_inferred'])
        self.assertEqual(result['spans'], [])

    def test_issue_id_and_list_stable_when_input_order_changes(self):
        data = sample(); data['routes'].append(dict(id='11', points=[[30, 5, 0], [40, 5, 0]]))
        expected = analyze(data)['warnings']
        data['wells'].reverse(); data['routes'].reverse()
        self.assertEqual(analyze(data)['warnings'], expected)
        self.assertEqual(len({i['issue_id'] for i in expected}), len(expected))

    def test_touching_another_route_does_not_connect_it(self):
        data = sample(); data['routes'].append(dict(id='11', points=[[20, -5, 0], [20, 5, 0]]))
        result = analyze(data)
        loose = next(i for i in result['warnings'] if i.get('routes') == ['10'])
        endpoint = next(e for e in loose['endpoints'] if e['kind'] == 'unresolved')
        self.assertEqual(endpoint['reason'], 'TOUCHES_OTHER_ROUTE')
        self.assertEqual(endpoint['nearby_routes'][0]['distance_m'], 0)
        self.assertEqual(result['spans'], [])

    def test_short_tail_is_reported_without_moving_end_or_well(self):
        data = dict(protected={'A': 1}, wells=[dict(id='A', xyz=[0, 0, 0]), dict(id='B', xyz=[19.5, 0, 0])],
                    routes=[dict(id='10', points=[[0, 0, 0], [20, 0, 0]])])
        before = copy.deepcopy(data); result = analyze(data)
        loose = next(i for i in result['warnings'] if i['code'] == 'UNRESOLVED_CONNECTION')
        self.assertEqual(loose['length_m'], .5)
        self.assertEqual(loose['endpoints'][-1]['reason'], 'NEAR_WELL_TAIL')
        self.assertEqual(result['spans'][0]['length_m'], 19.5)
        self.assertEqual(data, before)

    def test_disconnected_unanchored_loops_have_individual_locations(self):
        data = sample(); data['routes'] = [dict(id=str(k), points=[[x, 0, 0], [x+5, 5, 0], [x+10, 0, 0], [x, 0, 0]]) for k, x in [(10, 50), (11, 80)]]
        loops = [i for i in analyze(data)['warnings'] if i['code'] == 'UNANCHORED_LOOP']
        self.assertEqual(len(loops), 2)
        self.assertEqual({tuple(i['bounds']) for i in loops}, {(50, 0, 60, 5), (80, 0, 90, 5)})

    def test_missing_protected_well_has_no_fabricated_location(self):
        data = sample(); data['protected']['DELETED'] = 2
        issue = next(i for i in analyze(data)['warnings'] if i['code'] == 'PROTECTED_WELL_DELETED')
        self.assertEqual(issue['source_ids'], [])
        self.assertIsNone(issue['bounds'])
        self.assertEqual(issue['number'], 2)

    def test_worker_reports_keep_fingerprint_and_numbered_navigation_order(self):
        data = sample(); data.update(job_id='job-1', fingerprint='abc'); result = analyze(data)
        with tempfile.TemporaryDirectory() as directory:
            write_reports(data, result, directory)
            report = json.loads((Path(directory)/'issues.json').read_text('utf8'))
            text = (Path(directory)/'ISSUES_RU.md').read_text('utf8')
        self.assertEqual(report['fingerprint'], 'abc')
        self.assertEqual(report['job_id'], 'job-1')
        self.assertEqual(report['issues'], result['warnings'])
        for index, issue in enumerate(result['warnings'], 1):
            self.assertIn(f"## {index}. {issue['title']} — {issue['issue_id']}", text)

    def test_native_fixture_all_29_issues_are_located_without_changing_spans(self):
        root = Path(__file__).resolve().parents[1]
        data = json.loads((root/'evidence/native_fixture.json').read_text('utf8'))
        result = analyze(data)
        self.assertEqual(result['diagnostics']['by_code'], {'UNRESOLVED_CONNECTION': 25, 'WELL_OFF_ROUTE': 4})
        self.assertEqual(len(result['spans']), 109)
        self.assertTrue(all(i['bounds'] is not None and i['source_ids'] for i in result['warnings']))
        self.assertEqual(len({i['issue_id'] for i in result['warnings']}), 29)
