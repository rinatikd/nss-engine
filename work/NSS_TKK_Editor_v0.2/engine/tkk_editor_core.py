"""Snapshot -> topology, numbering, lengths, placement. Never edits source geometry."""
import json,math,sys,hashlib
from pathlib import Path
import networkx as nx
from shapely.geometry import Point,LineString
from shapely.strtree import STRtree
from shapely.ops import substring
from leader_layout import place_leaders
from span_labels import caption_pair
from snapshot_validation import validate_snapshot
from diagnostics import enrich_warnings, summary, write_reports

ZERO_XY_SEGMENT_TOLERANCE_M = 1e-12
WELL_PAIR_REVIEW_TOLERANCE_M = .005
MAX_WELL_PAIR_WARNINGS = 10000


def _intersection_points(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == 'Point':
        return [list(geometry.coords[0])]
    if geometry.geom_type in ('LineString', 'LinearRing'):
        coords = list(geometry.coords)
        return [list(coords[0]), list(coords[-1])] if coords else []
    if hasattr(geometry, 'geoms'):
        return [point for part in geometry.geoms for point in _intersection_points(part)]
    return []


def _self_intersections(route, zero_xy_segment_tolerance_m):
    points = [point[:2] for point in route['points']]
    segments = []
    segment_indexes = []
    for index, (start, end) in enumerate(zip(points, points[1:])):
        if math.dist(start, end) <= zero_xy_segment_tolerance_m:
            continue
        segments.append(LineString([start, end]))
        segment_indexes.append(index)
    if len(segments) < 3:
        return []
    tree = STRtree(segments)
    closed = points[0] == points[-1]
    intersections = {}
    for local_index, segment in enumerate(segments):
        original_index = segment_indexes[local_index]
        for candidate in tree.query(segment, predicate='intersects'):
            other_local = int(candidate)
            if other_local <= local_index:
                continue
            other_index = segment_indexes[other_local]
            if other_index - original_index <= 1:
                continue
            if closed and original_index == 0 and other_index == len(points) - 2:
                continue
            for point in _intersection_points(segment.intersection(segments[other_local])):
                key = tuple(round(value, 9) for value in point[:2])
                intersections[key] = list(key)
    return [intersections[key] for key in sorted(intersections)]


def _near_well_pairs(wells, tolerance_m):
    """Find close XY pairs with a grid, bounding work and report size for dense input."""
    cells = {}
    pairs = []
    truncated = False
    for well in sorted(wells, key=lambda item: item['id']):
        x, y = well['xyz'][:2]
        cell = (math.floor(x / tolerance_m), math.floor(y / tolerance_m))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other in cells.get((cell[0] + dx, cell[1] + dy), []):
                    distance = math.dist((x, y), other['xyz'][:2])
                    if distance <= tolerance_m:
                        if len(pairs) == MAX_WELL_PAIR_WARNINGS:
                            truncated = True
                            return pairs, truncated
                        pairs.append((other['id'], well['id'], distance, (x, y), other['xyz'][:2]))
        cells.setdefault(cell, []).append(well)
    return pairs, truncated


def analyze(data, *, well_pair_review_tolerance_m=WELL_PAIR_REVIEW_TOLERANCE_M,
            zero_xy_segment_tolerance_m=ZERO_XY_SEGMENT_TOLERANCE_M):
    validate_snapshot(data)
    if (isinstance(well_pair_review_tolerance_m, bool)
            or not isinstance(well_pair_review_tolerance_m, (int, float))
            or not math.isfinite(well_pair_review_tolerance_m)
            or well_pair_review_tolerance_m <= 0):
        raise ValueError('Well-pair review tolerance must be positive and finite')
    if (isinstance(zero_xy_segment_tolerance_m, bool)
            or not isinstance(zero_xy_segment_tolerance_m, (int, float))
            or not math.isfinite(zero_xy_segment_tolerance_m)
            or zero_xy_segment_tolerance_m < 0):
        raise ValueError('Zero-XY-segment tolerance must be finite and non-negative')
    wells={w['id']:w for w in sorted(data['wells'],key=lambda w:w['id'])};protected=data.get('protected',{});warnings=[]
    routes=sorted(data['routes'],key=lambda route:route['id'])
    if len(wells)!=len(data['wells']):raise ValueError('Duplicate well identities')
    if len({r['id'] for r in data['routes']})!=len(data['routes']):raise ValueError('Duplicate route identities')
    for route in routes:
        for index, (start, end) in enumerate(zip(route['points'], route['points'][1:])):
            if math.dist(start[:2], end[:2]) <= zero_xy_segment_tolerance_m:
                warnings.append(dict(code='ZERO_LENGTH_SEGMENT', id=route['id'], routes=[route['id']],
                                     segment_index=index, review_points=[start[:2]],
                                     xy_tolerance_m=zero_xy_segment_tolerance_m,
                                     message='Соседние вершины совпадают в XY; Z не используется для топологии.'))
        crossings = _self_intersections(route, zero_xy_segment_tolerance_m)
        if crossings:
            warnings.append(dict(code='SELF_INTERSECTION', id=route['id'], routes=[route['id']],
                                 review_points=crossings,
                                 message='Самопересечение в XY отмечено для просмотра; связность в точке пересечения не выводится.'))
    close_pairs, pair_warnings_truncated = _near_well_pairs(data['wells'], well_pair_review_tolerance_m)
    for first, second, distance, first_xy, second_xy in close_pairs:
        warnings.append(dict(code='WELL_SPACING_BELOW_RESOLUTION', id=first, other_id=second,
                             distance_m=distance, review_points=[first_xy, second_xy],
                             message='Расстояние меньше явного допуска проверки; автоматическое объединение запрещено.'))
    if pair_warnings_truncated:
        warnings.append(dict(code='WELL_PAIR_REVIEW_LIMIT', message='Количество близких пар превышает лимит отчёта; перечислены первые 10000.'))
    coords={key:w['xyz'][:2] for key,w in wells.items()};fixed=set(coords)
    for route in routes:
        if route.get('building_entry'):
            key='ENTRY:'+route['id'];coords[key]=route['points'][-1][:2];fixed.add(key)
    graph=nx.MultiGraph();edges={};nodes=dict(coords);eid=0
    def endpoint(xy):
        for key,p in nodes.items():
            if key not in fixed and math.dist(xy,p)<.2:return key
        key='END:'+str(len(nodes));nodes[key]=list(xy);return key
    for route in routes:
        line=LineString([p[:2] for p in route['points']]);cuts=[(0,None),(line.length,None)]
        for key,xy in coords.items():
            if line.distance(Point(xy))<=1.1:
                station=line.project(Point(xy));cuts.append((station,key))
                if line.is_closed and station<.005:cuts.append((line.length,key))
        cuts.sort(key=lambda c:c[0]);merged=[]
        for pos,key in cuts:
            if merged and abs(pos-merged[-1][0])<.005:
                previous=merged[-1][1]
                if key and previous and key!=previous:
                    raise ValueError(f"Ambiguous connection on route {route['id']}: {previous} and {key} share a station within 0.005 m")
                if key:merged[-1]=(pos,key)
            else:merged.append((pos,key))
        for (a,ka),(b,kb) in zip(merged,merged[1:]):
            if b-a<.005:continue
            shape=substring(line,a,b);ka=ka or endpoint(shape.coords[0]);kb=kb or endpoint(shape.coords[-1])
            edges[eid]=dict(a=ka,b=kb,points=list(shape.coords),route=route['id']);graph.add_edge(ka,kb,key=eid,weight=b-a);eid+=1
    stops={key for key in graph if key in fixed or graph.degree(key)!=2};visited=set();chains=[]
    for start in sorted(stops):
        for _,_,edge in list(graph.edges(start,keys=True)):
            if edge in visited:continue
            current=start;points=[];route_ids=[]
            while edge not in visited:
                visited.add(edge);item=edges[edge];forward=item['a']==current;other=item['b'] if forward else item['a'];p=item['points'] if forward else list(reversed(item['points']))
                points.extend(p if not points else p[1:]);route_ids.append(item['route']);current=other
                if current in stops:break
                pending=[k for _,_,k in graph.edges(current,keys=True) if k not in visited]
                if not pending:break
                edge=pending[0]
            chains.append(dict(start=start,end=current,points=points,routes=route_ids))
    if len(visited)!=len(edges):
        remaining=set(edges)-visited
        # Each disconnected unanchored loop needs its own review location.
        while remaining:
            seed=min(remaining);component=nx.node_connected_component(graph,edges[seed]['a'])
            loop={k for k in remaining if edges[k]['a'] in component};remaining-=loop
            warnings.append(dict(code='UNANCHORED_LOOP',routes=sorted({edges[k]['route'] for k in loop}),review_points=[p for k in sorted(loop) for p in edges[k]['points']],message='Замкнутый участок без распознанного колодца не подписан'))
    simple=nx.Graph();simple.add_nodes_from(wells)
    for a,b,attrs in graph.edges(data=True):simple.add_edge(a,b,weight=attrs['weight'])
    numbers={key:int(number) for key,number in protected.items() if key in wells};seen=set(numbers);next_number=max([24,*map(int,protected.values())])+1
    def walk(seed):
        nonlocal next_number
        stack=[seed]
        while stack:
            key=stack.pop()
            if key in seen:continue
            seen.add(key)
            if key in wells and not wells[key].get('reference'):
                numbers[key]=next_number;next_number+=1
            stack.extend(k for k in sorted(simple.neighbors(key),key=lambda k:(simple[key][k]['weight'],k),reverse=True) if k not in seen)
    for seed in sorted(numbers,key=lambda k:numbers[k]):
        for neighbor in sorted(simple.neighbors(seed)):walk(neighbor)
    for seed in sorted(wells,key=lambda k:(wells[k]['xyz'][0],wells[k]['xyz'][1],k)):walk(seed)
    for key in sorted((k for k in wells if wells[k].get('reference') and k not in numbers),key=lambda k:(wells[k].get('previous_number',10**9),wells[k]['xyz'][0],k)):
        numbers[key]=next_number;next_number+=1
    for key in protected:
        if key not in wells:warnings.append(dict(code='PROTECTED_WELL_DELETED',id=key,number=protected[key],message='Закреплённый номер зарезервирован и не переиспользован'))
    assert len(set(numbers.values()))==len(numbers) and set(numbers)==set(wells)
    captions=[];spans=[]
    for chain in chains:
        a,b=chain['start'],chain['end']
        endpoints=[dict(xy=list(point[:2]),kind='well' if node in wells else 'building_entry' if node in fixed else 'unresolved',degree=graph.degree(node),**({'well_id':node} if node in wells else {})) for node,point in [(a,chain['points'][0]),(b,chain['points'][-1])]]
        if a==b:
            warnings.append(dict(code='SELF_RETURNING_SPAN',id=a,routes=chain['routes'],endpoints=endpoints,review_points=chain['points'],message='Участок возвращается к тому же узлу; требуется проверка'))
            continue
        if a not in fixed or b not in fixed:
            warnings.append(dict(code='UNRESOLVED_CONNECTION',routes=chain['routes'],endpoints=endpoints,length_m=LineString(chain['points']).length,review_points=chain['points']));continue
        if a not in wells and b not in wells:continue
        length=LineString(chain['points']).length;identity=min(a,b)+':'+max(a,b)+':'+','.join(sorted(set(chain['routes'])))
        key='span:'+hashlib.sha256(identity.encode('utf8')).hexdigest()
        if length>120+1e-8:warnings.append(dict(code='SPAN_OVER_120M',start=a,end=b,length_m=length,routes=chain['routes'],endpoints=endpoints,review_points=chain['points']))
        pair=caption_pair(chain['points'],0,length,length,height=1.25)
        for index,label in enumerate(pair):label.update(key=key+':'+str(index))
        captions.extend(pair);spans.append(dict(start=a,end=b,start_number=numbers.get(a),end_number=numbers.get(b),length_m=length))
    placed=[]
    well_rotations=[]
    for key,w in wells.items():
        text=f'КК-{numbers[key]}'
        if w.get('reference'):
            if w.get('description'):text+='\\P'+w['description']
        else:
            text=f'ОК-{numbers[key]} в проектируемой телефонной канализации'
        placed.append(dict(key='well:'+key,text=text,xyz=w['xyz'],layer='NSS_TKK_CALLOUTS',reference=w.get('reference',False),radius=w.get('radius',.315)))
        if not w.get('reference') and math.isfinite(w.get('long_axis',float('nan'))):
            point=Point(w['xyz'][:2]);closest=None
            for route in routes:
                points=route['points']
                for a,b in zip(points,points[1:]):
                    dx=b[0]-a[0];dy=b[1]-a[1];den=dx*dx+dy*dy
                    if den<1e-12:continue
                    t=max(0.0,min(1.0,((w['xyz'][0]-a[0])*dx+(w['xyz'][1]-a[1])*dy)/den))
                    qx=a[0]+t*dx;qy=a[1]+t*dy;distance=math.hypot(w['xyz'][0]-qx,w['xyz'][1]-qy)
                    if closest is None or distance<closest[0]:closest=(distance,math.atan2(dy,dx))
            if closest is not None:well_rotations.append(dict(id=key,rotation=closest[1]-w['long_axis']))
        if key not in graph:warnings.append(dict(code='WELL_OFF_ROUTE',id=key))
    leaders,layout=place_leaders(placed,routes,captions)
    warnings=enrich_warnings(warnings,wells,routes,numbers)
    return dict(phase='READY',job_id=data.get('job_id'),fingerprint=data.get('fingerprint'),numbering=numbers,spans=spans,captions=captions,leaders=leaders,well_rotations=well_rotations,layout_checks=layout,warnings=warnings,diagnostics=summary(warnings,well_pair_review_tolerance_m,zero_xy_segment_tolerance_m),source_geometry_changed=bool(well_rotations))

def main():
    source,target=map(Path,sys.argv[1:3])
    try:
        data=json.loads(source.read_text(encoding='utf-8-sig'));result=analyze(data)
        write_reports(data,result,target.parent)
    except Exception as error:
        import traceback
        result=dict(phase='FAILED',error=str(error),traceback=traceback.format_exc())
    temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');temporary.replace(target)
if __name__=='__main__':main()
