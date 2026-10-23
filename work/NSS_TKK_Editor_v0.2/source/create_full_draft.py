"""Review DXF with full exported background; original DWG is never written."""
from pathlib import Path
import hashlib,json,collections
import ezdxf
from ezdxf.lldxf.tagwriter import TagCollector
from ezdxf.enums import TextEntityAlignment
from fes_format import add_label,style_leader,STYLE,HEIGHT,MASK_SCALE
OUT=Path(__file__).resolve().parents[2]/'output/DWG_NSS_20261020_Review'
plan=json.loads((OUT/'edit_plan.json').read_text(encoding='utf8'))
d=ezdxf.readfile(OUT/'source_snapshot.dxf');m=d.modelspace()
def fingerprint(entity):
    collector=TagCollector(dxfversion=d.dxfversion);entity.export_dxf(collector)
    # ezdxf omits explicit MTEXT default spacing on save. Compare its semantic value.
    tags=[(tag.code,tag.value) for tag in collector.tags if tag.code!=8 and not(entity.dxftype()=='MTEXT' and tag.code in (73,44) and tag.value==1) and not(entity.dxftype()=='LWPOLYLINE' and tag.code==43 and tag.value==0)]
    return hashlib.sha256(repr(tags).encode('utf8')).hexdigest()
original_handles={e.dxf.handle for e in m};before={a['handle']:fingerprint(d.entitydb[a['handle']]) for a in plan['moves']}
def leader_vertices(entity):return [[list(v) for v in line.vertices] for leader in entity.context.leaders for line in leader.lines]
leader_before={a['handle']:leader_vertices(d.entitydb[a['handle']]) for a in plan['leader_updates']}
paragraph=d.entitydb['260DD4'].context.mtext.default_content
for layer in plan['layers']:
    assert layer['name'] not in d.layers
    table=d.layers.new(layer['name'],dxfattribs=dict(color=layer['color'],plot=int(layer['plot'])))
    if layer.get('off'):table.off()
for action in plan['moves']:
    entity=d.entitydb[action['handle']];assert entity.dxf.layer==action['original_layer'];entity.dxf.layer=action['target_layer']
block=d.blocks.new('NSS_TKK_ADDED_WELL_DRAFT')
template=plan['template_well'];cx,cy,cz=template['xyz']
for entity in d.entitydb[template['handle']].virtual_entities():
    clone=entity.copy();clone.translate(-cx,-cy,-cz);clone.dxf.layer='0';block.add_entity(clone)
for well in plan['new_wells']:m.add_blockref(block.name,(*well['xy'],0),dxfattribs=dict(layer=plan['added_well_layer']))
for a in plan['annotations']:
    xyz=a['xyz'];layer=a['layer']
    if a['marker']:m.add_circle(xyz,1.5,dxfattribs=dict(layer=layer))
    if a.get('kind') in ('well_number','span_caption'):
        pos=xyz if a.get('centered') else (xyz[0]+2,xyz[1]+2,0)
        add_label(m,a['text'],pos,layer,rotation=a.get('rotation',0)*180/3.141592653589793,centered=a.get('centered',False))
    else:m.add_text(a['text'],dxfattribs=dict(layer=layer,height=1.5,insert=(xyz[0]+2,xyz[1]+2,0)))
for update in plan['leader_updates']:style_leader(d.entitydb[update['handle']],d.styles.get(STYLE).dxf.handle,update['text'])
d.units=6
target=OUT/'NSS_20_10_26_RESULT_FES.dxf';d.saveas(target)
saved=ezdxf.readfile(target);assert original_handles<={e.dxf.handle for e in saved.modelspace()}
assert all(fingerprint(saved.entitydb[handle])==state for handle,state in before.items())
counts=collections.Counter(e.dxf.layer for e in saved.modelspace());assert counts['NSS_TKK_WELLS_ADDED_PROJECT']==40
assert counts['NSS_TKK_SPAN_LABELS_PROJECT']==228
audit=saved.audit()
labels=[e for e in saved.modelspace().query('MTEXT') if e.dxf.layer in ('NSS_REVIEW_WELL_IDS','NSS_TKK_LABELS_ADDED_PROJECT','NSS_TKK_SPAN_LABELS_PROJECT')]
assert len(labels)==335
for e in labels:assert e.dxf.style==STYLE and e.dxf.char_height==HEIGHT and e.dxf.bg_fill==3 and e.dxf.box_fill_scale==MASK_SCALE
for update in plan['leader_updates']:
    e=saved.entitydb[update['handle']];assert e.context.mtext.default_content==update['text'] and leader_vertices(e)==leader_before[update['handle']]
    assert e.context.char_height==HEIGHT and e.context.mtext.style_handle==saved.styles.get(STYLE).dxf.handle
    assert e.context.mtext.has_bg_fill and e.context.mtext.use_window_bg_color and e.context.mtext.bg_scale_factor==MASK_SCALE
assert saved.entitydb['260DD4'].context.mtext.default_content==paragraph
numbering=json.loads((OUT/'well_numbering.json').read_text(encoding='utf8'));assert set(numbering['numbers'].values())==set(range(1,113))
result=dict(file=target.name,original_model_entities=len(original_handles),model_entities_after=len(saved.modelspace()),all_original_model_handles_preserved=True,selected_entities_preserved_except_layer=len(before),new_wells=40,new_caption_mtexts=228,well_number_mtexts=107,existing_leaders_renumbered=5,font_style=STYLE,height=HEIGHT,canvas_background_scale=MASK_SCALE,leader_vertices_preserved=True,units='meters',audit_errors=len(audit.errors),audit_fixes=len(audit.fixes),project_numbers='1..107',other_callouts='108..112',protected_numbers='1..24',final_numbering_completed=True,native_dwg_created=False,full_background_from_native_dxf_export=True,all_AEC_proxy_semantics_verified=False,sha256=hashlib.sha256(target.read_bytes()).hexdigest())
(OUT/'fes_result_checks.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False,indent=2))
