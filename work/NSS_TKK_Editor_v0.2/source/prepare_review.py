from pathlib import Path
import json,hashlib,collections
import ezdxf
from ezdxf.addons import Importer
from fes_format import add_label,style_leader,STYLE,HEIGHT,MASK_SCALE
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'output/DWG_NSS_20261020_Review'
r=json.loads((OUT/'network_review.json').read_text(encoding='utf8'))
inventory=json.loads((OUT/'inventory_telecom.json').read_text(encoding='utf8'))
source=ezdxf.readfile(OUT/'source_snapshot.dxf')
original_layer='пр_телефонная_канализация'
names={'route':'NSS_TKK_ROUTE_PROJECT','well':'NSS_TKK_WELLS_PROJECT','text':'NSS_TKK_LABELS_PROJECT','id':'NSS_REVIEW_WELL_IDS','candidate':'NSS_TKK_LABELS_ADDED_PROJECT','finding':'NSS_REVIEW_ISSUES','added':'NSS_TKK_WELLS_ADDED_PROJECT'}
layers=[dict(name=names[key],color=color,plot=plot) for key,color,plot in [('route',1,True),('well',3,True),('text',7,True),('id',3,False),('candidate',6,False),('finding',2,False)]]
layers.append(dict(name=names['added'],color=6,plot=True))
next(l for l in layers if l['name']==names['candidate'])['plot']=True
next(l for l in layers if l['name']==names['text']).update(plot=False,off=True)
layers.append(dict(name='NSS_TKK_SPAN_LABELS_PROJECT',color=7,plot=True))
next(l for l in layers if l['name']==names['id'])['plot']=True
moves=[]
for row in inventory:
    if row['layer']!=original_layer:continue
    target=names['route'] if row['type'] in ('LINE','ARC','LWPOLYLINE') else names['well'] if row['type']=='INSERT' else names['text'] if row['type']=='MTEXT' else None
    if target:moves.append(dict(handle=row['handle'],original_layer=row['layer'],target_layer=target))
assert len(moves)==251
annotations=[]
for w in r['wells']:annotations.append(dict(kind='well_number',layer=names['id'],xyz=[*w['xyz'][:2],0],text=w['final_id'],marker=False))
for w in r['candidate_wells']:annotations.append(dict(kind='well_number',layer=names['candidate'],xyz=[*w['xy'],0],text=w['final_id'],marker=False))
for f in r['findings']:annotations.append(dict(layer=names['finding'],xyz=[*f['xy'],0],text=f['id'],marker=True))
annotations.extend(json.loads((OUT/'span_labels.json').read_text(encoding='utf8'))['annotations'])
plan=dict(source_sha256=r['source_sha256'],engineering_approved=False,scope='project_layer_only',units_confirmed=True,numbering='provisional_west_to_east_not_approved_branch_numbering',layers=layers,moves=moves,annotations=annotations,new_wells=r['candidate_wells'],template_well=r['wells'][0],added_well_layer=names['added'])
plan['numbering_confirmed']=True
plan['protected_numbering']=r['numbering']['protected_handles']
plan['numbering']='fixed_1_24_then_consecutive_25_112'
plan['text_format']=dict(style=STYLE,height=HEIGHT,background='canvas',background_scale=MASK_SCALE)
leader_updates=[]
reference_by_handle={w['handle']:w for w in r['previous_wells']}
for leader_handle,well_handle in [('260DCE','260E1D'),('260DD1','260E1F'),('260DD2','260E1E'),('260DD3','260E20')]:
    w=reference_by_handle[well_handle]
    leader_updates.append(dict(handle=leader_handle,well_handle=well_handle,text=w['final_id']+'\\PРанее запроектированный ККС-2',number=w['number']))
existing_number=r['numbering']['numbers']['LEADER_260DC7']
leader_updates.append(dict(handle='260DC7',well_handle=None,text=f'КК-{existing_number}\\PСуществующий колодец связи',number=existing_number))
plan['leader_updates']=leader_updates
(OUT/'edit_plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8')
preview=ezdxf.new('R2018');preview.units=6
for l in layers:preview.layers.new(l['name'],dxfattribs=dict(color=l['color'],plot=int(l['plot'])))
for l in layers:
    if l.get('off'):preview.layers.get(l['name']).off()
