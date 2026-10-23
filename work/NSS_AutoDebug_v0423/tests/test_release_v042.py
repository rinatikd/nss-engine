import copy
import heapq
import json
import math
from pathlib import Path
import random
import unittest
from unittest.mock import patch
from nss_engine.analyzer import Segment
from nss_engine.analyzer_v022 import analyze
from nss_engine.analyzer_v024 import analyze as topology
from nss_engine.intelligence_v042 import recognize
from nss_engine.pipeline_v042 import analyze_entities
from nss_engine.spatial import SegmentGrid
from nss_engine.routing_v027 import Rect,route
from nss_engine.optimization_v028 import Weights,optimize,exposure_length
from nss_engine.preview_v031 import preview_from_report
from nss_engine.diagnostics_v034 import validate_snapshot


def record(**changes):
    r=dict(handle='A',layer='НСС проектир',type='LINE',vertices=[[0,0,0],[2,0,0]],bulges=[],closed=False,block_name='',attributes={},normal=[0,0,1],is_xref=False)
    r.update(changes);return r


class RecognitionAndBridgeTests(unittest.TestCase):
    def test_background_worker_end_to_end_and_failed_identity(self):
        import subprocess,sys,tempfile
        from test_v042 import snapshot
        root=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);source=folder/'source.json';source.write_text(json.dumps(snapshot()),encoding='utf8')
            before=source.read_bytes()
            for suffix,extra,expected in (('ok',[],'COMPLETED_REVIEW_REQUIRED'),('bad',['--drawing-id','other'],'FAILED')):
                out=folder/suffix
                result=subprocess.run([sys.executable,str(root/'scripts/analyze_job_v042.py'),'--input',str(source),'--output-dir',str(out),*extra],capture_output=True)
                self.assertEqual(result.returncode,0 if suffix=='ok' else 2,result.stderr)
                self.assertEqual(json.loads((out/'status.json').read_text())['phase'],expected)
                self.assertEqual(source.read_bytes(),before)

    def test_layer_geometry_and_confidence_evidence(self):
        r=recognize(record());self.assertEqual(r['category'],'telecom');self.assertIn('exact_layer:НСС проектир',r['evidence'])
        self.assertTrue(r['review_required'])
        self.assertEqual(recognize(record(layer='0'))['category'],'unknown')
        self.assertEqual(recognize(record(layer='СС'))['category'],'telecom')

    def test_well_attributes_and_contradiction(self):
        b=record(type='INSERT',vertices=[[0,0,0]],block_name='NSS_KKS_1',layer='0')
        self.assertEqual(recognize(b)['kind'],'well_symbol')
        b['attributes']={'SYSTEM':'GAS'}
        self.assertTrue(recognize(b)['conflict']);self.assertEqual(recognize(b)['category'],'unknown')

    def test_no_substring_or_legend_guessing(self):
        self.assertEqual(recognize(record(layer='МАГИСТРАЛЬ'))['category'],'unknown')
        self.assertEqual(recognize(record(layer='Условные обозначения'))['kind'],'annotation')

    def test_override_and_conflicting_mapping(self):
        self.assertEqual(recognize(record(),{'НСС проектир':'power'})['category'],'power')
        with self.assertRaises(ValueError):recognize(record(),{'NSS':'gas','nss':'water'})

    def test_bridge_never_flattens_z_or_chords_arcs(self):
        r=analyze_entities([record(vertices=[[0,0,1],[2,0,1]]),record(handle='B',type='LWPOLYLINE',bulges=[1,0])])
        self.assertEqual(r['screening']['summary']['segments'],0)
        self.assertEqual(r['omitted_from_xy_screening'],{'nonzero_z_not_projected':1,'curved_geometry_not_chorded':1})

    def test_bridge_classified_crossing_and_no_physical_connection(self):
        r=analyze_entities([record(),record(handle='B',layer='Водопровод',vertices=[[1,-1,0],[1,1,0]])])
        self.assertIn('UTILITY_CROSSING',[f['code'] for f in r['screening']['findings']])
        self.assertFalse(r['physical_connectivity_confirmed'])

    def test_bridge_budget_is_explicit(self):
        r=analyze_entities([record(),record(handle='B')],max_segments=1)
        self.assertEqual(r['omitted_from_xy_screening']['segment_budget'],1)


