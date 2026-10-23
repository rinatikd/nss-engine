from pathlib import Path
import json,math,csv
from shapely.geometry import LineString
OUT=Path(__file__).resolve().parents[2]/'output/DWG_NSS_20261020_Review'

def caption_pair(points,start,end,length,height=1.275):
    line=LineString(points);middle=(start+end)/2
    center=line.interpolate(middle);a=line.interpolate(max(start,middle-.25));b=line.interpolate(min(end,middle+.25))
    angle=math.atan2(b.y-a.y,b.x-a.x)
    if angle>math.pi/2:angle-=math.pi
    if angle<-math.pi/2:angle+=math.pi
    normal=(-math.sin(angle),math.cos(angle));gap=height*1.1
    shown=f'{length:.1f}'.rstrip('0').rstrip('.')
    return [dict(kind='span_caption',layer='NSS_TKK_SPAN_LABELS_PROJECT',xyz=[center.x+normal[0]*offset,center.y+normal[1]*offset,0],text=text,marker=False,rotation=angle,height=height,centered=True) for text,offset in [('0/2',gap),(f'L={shown}м',-gap)]]

def main():
    s=json.loads((OUT/'spacing_results.json').read_text(encoding='utf8'));rows=[];annotations=[]
    for chain in s['intervals']:
        line=LineString(chain['points']);n=chain['parts']
        for i in range(n):
            a=line.length*i/n;b=line.length*(i+1)/n
            pair=caption_pair(chain['points'],a,b,b-a);ids=chain['well_sequence']
            row=dict(id=f'S{len(rows)+1:03}',start=ids[i],end=ids[i+1],length_m=b-a,top='0/2',bottom=pair[1]['text'],chain=chain['chain'],kind='well_to_building' if 'BUILDING_ENTRY' in (ids[i],ids[i+1]) else 'well_to_well')
            rows.append(row);annotations.extend(pair)
    (OUT/'span_labels.json').write_text(json.dumps(dict(spans=rows,annotations=annotations),ensure_ascii=False,indent=2),encoding='utf8')
    with (OUT/'span_labels.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
    assert len(rows)==s['interval_count'] and len(annotations)==2*len(rows)
    assert all(row['length_m']<=120+1e-8 for row in rows)
    print('Captioned spans',len(rows),'two-line labels',len(annotations))
if __name__=='__main__':main()