importer=Importer(source,preview)
selected=[source.entitydb[a['handle']] for a in moves]+[source.entitydb[w['handle']] for w in r['previous_wells']]
importer.import_entities(selected);importer.finalize()
if STYLE not in preview.styles:preview.styles.new(STYLE,dxfattribs=dict(font=source.styles.get(STYLE).dxf.font))
# Importer assigns new handles, so map the ordered imported model entities.
entities=list(preview.modelspace());assert len(entities)==len(selected)
for entity,action in zip(entities,moves):entity.dxf.layer=action['target_layer']
block=preview.blocks.new('NSS_TKK_ADDED_WELL_C')
template=source.entitydb[r['wells'][0]['handle']];center=r['wells'][0]['xyz']
for entity in template.virtual_entities():
    entity=entity.copy();entity.translate(-center[0],-center[1],-center[2]);entity.dxf.layer='0';block.add_entity(entity)
for w in r['candidate_wells']:preview.modelspace().add_blockref(block.name,(*w['xy'],0),dxfattribs=dict(layer=names['added']))
for a in annotations:
    point=a['xyz'];layer=a['layer']
    if a['marker']:preview.modelspace().add_circle(point,1.5,dxfattribs=dict(layer=layer))
    if a.get('kind') in ('well_number','span_caption'):
        pos=point if a.get('centered') else (point[0]+2,point[1]+2,0)
        add_label(preview.modelspace(),a['text'],pos,layer,rotation=a.get('rotation',0)*180/3.141592653589793,centered=a.get('centered',False))
    else:preview.modelspace().add_text(a['text'],dxfattribs=dict(layer=layer,height=1.5,insert=(point[0]+2,point[1]+2,0)))
path=OUT/'TKK_REVIEW_OVERLAY.dxf';preview.saveas(path)
loaded=ezdxf.readfile(path);counts=collections.Counter(e.dxf.layer for e in loaded.modelspace())
assert counts[names['route']]==76 and counts[names['well']]==67 and counts[names['text']]==108
assert counts[names['id']]==67 and counts[names['candidate']]==len(r['candidate_wells']) and counts[names['added']]==len(r['candidate_wells']) and counts[names['finding']]==64
assert counts['NSS_TKK_SPAN_LABELS_PROJECT']==2*r['spacing']['interval_count']
assert len({w['review_id'] for w in r['wells']})==67
assert max(w['distance_to_route_units'] for w in r['wells'])<1
assert all(min(((w['xyz'][0]-c['xy'][0])**2+(w['xyz'][1]-c['xy'][1])**2)**0.5 for w in r['wells']+r['previous_wells'])>=1.5 for c in r['candidate_wells'])
source_hash=hashlib.sha256((ROOT/'work/DWG_20261020_Review/source_original.dwg').read_bytes()).hexdigest();assert source_hash==r['source_sha256']
checks=dict(phase='OFFLINE_REVIEW_PREPARED',source_copy_unchanged=True,moves=len(moves),annotations=len(annotations),preview_counts=dict(counts),added_wells=len(r['candidate_wells']),well_ids_unique=True,protected_numbers='1..24',existing_leader_updates=len(leader_updates),transformed_well_centers_match_routes=True,units_confirmed=True,native_dwg_created=False)
(OUT/'review_checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf8')
dll=OUT/'plugin/NssDwgReview.WorkCopy.20261020E.dll'
text='(vl-load-com)\n(if (not (car (atoms-family 1 (list "NSS_DWG_CREATE_REVIEW_20261020E")))) (command-s "_.NETLOAD" "'+dll.as_posix()+'"))\n(if (car (atoms-family 1 (list "NSS_DWG_CREATE_REVIEW_20261020E"))) (NSS_DWG_CREATE_REVIEW_20261020E) (princ "\\nNSS review-copy DLL did not load."))\n(princ)\n'
(OUT/'CREATE_DWG_REVIEW_COPY.lsp').write_text(text,encoding='utf-8-sig')
print(json.dumps(checks,ensure_ascii=False,indent=2))
