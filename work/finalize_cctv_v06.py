from pathlib import Path
import math,json,ezdxf
root=Path(__file__).resolve().parents[1]
src=root/'work'/'CCTV_Source_v06.dxf';out=root/'work'/'CCTV_Source_v06.dxf'
d=ezdxf.readfile(src);m=d.modelspace()
support='СВН_Опоры_освещения';pnd='СВН_Труба_ПНД_к_шкафам'
cab_layer=next(i.dxf.layer for i in m.query('INSERT') if i.dxf.name=='UGO_SVN_CABINET')
prefix='ШК-08-'
def closest_text(ins, layer, pref):
    return min([t for t in m.query(f'TEXT[layer=="{layer}"]') if t.dxf.text.startswith(pref)],key=lambda t:math.hypot(t.dxf.insert.x-ins.dxf.insert.x,t.dxf.insert.y-ins.dxf.insert.y))
cabinets=[]
for ins in m.query(f'INSERT[layer=="{cab_layer}"]'):
    txt=closest_text(ins,cab_layer,prefix)
    if txt.dxf.text.endswith('-00'): cabinets.append((ins,txt))
if len(cabinets)!=1:raise RuntimeError(f'expected central cabinet -00, found {len(cabinets)}')
central,central_label=cabinets[0];cx,cy=central.dxf.insert.x,central.dxf.insert.y
# Central cabinet 08-00 is not an outdoor pole cabinet; remove its provisional PND drop and pole marker.
branches=list(m.query(f'LWPOLYLINE[layer=="{pnd}"]'))
branch=min(branches,key=lambda e:min(math.hypot(p[0]-cx,p[1]-cy) for p in e.get_points('xy')))
m.delete_entity(branch)
labels=list(m.query(f'TEXT[layer=="{pnd}"]'))
if labels:
    m.delete_entity(min(labels,key=lambda e:math.hypot(e.dxf.insert.x-cx,e.dxf.insert.y-cy)))
for e in list(m):
    if e.dxf.layer==support:
        if e.dxftype()=='CIRCLE' and math.hypot(e.dxf.center.x-cx,e.dxf.center.y-cy)<3:m.delete_entity(e)
        elif e.dxftype()=='LINE':
            mx=(e.dxf.start.x+e.dxf.end.x)/2;my=(e.dxf.start.y+e.dxf.end.y)/2
            if math.hypot(mx-cx,my-cy)<3:m.delete_entity(e)
# Move thermal callouts away from the paired camera symbols; cameras remain back-to-back on a shared pole.
tlayer='СВН_Тепловизоры'
therm=[i for i in m.query(f'INSERT[layer=="{tlayer}"]')]
texts=[t for t in m.query(f'TEXT[layer=="{tlayer}"]') if t.dxf.text.startswith('ТВ-08-')]
for t in texts:
    ins=min(therm,key=lambda q:math.hypot(q.dxf.insert.x-t.dxf.insert.x,q.dxf.insert.y-t.dxf.insert.y))
    n=int(t.dxf.text.rsplit('-',1)[1]);pairnum=(n-1)//2
    pairtexts=[x for x in texts if (int(x.dxf.text.rsplit('-',1)[1])-1)//2==pairnum]
    if len(pairtexts)!=2: continue
    pairins=[]
    for pt in pairtexts:
        pairins.append(min(therm,key=lambda q:math.hypot(q.dxf.insert.x-pt.dxf.insert.x,q.dxf.insert.y-pt.dxf.insert.y)))
    odd=pairins[0] if int(pairtexts[0].dxf.text.rsplit('-',1)[1])%2 else pairins[1]
    even=pairins[1] if odd is pairins[0] else pairins[0]
    vx=odd.dxf.insert.x-even.dxf.insert.x;vy=odd.dxf.insert.y-even.dxf.insert.y;ln=math.hypot(vx,vy) or 1
    sign=1 if n%2 else -1
    t.dxf.insert=(ins.dxf.insert.x+sign*4.5*vx/ln,ins.dxf.insert.y+sign*4.5*vy/ln,0)
# Replace plan/schedule note with accurate caveat: DWG has TKK routes but no well symbols in site coordinates.
plan=next(l for l in d.layouts if '01_' in l.name);sheet6=next(l for l in d.layouts if '06_' in l.name)
for lo in (plan,sheet6):
    for e in list(lo):
        if e.dxf.layer==support and e.dxftype() in ('TEXT','MTEXT'):lo.delete_entity(e)
plan.add_mtext('ОС — условная точка установки на существующей опоре освещения; привязать по исполнительному плану.\\PПНД — от ближайшего узла видимой трассы ТКК к полевому шкафу; точку колодца уточнить по исходному DWG.\\PPTZ: круговая патрульная зона 360° / DORI Observe 43,7 м; поворотная камера не формирует панорамное изображение одновременно.\\PТВ-08-07 направлен по касательной к ограждению; осевые линии показывают азимут камер.',
    dxfattribs={'insert':(860,118),'char_height':2.1,'width':290,'style':'Standard','layer':support,'lineweight':40})
sheet6.add_text('12 ПНД-ответвлений от ближайших узлов видимой ТКК к шкафам на опорах; привязку к колодцам и диаметры уточнить.',
    dxfattribs={'insert':(13.5,218),'height':2.0,'style':'Standard','layer':support,'lineweight':40})
audit=d.audit()
if audit.errors:raise RuntimeError(f'audit errors {len(audit.errors)}')
d.saveas(out);check=ezdxf.readfile(out);cm=check.modelspace()
report=json.loads((root/'work'/'cctv_v06_build_report.json').read_text(encoding='utf-8'))
report['pnd_branches']=len(list(cm.query(f'LWPOLYLINE[layer=="{pnd}"]')))
report['pnd_lengths']=[{'branch':i.dxf.handle,'length_m':round(math.hypot(i.get_points('xy')[1][0]-i.get_points('xy')[0][0],i.get_points('xy')[1][1]-i.get_points('xy')[0][1]),1)} for i in cm.query(f'LWPOLYLINE[layer=="{pnd}"]')]
report['lighting_support_symbols']=len(list(cm.query(f'CIRCLE[layer=="{support}"]')))
report['audit_errors']=len(check.audit().errors)
(root/'work'/'cctv_v06_build_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:report[k] for k in ('pnd_branches','lighting_support_symbols','audit_errors','physical_cameras','video_channels')},ensure_ascii=False))
