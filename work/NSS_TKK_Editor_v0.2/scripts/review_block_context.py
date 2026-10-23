"""Read-only nested-block context for unresolved ends; never writes CAD geometry."""
import argparse
import json
import math
from pathlib import Path

import ezdxf
from ezdxf.path import make_path
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree


def extract(source, audit_path, target):
    audit=json.loads(audit_path.read_text(encoding='utf8'))
    doc=ezdxf.readfile(source)
    geometry=[];notes=[];errors=[];count=0
    def walk(entity,owner,name,path,depth=0):
        if depth>8:
            errors.append(dict(owner=owner,error='Nested block depth exceeded eight'))
            return
        kind=entity.dxftype()
        if kind=='INSERT':
            try:
                for j,child in enumerate(entity.virtual_entities()):walk(child,owner,name,path+'/'+str(j),depth+1)
            except Exception as exc:errors.append(dict(owner=owner,error=str(exc)))
        elif kind in ('LINE','LWPOLYLINE','POLYLINE','ARC','CIRCLE','ELLIPSE'):
            try:
                points=[list(p) for p in make_path(entity).flattening(.02)]
                if len(points)>1:geometry.append(dict(owner=owner,block=name,path=path,layer=entity.dxf.layer,type=kind,points=points,geometry=LineString([p[:2] for p in points])))
            except Exception as exc:errors.append(dict(owner=owner,error=str(exc)))
        elif kind in ('TEXT','MTEXT','ATTRIB'):
            text=entity.plain_text() if kind=='MTEXT' else entity.dxf.text
            notes.append(dict(owner=owner,block=name,path=path,layer=entity.dxf.layer,text=text,xyz=list(entity.dxf.insert)))
    for block in doc.modelspace().query('INSERT'):
        count+=1;walk(block,block.dxf.handle,block.dxf.name,'')
    tree=STRtree([g['geometry'] for g in geometry]);records=[]
    for record in audit['records']:
        if record['status']!='REQUIRES_DECISION':continue
        p=Point(record['xy']);near=[]
        for idx in tree.query(p.buffer(16)):
            item=geometry[int(idx)];distance=item['geometry'].distance(p)
            if distance<=16:near.append(dict({k:v for k,v in item.items() if k!='geometry'},distance_m=distance))
        near.sort(key=lambda x:x['distance_m'])
        texts=sorted([dict(t,distance_m=math.dist(record['xy'],t['xyz'][:2])) for t in notes if math.dist(record['xy'],t['xyz'][:2])<=20],key=lambda t:t['distance_m'])
        records.append(dict(number=record['number'],geometry=near,texts=texts))
    target.write_text(json.dumps(dict(source=str(source),read_only=True,drawing_written=False,source_blocks=count,extracted_geometry=len(geometry),extracted_texts=len(notes),errors=errors,records=records),ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(dict(source_blocks=count,geometry=len(geometry),texts=len(notes),errors=len(errors),review_locations=len(records))))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--audit',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    args=p.parse_args();extract(args.source,args.audit,args.out)
