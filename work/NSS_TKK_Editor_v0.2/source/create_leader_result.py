from pathlib import Path
import json,math,hashlib,collections
import ezdxf
from ezdxf.math import Vec3
from ezdxf.render.mleader import make_mtext
from ezdxf.tools.text_size import estimate_mtext_extents
from shapely.geometry import box
from leader_layout import place_leaders,build_mleader
from fes_format import STYLE,HEIGHT,MASK_SCALE
OUT=Path(__file__).resolve().parents[2]/'output/DWG_NSS_20261020_Review'
OWNER='NSS_TKK_EDITOR_NOTE'

def mark(entity,key,role):
    if OWNER not in entity.doc.appids:entity.doc.appids.new(OWNER)
    entity.set_xdata(OWNER,[(1000,key),(1000,role)])

def main():
    r=json.loads((OUT/'network_review.json').read_text(encoding='utf8'));plan=json.loads((OUT/'edit_plan.json').read_text(encoding='utf8'))
    d=ezdxf.readfile(OUT/'NSS_20_10_26_RESULT_FES.dxf');model=d.modelspace()
    if 'NSS_TKK_CALLOUTS' not in d.layers:d.layers.new('NSS_TKK_CALLOUTS',dxfattribs=dict(color=3))
    all_captions=[a for a in plan['annotations'] if a.get('kind')=='span_caption']
    spans=json.loads((OUT/'span_labels.json').read_text(encoding='utf8'))['spans']
    assert len(all_captions)==2*len(spans)
    valid=[i for i,span in enumerate(spans) if span['start']!=span['end']]
    captions=[all_captions[2*i+j] for i in valid for j in (0,1)];wells=[]
    for well in r['wells']:wells.append(dict(key='well:'+well['handle'],text=well['final_id'],xyz=well['xyz'],layer='NSS_TKK_CALLOUTS'))
    added=sorted(model.query('INSERT[layer=="NSS_TKK_WELLS_ADDED_PROJECT"]'),key=lambda e:e.dxf.handle)
    for well in r['candidate_wells']:
        entity=min(added,key=lambda e:math.dist(tuple(e.dxf.insert)[:2],well['xy']));assert math.dist(tuple(entity.dxf.insert)[:2],well['xy'])<1e-8
        wells.append(dict(key='well:'+entity.dxf.handle,text=well['final_id'],xyz=[*well['xy'],0],layer='NSS_TKK_CALLOUTS'))
    existing=[]
    for update in plan['leader_updates']:
        entity=d.entitydb[update['handle']];vertices=[v for lead in entity.context.leaders for line in lead.lines for v in line.vertices];target=list(vertices[0])
        key='well:'+update['well_handle'] if update['well_handle'] else 'well:REF_EXISTING'
        item=dict(key=key,text=update['text'],xyz=target,layer=entity.dxf.layer,reference=True,original_handle=entity.dxf.handle)
        existing.append(item);wells.append(item)
    layout,checks=place_leaders(wells,r['routes'],captions)
    by_key={item['key']:item for item in layout};handles={item['key']:item['original_handle'] for item in existing}
    for entity in list(model.query('MTEXT')):
        if entity.dxf.layer in ('NSS_REVIEW_WELL_IDS','NSS_TKK_LABELS_ADDED_PROJECT'):model.delete_entity(entity)
    old_caption_entities=list(model.query('MTEXT[layer=="NSS_TKK_SPAN_LABELS_PROJECT"]'))
    for i in range(len(spans)):
        for j in (0,1):
            entity=old_caption_entities[2*i+j]
            if i not in valid:model.delete_entity(entity)
            else:mark(entity,'span:'+entity.dxf.handle,'caption')
    output_handles={}
    for item in layout:
        entity=build_mleader(model,item)
        if item['key'] in handles:
            original=d.entitydb[handles[item['key']]];old_handle=original.dxf.handle
            attrs={k:v for k,v in entity.dxf.all_existing_dxf_attribs().items() if k not in ('handle','owner','layer')}
            original.dxf.update(attrs);original.context=entity.context;original.arrow_heads=entity.arrow_heads;original.block_attribs=entity.block_attribs;original.proxy_graphic=None
            model.delete_entity(entity);entity=original;assert entity.dxf.handle==old_handle
        mark(entity,item['key'],'reference' if item['reference'] else 'well');output_handles[item['key']]=entity.dxf.handle
    if 'NSS_REVIEW_ISSUES' in d.layers:d.layers.get('NSS_REVIEW_ISSUES').off()
    output=OUT/'NSS_20_10_26_RESULT_MLEADER.dxf';d.saveas(output)
    loaded=ezdxf.readfile(output);actual_boxes=[]
    for item in layout:
        entity=loaded.entitydb[output_handles[item['key']]];assert entity.dxftype()=='MULTILEADER'
        assert entity.context.char_height==HEIGHT and entity.context.mtext.bg_scale_factor==MASK_SCALE
        assert entity.context.mtext.has_bg_fill and entity.context.mtext.use_window_bg_color
        assert entity.context.mtext.style_handle==loaded.styles.get(STYLE).dxf.handle
        assert entity.context.mtext.default_content==item['text']
        arrow=entity.context.leaders[0].lines[0].vertices[0];assert arrow.isclose(Vec3(item['target']),abs_tol=1e-8)
        mtext=make_mtext(entity);width,height=estimate_mtext_extents(mtext);pos=mtext.dxf.insert
        actual=box(pos.x-.4,pos.y-height-.4,pos.x+width+.4,pos.y+.4)
        planned=box(*item['box']);assert planned.buffer(.001).contains(actual),(item['key'],list(actual.bounds),item['box'])
        actual_boxes.append(actual)
    audit=loaded.audit();assert not audit.errors and not audit.fixes
    checks.update(well_mleaders=len(layout),interwell_spans=len(valid),spurious_self_spans_removed=len(spans)-len(valid),old_callouts_retained=len(existing),plain_number_mtexts_remaining=len([e for e in loaded.modelspace().query('MTEXT') if e.dxf.layer in ('NSS_REVIEW_WELL_IDS','NSS_TKK_LABELS_ADDED_PROJECT')]),actual_estimated_boxes_within_reserved_boxes=True,audit_errors=len(audit.errors),audit_fixes=len(audit.fixes),native_AutoCAD_visual_verified=False,file=output.name,sha256=hashlib.sha256(output.read_bytes()).hexdigest())
    (OUT/'leader_layout.json').write_text(json.dumps(dict(leaders=layout,checks=checks),ensure_ascii=False,indent=2),encoding='utf8')
    # Fixture for the editor core, using actual saved well handles.
    snapshot_wells=[]
    for item in layout:
        key=item['key'][5:];description=item['text'].split('\\P',1)[1] if '\\P' in item['text'] else None
        snapshot_wells.append(dict(id=key,xyz=item['target'],reference=item['reference'],description=description,previous_number=int(item['text'].split('\\P')[0].split('-')[1])))
    fixture=dict(job_id='fixture',fingerprint='fixture',wells=snapshot_wells,routes=[dict(id=route['handle'],points=route['points'],building_entry=route['handle']=='260F55') for route in r['routes']],protected={key:i+1 for i,key in enumerate(r['numbering']['protected_handles'])})
    (OUT/'editor_fixture.json').write_text(json.dumps(fixture,ensure_ascii=False),encoding='utf8')
    print(json.dumps(checks,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