class GeometryIndexTests(unittest.TestCase):
    def test_indexed_analyzer_no_hidden_quadratic_legacy_pass(self):
        segments=[Segment(str(i),(i*10.,0.),(i*10.+1,0.)) for i in range(2000)]
        with patch('nss_engine.analyzer.dist',wraps=math.dist) as distance:
            report=analyze(segments)
        self.assertEqual(len(report['findings']),4000)
        self.assertLess(distance.call_count,10000)

    def test_huge_diagonal_and_query_use_bounded_index(self):
        s=Segment('A',(-1e9,-1e9),(1e9,1e9))
        grid=SegmentGrid([s],1)
        self.assertEqual(len(grid.cells),0)
        self.assertEqual(list(grid.candidates((0,0),(0,0))),[s])
        self.assertEqual(list(grid.candidates((-1e9,-1e9),(1e9,1e9))),[s])

    def test_index_membership_limit_and_brute_bbox_reference(self):
        rng=random.Random(42);ss=[Segment(str(i),(rng.randrange(-10,10),rng.randrange(-10,10)),(rng.randrange(-10,10),rng.randrange(-10,10))) for i in range(200)]
        grid=SegmentGrid(ss,1,max_cells=20,max_cells_per_segment=5)
        self.assertLessEqual(grid.memberships,20)
        for _ in range(100):
            a=(rng.randrange(-10,10),rng.randrange(-10,10));b=(rng.randrange(-10,10),rng.randrange(-10,10))
            expected={s.handle for s in ss if min(s.a[0],s.b[0])<=max(a[0],b[0]) and max(s.a[0],s.b[0])>=min(a[0],b[0]) and min(s.a[1],s.b[1])<=max(a[1],b[1]) and max(s.a[1],s.b[1])>=min(a[1],b[1])}
            self.assertEqual({s.handle for s in grid.candidates(a,b)},expected)

    def test_crossing_interiors_do_not_merge_components(self):
        r=topology([Segment('A',(-1,0),(1,0)),Segment('B',(0,-1),(0,1))])
        self.assertEqual(r['summary']['components'],2)
        self.assertIn('AMBIGUOUS_NETWORK_CROSSING',[f['code'] for f in r['findings']])

    def test_duplicate_reverse_and_t_junction(self):
        r=topology([Segment('A',(0,0),(2,0)),Segment('B',(2,0),(0,0)),Segment('C',(1,0),(1,1))])
        self.assertEqual(r['summary']['components'],1)
        self.assertIn('DUPLICATE_SEGMENT',[f['code'] for f in r['findings']])


