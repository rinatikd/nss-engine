from pathlib import Path
import csv,json
import networkx as nx
OUT=Path(__file__).resolve().parents[2]/'output/DWG_NSS_20261020_Review'

def assign_numbers(wells,graph,protected):
    if len(protected)!=24 or len(set(protected))!=24 or not set(protected)<=set(wells):raise ValueError('Invalid protected sequence')
    numbers={key:i+1 for i,key in enumerate(protected)};seen=set(protected)
    def walk(seed):
        stack=[seed]
        while stack:
            node=stack.pop()
            if node in seen:continue
            seen.add(node)
            if node in wells:numbers[node]=len(numbers)+1
            stack.extend(k for k in sorted(graph.neighbors(node),key=lambda k:(graph[node][k]['weight'],str(k)),reverse=True) if k not in seen)
    for anchor in protected:
        for neighbor in sorted(graph.neighbors(anchor),key=lambda k:(graph[anchor][k]['weight'],str(k))):walk(neighbor)
    for key in sorted(wells,key=lambda k:(wells[k][0],wells[k][1],k)):walk(key)
    assert set(numbers)==set(wells) and set(numbers.values())==set(range(1,len(wells)+1))
    return numbers

def main():
    r=json.loads((OUT/'network_review.json').read_text(encoding='utf8'));graph=nx.Graph();raw=nx.Graph()
    for chain in r['spacing']['chains']:raw.add_edge(chain['start'],chain['end'],weight=chain['length_m'])
    source_keys={w['handle'] for w in r['wells']}
    protected=[key for key in nx.shortest_path(raw,'260E20','260E18',weight='weight') if key in source_keys]
    assert len(protected)==24 and protected[-4:]==['260DE2','260F43','260DFB','260E18']
    wells={w['handle']:w['xyz'][:2] for w in r['wells']};wells.update({w['id']:w['xy'] for w in r['candidate_wells']})
    graph.add_nodes_from(wells)
    for chain in r['spacing']['intervals']:
        for a,b in zip(chain['well_sequence'],chain['well_sequence'][1:]):graph.add_edge(a,b,weight=chain['interval_m'])
    for chain in r['spacing']['chains']:
        if not chain['between_wells']:graph.add_edge(chain['start'],chain['end'],weight=chain['length_m'])
    numbers=assign_numbers(wells,graph,protected);rows=[]
    for w in r['wells']:
        key=w['handle'];w.update(number=numbers[key],final_id=f'КК-{numbers[key]}',protected_number=key in protected)
        rows.append(dict(number=numbers[key],key=key,old_id=w['review_id'],kind='исходный проектный',protected=key in protected,x=w['xyz'][0],y=w['xyz'][1]))
    for w in r['candidate_wells']:
        key=w['id'];w.update(number=numbers[key],final_id=f'КК-{numbers[key]}')
        rows.append(dict(number=numbers[key],key=key,old_id=key,kind='добавленный проектный',protected=False,x=w['xy'][0],y=w['xy'][1]))
    for w in sorted(r['previous_wells'],key=lambda w:w['xyz'][0]):
        number=len(numbers)+1;key=w['handle'];numbers[key]=number;w.update(number=number,final_id=f'КК-{number}')
        rows.append(dict(number=number,key=key,old_id=key,kind='ранее запроектированный по выноске',protected=False,x=w['xyz'][0],y=w['xyz'][1]))
    key='LEADER_260DC7';number=len(numbers)+1;numbers[key]=number
    rows.append(dict(number=number,key=key,old_id='260DC7',kind='существующий по выноске; отдельный блок не установлен',protected=False,x=5024.7401,y=-10532.2063))
    result=dict(confirmed_direction='260E20 reference -> 21:260DE2 -> 22:260F43 -> 23:260DFB -> 24:260E18',protected_handles=protected,reference_start_not_in_project_sequence='260E20',numbers=numbers,project_count=len(wells),total=len(numbers),rows=sorted(rows,key=lambda row:row['number']),logical_graph_components=nx.number_connected_components(graph))
    assert [numbers[key] for key in protected]==list(range(1,25)) and len(set(numbers.values()))==len(numbers)
    r['numbering']=result
    (OUT/'network_review.json').write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8');(OUT/'well_numbering.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    with (OUT/'well_numbering.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(result['rows'])
    print('Numbering 1..'+str(len(numbers))+' unique; protected 1..24; project wells',len(wells))
if __name__=='__main__':main()
