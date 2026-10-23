"""Equal chainage spacing; no displacement of source well symbols or route geometry."""
from pathlib import Path
import collections,json,math,csv
import networkx as nx
from shapely.geometry import LineString,Point
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'output/DWG_NSS_20261020_Review'

def divisions(length):
    minimum=max(1,math.ceil(length/120-1e-10))
    feasible=[n for n in range(minimum,max(minimum,math.ceil(length/50))+1) if 50-1e-8<=length/n<=70+1e-8]
    return min(feasible,key=lambda n:(abs(length/n-60),n)) if feasible else minimum

def main():
    r=json.loads((OUT/'network_review.json').read_text(encoding='utf8'))
    backup=OUT/'network_review_before_spacing.json'
    if not backup.exists():backup.write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8')
    original=json.loads(backup.read_text(encoding='utf8'))
    excluded={'П-02','П-03','П-04'}
    kept=[dict(c) for c in original['candidate_wells'] if c['id'] not in excluded]
    anchors={w['handle']:w['xyz'][:2] for w in r['wells']}
    reference=next(w for w in r['previous_wells'] if w['handle']=='260E20')
    anchors[reference['handle']]=reference['xyz'][:2]
    anchors.update({c['id']:c['xy'] for c in kept})
    building_route=next(route for route in r['routes'] if route['handle']=='260F55')
    building_entry=building_route['points'][-1][:2]
    anchors['BUILDING_ENTRY']=building_entry  # boundary for spacing, never a new well
    graph=nx.MultiGraph();edge_data={};node_xy={};next_edge=0
    def node(point):
        for key,xy in node_xy.items():
            if math.dist(xy,point)<0.2:return key
        key='E'+str(len(node_xy));node_xy[key]=list(point);return key
    for route in r['routes']:
        line=LineString([p[:2] for p in route['points']]);cuts=[(0,None),(line.length,None)]
        for key,xy in anchors.items():
            if line.distance(Point(xy))<=1.1:cuts.append((line.project(Point(xy)),key))
        cuts.sort(key=lambda v:v[0]);merged=[]
        for pos,key in cuts:
            if merged and abs(pos-merged[-1][0])<0.005:
                if key:merged[-1]=(pos,key)
            else:merged.append((pos,key))
        for (a,ka),(b,kb) in zip(merged,merged[1:]):
            if b-a<0.005:continue
            start=list(line.interpolate(a).coords[0]);end=list(line.interpolate(b).coords[0]);ka=ka or node(start);kb=kb or node(end)
            node_xy.setdefault(ka,start);node_xy.setdefault(kb,end)
            # Preserve original intermediate vertices and planar curve approximation.
            from shapely.ops import substring
            path=substring(line,a,b);points=list(path.coords)
            edge_data[next_edge]=dict(a=ka,b=kb,points=points,length=b-a,handle=route['handle'])
            graph.add_edge(ka,kb,key=next_edge);next_edge+=1
    fixed=set(anchors);stops={n for n in graph if n in fixed or graph.degree(n)!=2};visited=set();chains=[]
    for start in sorted(stops):
        for _,n,key in list(graph.edges(start,keys=True)):
            if key in visited:continue
            current=start;edge=key;points=[];handles=[];length=0
            while edge not in visited:
                visited.add(edge);e=edge_data[edge];forward=e['a']==current;following=e['b'] if forward else e['a'];p=e['points'] if forward else list(reversed(e['points']))
                points.extend(p if not points else p[1:]);handles.append(e['handle']);length+=e['length'];current=following
                if current in stops:break
                available=[k for _,_,k in graph.edges(current,keys=True) if k not in visited]
                if not available:break
                edge=available[0]
            chains.append(dict(start=start,end=current,points=points,length_m=length,handles=handles,between_wells=start in fixed and current in fixed))
    terminal_proposals=[]
    for chain in chains:chain['between_wells']=chain['start'] in fixed and chain['end'] in fixed
    additions=[];intervals=[];unresolved=[]
    forbidden=[c['xy'] for c in original['candidate_wells'] if c['id'] in excluded]+[building_entry]
    for index,chain in enumerate(chains,1):
        if not chain['between_wells']:
            unresolved.append(dict(chain=index,length_m=chain['length_m'],start=chain['start'],end=chain['end'],reason='Неподтверждённый конец/стык: не считается пролётом между колодцами'));continue
        line=LineString(chain['points']);length=line.length;n=divisions(length)
        chain_ids=[chain['start']]
        for step in range(1,n):
            xy=list(line.interpolate(step*length/n).coords[0])
            if any(math.dist(xy,p)<1.5 for p in forbidden):
                raise ValueError('Equal-spacing location overlaps excluded П-03/П-04; engineer adjustment required')
            additions.append(dict(id=f'Д-{len(additions)+1:03}',xy=xy,reason=f'Равномерное деление пролёта {index}: {length:.3f} м на {n} частей по {length/n:.3f} м',handles=list(dict.fromkeys(chain['handles'])),approved=False,chain=index))
            chain_ids.append(additions[-1]['id'])
        chain_ids.append(chain['end'])
        intervals.append(dict(chain=index,start=chain['start'],end=chain['end'],length_m=length,parts=n,interval_m=length/n,within_120=length/n<=120+1e-8,target_50_70=50-1e-8<=length/n<=70+1e-8,source_handles=chain['handles'],points=chain['points'],well_sequence=chain_ids,boundary_kind='well_to_building' if 'BUILDING_ENTRY' in chain_ids else 'well_to_well'))
    r.update(analysis_units='meters_confirmed_by_engineer',scope='project_layer',candidate_wells=kept+additions)
    summary=dict(existing_wells_fixed=len(r['wells']),retained_proposals=[c['id'] for c in kept],excluded=['П-02','П-03','П-04','П-Т01'],building_entry=building_entry,spacing_additions=len(additions),terminal_proposals=len(terminal_proposals),checked_chains=len(intervals),interval_count=sum(i['parts'] for i in intervals),max_interval_m=max(i['interval_m'] for i in intervals),all_checked_intervals_within_120=all(i['within_120'] for i in intervals),unresolved_chains=len(unresolved),max_unresolved_chain_m=max((x['length_m'] for x in unresolved),default=0),unvisited_edges=len(edge_data)-len(visited),intervals=intervals,unresolved=unresolved)
    r['spacing']=summary
    summary['chains']=chains
    (OUT/'network_review.json').write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8')
    (OUT/'spacing_results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
    for name,rows in [('candidate_wells',r['candidate_wells']),('spacing_intervals',intervals),('spacing_unresolved',unresolved)]:
        with (OUT/(name+'.csv')).open('w',encoding='utf-8-sig',newline='') as f:
            keys=list(dict.fromkeys(k for row in rows for k in row));writer=csv.DictWriter(f,fieldnames=keys);writer.writeheader();writer.writerows(rows)
    print({k:v for k,v in summary.items() if k not in ('intervals','unresolved')})

if __name__=='__main__':main()