class RouteVerificationTests(unittest.TestCase):
    def test_boolean_parameters_and_invalid_obstacles_rejected(self):
        with self.assertRaises(ValueError):route((False,0),(2,0))
        with self.assertRaises(ValueError):route((0,0),(2,0),max_cells=True)
        with self.assertRaises(ValueError):route((0,0),(2,0),obstacles=[{}])
        with self.assertRaises(ValueError):Weights(True,0,0)

    def test_exact_thin_soft_zone_and_union_not_double_counted(self):
        self.assertAlmostEqual(exposure_length((0,0),(1,0),[Rect(.1,-1,.2,1)]),.1)
        self.assertAlmostEqual(exposure_length((0,0),(1,0),[Rect(.1,-1,.4,1),Rect(.2,-1,.6,1)]),.5)
        r=optimize((0,0),(2,0),soft_zones=[Rect(.1,-.2,.2,.2)],weights=Weights(1,0,100),margin=1)
        self.assertEqual(r.soft_zone_length,0)

    def test_astar_matches_independent_breadth_first_grid_reference(self):
        from collections import deque
        rng=random.Random(421)
        for _ in range(30):
            blocked={(x,y) for x in range(5) for y in range(5) if rng.random()<.2 and (x,y) not in ((0,0),(4,4))}
            obstacles=[Rect(x,y,x,y) for x,y in blocked]
            q=deque([((0,0),0)]);seen={(0,0)};expected=None
            while q:
                p,d=q.popleft()
                if p==(4,4):expected=d;break
                for dx,dy in ((1,0),(0,1),(-1,0),(0,-1)):
                    n=(p[0]+dx,p[1]+dy)
                    if 0<=n[0]<=4 and 0<=n[1]<=4 and n not in blocked and n not in seen:seen.add(n);q.append((n,d+1))
            result=route((0,0),(4,4),obstacles,margin=0)
            if expected is None:self.assertEqual(result.status,'NO_ROUTE')
            else:self.assertEqual(result.length,expected)

    def test_weighted_astar_matches_independent_dijkstra(self):
        # Reference has no A* heuristic. Exposure is integrated in tenth-unit bins;
        # zone bounds are multiples of .1, making the bin integration exact here.
        weights=Weights(1,2,10);zones=[Rect(.1,0,.2,1),Rect(1,1,2,1.5)]
        heap=[(0.,(0,0),-1)];best={((0,0),-1):0.};reference=None
        dirs=((1,0),(0,1),(-1,0),(0,-1))
        while heap:
            cost,p,d=heapq.heappop(heap)
            if cost!=best[(p,d)]:continue
            if p==(3,3):reference=cost;break
            for nd,(dx,dy) in enumerate(dirs):
                n=(p[0]+dx,p[1]+dy)
                if not (0<=n[0]<=3 and 0<=n[1]<=3):continue
                exposed=sum(any(r.xmin<=p[0]+dx*(k+.5)/10<=r.xmax and r.ymin<=p[1]+dy*(k+.5)/10<=r.ymax for r in zones) for k in range(10))/10
                value=cost+1+2*int(d!=-1 and nd!=d)+10*exposed
                if value<best.get((n,nd),math.inf):best[(n,nd)]=value;heapq.heappush(heap,(value,n,nd))
        result=optimize((0,0),(3,3),soft_zones=zones,weights=weights,margin=0)
        self.assertAlmostEqual(result.score,reference)


class PreviewAndDiagnosticsTests(unittest.TestCase):
    def test_export_helpers_do_not_overwrite_inputs(self):
        import tempfile
        from nss_engine.preview_v031 import export_preview
        from nss_engine.workflow_v030 import write_report
        from nss_engine.diagnostics_v034 import run
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'source.json';p.write_text('keep')
            for action in (lambda:export_preview(p,p),lambda:write_report({'source_snapshot':str(p)},p),lambda:run(p,p)):
                with self.assertRaises(ValueError):action()
                self.assertEqual(p.read_text(),'keep')
    def test_preview_python_rejects_ids_native_would_reject(self):
        for name in ('has space','bad/name','ККС'):
            with self.assertRaises(ValueError):preview_from_report({'schema_version':'0.30','routes':{name:{'status':'OK','points':[[0,0],[1,0]]}}})
        with self.assertRaises(ValueError):preview_from_report({'schema_version':'0.30','routes':{name:{'status':'OK','points':[[0,0],[1,0]]} for name in ('A','a')}})

    def test_malformed_handle_diagnostics_does_not_crash(self):
        result=validate_snapshot({'schema_version':'0.33','segments':[{'handle':{},'a':{'x':0,'y':0},'b':{'x':1,'y':0}}]})
        self.assertIn('MISSING_HANDLE',[i['code'] for i in result['issues']])
