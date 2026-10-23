"""Prepare a traceable review of the 29 native DWG issues, without editing DWG."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point


ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / 'output/NSS_TKK_Editor_v0.2.3'
BASELINE = PACKAGE / 'drawing/NSS_20_10_26_RESULT_NATIVE.dwg'
CONTEXT = ROOT / 'work/NSS_TKK_Editor_v0.2/evidence/engineering29_initial/dxf_context.json'
GEOMETRY = ROOT / 'work/NSS_TKK_Editor_v0.2/evidence/native_full_scenario_v023_release_direct/native_preparation.json'
TRIM_NUMBERS = (2, 3, 9, 19, 21, 22)
REFERENCE_NUMBERS = (26, 27, 28, 29)


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(out):
    import ezdxf

    out.mkdir(parents=True, exist_ok=True)
    snapshot = read(PACKAGE / 'review/snapshot.json')
    issues = read(PACKAGE / 'review/issues.json')['issues']
    baseline_result = read(PACKAGE / 'review/result.json')
    context = read(CONTEXT)
    contexts = {i['n']: i for i in context['issues']}
    wells = {w['id']: w for w in snapshot['wells']}
    routes = {r['id']: r for r in snapshot['routes']}
    doc = ezdxf.readfile(ROOT / 'output/DWG_NSS_20261020_Review/source_snapshot.dxf')
    edits, records = [], []
    for n, issue in enumerate(issues, 1):
        endpoint = next(e for e in issue['endpoints'] if e['kind'] != 'well')
        nearby = contexts[n]
        record = dict(number=n, issue_id=issue['issue_id'], source_ids=issue['source_ids'],
                      code=issue['code'], xy=endpoint['xy'], length_m=issue.get('length_m'),
                      before=issue, context=nearby, view=f'NSS_R{n:02d}')
        if n in TRIM_NUMBERS:
            anchor = next(e for e in issue['endpoints'] if e['kind'] == 'well')
            well_id = anchor['well_id']
            assert not wells[well_id].get('reference')
            handle = issue['routes'][0]
            native_route = routes[handle]
            entity = doc.entitydb[handle]
            assert entity.dxftype() in ('LINE', 'LWPOLYLINE')
            original = native_route['points']
            end_index = min((0, len(original)-1), key=lambda j: math.dist(original[j][:2], endpoint['xy']))
            assert math.dist(original[end_index][:2], endpoint['xy']) < 1e-8
            neighbor = original[1] if end_index == 0 else original[-2]
            a, b = original[end_index], neighbor
            delta = [b[j]-a[j] for j in range(2)]
            fraction = sum((anchor['xy'][j]-a[j])*delta[j] for j in range(2)) / sum(d*d for d in delta)
            assert 0 < fraction < 1
            target = [a[j] + fraction*(b[j]-a[j]) for j in range(3)]
            assert math.dist(target[:2], anchor['xy']) < 1e-8
            circles = [c for c in doc.entitydb[well_id].virtual_entities() if c.dxftype() == 'CIRCLE']
            assert len(circles) == 1
            radius = circles[0].dxf.radius
            center = wells[well_id]['xyz']
            assert math.dist(a[:2], center[:2]) < radius
            assert max(abs(a[2]-center[2]), abs(target[2]-center[2])) < 1e-6
            removed = math.dist(a, target)
            assert .005 < removed < .2 and removed < radius
            if entity.dxftype() == 'LWPOLYLINE':
                segment = 0 if end_index == 0 else len(entity)-2
                assert abs(entity.get_points('b')[segment][0]) < 1e-12
                assert not entity.closed and abs(entity.dxf.elevation) < 1e-9
            edit = dict(issue_number=n, issue_id=issue['issue_id'], handle=handle,
                        entity_type=entity.dxftype(), endpoint='start' if end_index == 0 else 'end',
                        before_xyz=a, after_xyz=target, well_handle=well_id,
                        well_number=baseline_result['numbering'][well_id], well_xyz=center,
                        measured_radius_m=radius, removed_m=removed)
            edits.append(edit)
            record.update(status='FIXED_ON_COPY', title='Короткий остаток внутри символа колодца',
                          priority='Выполнено на копии', edit=edit,
                          finding=f"Остаток {removed:.6f} м находится внутри круга КК-{edit['well_number']} радиусом {radius:.6f} м. Высоты совпадают.",
                          action='Обрезан только крайний прямой сегмент до уже используемой расчётом проекции центра. Колодец, остальные вершины и параметры кривой сохранены.')
        elif n in REFERENCE_NUMBERS:
            existing = next(e for e in nearby['nearby_geometry'] if e['handle'] == '260E1C')
            assert existing['distance_m'] < 1e-7
            record.update(status='EXPLAINED_REFERENCE', title='Колодец на ранее запроектированной сети',
                          priority='Контекст подтверждён',
                          finding='Центр лежит на полилинии 260E1C слоя «НСС проектир» с точностью лучше 0,000001 м. Исходная выноска относит её к ранее запроектированной сети.',
                          action='Сохранить как опорный объект вне объёма новой трассы. Не переносить в проектный слой: это добавит чужую сеть и изменит объём работ. Предупреждение плагина остаётся видимым.')
        elif n == 1:
            r = routes['260E2A']
            dz = max(p[2] for p in r['points'])-min(p[2] for p in r['points'])
            record.update(status='REQUIRES_DECISION', title='Малый остаток у опорного КК-111 и перепад Z', priority='Проверить высоты',
                          finding=f"Остаток {issue['length_m']:.6f} м в плане; у исходной линии 260E2A перепад Z={dz:.6f} м. Это исходные координаты DWG.",
                          action='Проверить назначение Z в исходном проекте. Для плана применяется XY; геометрию и высоты автоматически не менять.')
        elif n == 5:
            record.update(status='REQUIRES_DECISION', title='Выход линии за КК-27', priority='Проверить узел',
                          finding=f"Линия 260E39 продолжается за проекцией КК-27 на {issue['length_m']:.6f} м; остаток больше радиуса символа колодца.",
                          action='Уточнить: продолжение сети, отдельный отвод или лишний конец линии. При подтверждении лишнего конца обрезать до проекции КК-27; сейчас правка не применена.')
        elif n == 17:
            distance = endpoint['nearby_wells'][0]['distance_m']
            record.update(status='REQUIRES_DECISION', title='Разрыв между линией и КК-18', priority='Первая проверка соединения',
                          finding=f"Конец 260F4C не доходит до центра КК-18 на {distance:.6f} м; это на {distance-1.1:.6f} м больше принятого допуска распознавания 1,1 м.",
                          action='Подтвердить, должен ли этот отвод подключаться к КК-18. В отчёте показан пунктирный вариант соединения. Увеличение общего допуска не применялось.')
        else:
            buildings = [e for e in nearby['nearby_geometry'] if any(k in e['layer'] for k in ('Контур', 'Позиции'))]
            note = ''
            if buildings:
                b = buildings[0]
                note = f" Ближайший контур/позиция генплана {b['handle']}: {b['distance_m']:.3f} м от конца; этого недостаточно для подтверждения ввода."
            record.update(status='REQUIRES_DECISION', title='Открытый конец отвода', priority='Уточнить оконечное устройство',
                          finding=f"Цепочка длиной {issue['length_m']:.6f} м имеет конец без распознанного колодца или явно заданного ввода." + note,
                          action='Сверить со схемой связи или планом ввода: здание/оборудование, резервный конец, соединение или недостающий колодец. Только после этого задать тип оконечного узла; новые колодцы автоматически не добавлялись.')
        records.append(record)
    # Nested architectural blocks supply candidates, never automatic terminal nodes.
    block_path=out/'BLOCK_CONTEXT.json'
    if block_path.exists():
        block_data=read(block_path)
        assert not block_data['errors']
        by_number={r['number']:r for r in block_data['records']}
        for record in records:
            nested=by_number.get(record['number'])
            if not nested:continue
            architecture=[g for g in nested['geometry'] if g['layer'].startswith(('К_Контур','К_Отмостка','К_Крыльца'))]
            # Preserve only architectural geometry in the map; trees/axes/terrain
            # cannot establish a building entry and would obscure the endpoint.
            record['context']['block_geometry']=architecture
            if record['number'] in (1,5,17) or not architecture:continue
            candidate=architecture[0]
            record['building_candidate']={k:candidate[k] for k in ('owner','block','path','layer','distance_m')}
            d=candidate['distance_m']
            record['title']='Открытый конец у здания/сооружения'
            record['finding'] += f" В раскрытом блоке «{candidate['block']}» ({candidate['owner']}) ближайшая архитектурная линия слоя «{candidate['layer']}» находится в {d:.6f} м."
            record['action']=f"Сверить предполагаемый ввод в «{candidate['block']}» со схемой связи и точкой ввода. После подтверждения назначить конец типом «ввод/оборудование»; совпадение с контуром само по себе не использовано как подтверждение связи."
    assert len(records) == 29 and len(edits) == 6
    assert len({e['handle'] for e in edits}) == 6
    plan = dict(schema_version=1, kind='NSS_ENGINEERING_REVIEW_DRAFT', baseline_sha256=digest(BASELINE),
                baseline_dwg=str(BASELINE), original_geometry_report=str(GEOMETRY),
                expected_before=dict(wells=112, spans=109, warnings=29),
                expected_after=dict(wells=112, spans=109, warnings=23),
                edits=edits,
                review=[dict(number=r['number'], status=r['status'], xy=r['xy'],
                             bounds=r['before']['bounds'], view=r['view'],
                             label=f"R{r['number']:02d} " + {'FIXED_ON_COPY':'FIXED', 'EXPLAINED_REFERENCE':'REFERENCE', 'REQUIRES_DECISION':'REVIEW'}[r['status']]) for r in records])
    (out/'engineering_plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf8')
    audit = dict(baseline_dwg=str(BASELINE), baseline_sha256=plan['baseline_sha256'],
                 dxf_context_sha256=digest(ROOT/'output/DWG_NSS_20261020_Review/source_snapshot.dxf'),
                 plugin_sha256=digest(PACKAGE/'plugin/NssTkkEditor.V002.dll'),
                 decisions=dict(fixed_on_copy=6, explained_reference=4, requires_decision=19),
                 records=records)
    (out/'engineering_audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf8')
    proposals=[dict(number=r['number'],source_ids=r['source_ids'],xy=r['xy'],candidate=r['building_candidate'],applied=False,
                    required_confirmation='Building/equipment identity, intended telecom entry and endpoint position on the design schematic')
               for r in records if r.get('building_candidate')]
    (out/'PROPOSED_BUILDING_ENTRIES.json').write_text(json.dumps(proposals,ensure_ascii=False,indent=2),encoding='utf8')
    write_markdown(out, audit)
    write_html(out, audit, snapshot)
    print(json.dumps(dict(plan=str(out/'engineering_plan.json'), records=len(records), trim_lengths_m=[round(e['removed_m'],6) for e in edits]), ensure_ascii=True))


def write_markdown(out, audit):
    lines = ['# Разбор 29 замечаний NSS', '',
             'Это инженерная рабочая копия. 6 коротких остатков исправлены на копии; 4 замечания объясняются ранее запроектированной сетью; 19 мест требуют проектного решения. Выполнение правок подтверждается отдельным файлом проверки.', '',
             'Плагин v0.2.3 сохранён: после шести правок остаются 23 предупреждения, включая 4 опорных колодца вне новой трассы. Контекстные пояснения не скрывают предупреждения.', '',
             'Исходный DWG и опубликованные комплекты не изменяются. Сеть в DWG не восстанавливается из DXF; DXF используется только для анализа исходных объектов.', '',
             'В DWG: именованные виды `NSS_R01` … `NSS_R29`. Например: `_.-VIEW`, затем `_Restore`, затем `NSS_R17`. Номера R относятся к исходным 29 замечаниям; после пересчёта номера списка плагина могут измениться. Слой `NSS_TKK_ENGINEERING_REVIEW` содержит непечатаемые метки: зелёные — правки на копии, голубые — опорная сеть, оранжевые — проверка.', '',
             'Начать с R17: разрыв у КК-18; затем R05: выход за КК-27; R01: исходные высоты. Остальные открытые концы сверить со схемой связи/планом вводов.', '',
             '| R | Исходные объекты | Статус | Проверка |', '| --- | --- | --- | --- |']
    for r in audit['records']:
        lines.append(f"| R{r['number']:02d} | {', '.join(r['source_ids'])} | {r['priority']} | {r['title']} |")
    for r in audit['records']:
        x,y=r['xy']
        lines += ['', f"## R{r['number']:02d}. {r['title']}", '',
                  f"Вид `{r['view']}`. Issue ID `{r['issue_id']}`. Объекты: {', '.join('`'+s+'`' for s in r['source_ids'])}.",
                  f"Точка проверки WCS: X={x:.6f}, Y={y:.6f} м.", '', r['finding'], '', r['action']]
        if r.get('edit'):
            e=r['edit']
            lines += ['', f"Изменён {e['endpoint']} объекта `{e['handle']}` ({e['entity_type']}); удалено {e['removed_m']:.6f} м. Конец до: `{e['before_xyz']}`; после: `{e['after_xyz']}`."]
    (out/'ENGINEERING_REVIEW_RU.md').write_text('\n'.join(lines)+'\n', encoding='utf8')


def svg(record, snapshot):
    from ezdxf.tools.text import plain_mtext

    xy=record['xy']; geometry=record['context']['nearby_geometry']
    # The source context is local to the unresolved end, so keep a consistent 32 m window.
    half=16
    x0,y0=xy[0]-half,xy[1]-half; size=half*2
    def p(point):return (point[0]-x0, y0+size-point[1])
    chunks=[f'<svg viewBox="0 0 {size} {size}" role="img" aria-label="План R{record["number"]:02d}">', '<rect width="100%" height="100%" fill="#fff"/>']
    for e in record['context'].get('block_geometry',[]):
        points=' '.join(f'{a:.4f},{b:.4f}' for a,b in map(p,e['points']))
        title=html.escape(f"Блок {e['owner']} · {e['block']} · {e['layer']}")
        chunks.append(f'<polyline points="{points}" stroke="#6b7783" stroke-width=".09" fill="none"><title>{title}</title></polyline>')
    for e in reversed(geometry):
        if e['type']=='CIRCLE':continue
        project=e['handle'] in {r['id'] for r in snapshot['routes']}
        reference=e['handle'] in ('260E1B','260E1C')
        focus=e['handle'] in record['source_ids']
        color='#e0522c' if focus else '#305a9e' if project else '#22a5ac' if reference else '#b7bdc4'
        width=.21 if focus else .13 if project or reference else .055
        points=' '.join(f'{a:.4f},{b:.4f}' for a,b in map(p,e['points']))
        title=html.escape(f"{e['handle']} · {e['layer']}")
        chunks.append(f'<polyline points="{points}" stroke="{color}" stroke-width="{width}" fill="none"><title>{title}</title></polyline>')
    for w in snapshot['wells']:
        x,y=p(w['xyz'])
        if not 0<=x<=size or not 0<=y<=size:continue
        number = next((e.get('well_number') for e in record['before']['endpoints'] if e.get('well_id')==w['id']),None)
        number = number or next((q['number'] for e in record['before']['endpoints'] for q in e.get('nearby_wells',[]) if q['id']==w['id']),None)
        chunks.append(f'<circle cx="{x}" cy="{y}" r=".315" fill="#fff" stroke="#187c49" stroke-width=".12"/>')
        if number:chunks.append(f'<text x="{x+.8}" y="{y-.8}" font-size="1.2" fill="#156e42">КК-{number}</text>')
    for t in record['context']['nearby_text']:
        if not any(k in t['layer'] for k in ('телефонная','Позиции','оформление')):continue
        x,y=p(t['xyz'])
        if 0<x<size and 0<y<size:
            text=html.escape(plain_mtext(t['text']).replace('\n',' / ')[:45])
            chunks.append(f'<text x="{x}" y="{y}" font-size=".85" fill="#646d75"><title>{html.escape(t["handle"])}</title>{text}</text>')
    if record['number']==17:
        q=record['before']['endpoints'][-1]['nearby_wells'][0]['xy']
        a,b=p(xy),p(q)
        chunks.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="#bb2525" stroke-width=".18" stroke-dasharray=".5 .4"/>')
    x,y=p(xy)
    chunks += [f'<circle cx="{x}" cy="{y}" r="1.2" fill="none" stroke="#c22" stroke-width=".15"/>',
               f'<text x="{x+1.6}" y="{y+1.6}" font-size="1.4" fill="#a11">R{record["number"]:02d}</text>',
               f'<rect x="1" y="{size-6}" width="29" height="5" fill="#fff" opacity=".92"/><path d="M2 {size-3}h5" stroke="#222" stroke-width=".12"/><text x="2" y="{size-4}" font-size="1">5 м · север ↑ · WCS XY</text></svg>']
    return ''.join(chunks)


def write_html(out, audit, snapshot):
    cards=[]
    for r in audit['records']:
        color={'FIXED_ON_COPY':'fixed','EXPLAINED_REFERENCE':'reference','REQUIRES_DECISION':'review'}[r['status']]
        cards.append(f'''<article id="R{r['number']:02d}" class="{color}"><h2>R{r['number']:02d}. {html.escape(r['title'])}</h2>
<p class="state">{html.escape(r['priority'])}</p>{svg(r,snapshot)}
<p>{html.escape(r['finding'])}</p><p>{html.escape(r['action'])}</p>
<p class="meta">Вид DWG: <code>{r['view']}</code> · Handles: <code>{', '.join(r['source_ids'])}</code><br>X={r['xy'][0]:.6f}, Y={r['xy'][1]:.6f} м<br>{r['issue_id']}</p></article>''')
    links=' '.join(f'<a href="#R{n:02d}">R{n:02d}</a>' for n in range(1,30))
    content='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NSS — разбор 29 замечаний</title>
<style>body{font:16px/1.5 Segoe UI,Arial,sans-serif;margin:0;background:#f2f4f7;color:#202a35}header{padding:28px;max-width:1200px;margin:auto}h1{font-size:28px}nav a{display:inline-block;padding:6px;color:#174b87}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:20px;padding:0 24px 32px;max-width:1600px;margin:auto}article{background:white;padding:20px;border-top:5px solid #dc8622;scroll-margin:12px;box-shadow:0 2px 9px #19283b12}article.fixed{border-color:#29975c}article.reference{border-color:#299daf}h2{font-size:20px;margin:0}.state{color:#536477;font-weight:600}svg{width:100%;height:auto;border:1px solid #d6dce3}svg text{font-family:Arial,sans-serif}.meta{font-size:13px;color:#596775;word-break:break-word}code{background:#eef2f5;padding:2px 4px}button{padding:8px 12px;margin:4px;border:1px solid #bac6d4;border-radius:4px;background:white;cursor:pointer}.hidden{display:none}@media(max-width:500px){main{display:block;padding:10px}article{margin-bottom:16px}header{padding:16px}}@media print{main{display:block}article{break-inside:avoid;box-shadow:none;margin-bottom:20px}nav,button{display:none}}</style>
<header><h1>Разбор 29 замечаний NSS</h1><p>6 коротких остатков исправлены на отдельной копии DWG. 4 замечания объясняются ранее запроектированной сетью. 19 мест требуют проектного решения. Факт выполнения и сохранения проверяется в <code>VERIFICATION.json</code>.</p>
<p>Исходная сеть: синие линии — новая трасса, бирюзовые — ранее запроектированная, серые — контекст генплана, оранжевые — объект замечания, красная окружность — место проверки. Серые подписи взяты из исходника; зелёные КК — номера текущего расчёта. Показан исходный план XY. Толщина линий и текст приведены для просмотра; это не печатный лист проекта.</p>
<p>Начать с <a href="#R17">R17 — разрыв у КК-18</a>, <a href="#R05">R05 — конец за КК-27</a> и <a href="#R01">R01 — высоты</a>. Плагин сохраняет все неустранённые предупреждения: после шести правок их остаётся 23.</p>
<div><button onclick="filter('all')">Все 29</button><button onclick="filter('review')">Требуют решения: 19</button><button onclick="filter('fixed')">Правки: 6</button><button onclick="filter('reference')">Опорная сеть: 4</button></div><nav>'''+links+'</nav></header><main>'+''.join(cards)+'''</main><script>function filter(kind){document.querySelectorAll('article').forEach(e=>e.classList.toggle('hidden',kind!=='all'&&!e.classList.contains(kind)))}</script></html>'''
    (out/'REVIEW_29.html').write_text(content,encoding='utf8')


def verify(out, native, reopened):
    from ezdxf.lldxf.tagwriter import TagCollector
    import ezdxf

    plan=read(out/'engineering_plan.json')
    evidence=read(native/'engineering_summary.json')
    smoke=read(native/'runner_summary.json')
    reopen=read(reopened/'runner_summary.json')
    assert evidence['success'] and smoke['success'] and reopen['success']
    assert evidence['plan_sha256']==digest(out/'engineering_plan.json')
    assert read(reopened/'engineering_reopened.json')['success']
    before=read(native/'engineering_snapshot_before.json')
    after=read(native/'snapshot.json')
    rb=read(PACKAGE/'review/result.json')
    ra=read(native/'result.json')
    rr=read(reopened/'result.json')
    assert before['wells']==after['wells'] and before['protected']==after['protected']
    b={r['id']:r for r in before['routes']};a={r['id']:r for r in after['routes']}
    assert b.keys()==a.keys()
    changed={key for key in b if b[key]!=a[key]}
    assert changed=={e['handle'] for e in plan['edits']}
    assert ra['numbering']==rb['numbering']==rr['numbering']
    assert len(ra['spans'])==len(rr['spans'])==109
    for left,right in zip(rb['spans'],ra['spans']):
        assert left['start']==right['start'] and left['end']==right['end']
        assert abs(left['length_m']-right['length_m'])<1e-7
    assert ra['spans']==rr['spans']
    assert len(ra['warnings'])==len(rr['warnings'])==23
    expected={e['issue_id'] for e in plan['edits']}
    # Other issue bounds/IDs may include full route bounds, so compare actual unresolved ends too.
    remaining_ends=lambda result:sorted((i['code'], tuple(i['source_ids']), tuple(round(x,6) for e in i.get('endpoints',[]) if e['kind']!='well' for x in e['xy'])) for i in result['warnings'])
    expected_remaining=dict(rb,warnings=[i for i in rb['warnings'] if i['issue_id'] not in expected])
    assert remaining_ends(ra)==remaining_ends(expected_remaining)==remaining_ends(rr)
    old=ezdxf.readfile(native/'engineering_before.dxf')
    new=ezdxf.readfile(native/'engineering_after.dxf')
    original={e.dxf.handle:e for e in old.modelspace()}
    current={e.dxf.handle:e for e in new.modelspace()}
    assert original.keys()<=current.keys()
    def comparable(entity):
        # AcDbEntity proxy graphics are a rendered cache, including font buffers.
        # DxfOut also regenerates an ACAD_TABLE roundtrip dictionary's handles.
        # Compare that dictionary's actual Xrecord data instead of its temporary ID.
        roundtrip=None
        if entity.dxftype()=='ACAD_TABLE' and entity.has_extension_dict:
            dictionary=entity.get_extension_dict().dictionary
            assert set(dictionary.keys())=={'ACAD_XREC_ROUNDTRIP'}
            record=dictionary['ACAD_XREC_ROUNDTRIP']
            roundtrip=tuple(record.tags)
        subclass='ROOT'; result=[]; xdict=False
        for tag in TagCollector.dxftags(entity):
            if tag.code==100:subclass=tag.value
            if tag.code==102 and tag.value=='{ACAD_XDICTIONARY':xdict=True
            elif tag.code==102 and tag.value=='}':xdict=False
            if subclass=='AcDbEntity' and tag.code in (92,160,310):continue
            if subclass=='ROOT' and xdict and tag.code==360 and roundtrip is not None:
                result.append((360,roundtrip))
            else:result.append(tag)
        return result
    changed_entities=[]; cache_only=[]
    for key,entity in original.items():
        if comparable(entity)!=comparable(current[key]):changed_entities.append(key)
        elif TagCollector.dxftags(entity)!=TagCollector.dxftags(current[key]):cache_only.append(key)
    assert set(changed_entities)==changed, changed_entities
    assert set(evidence['source_entities_modified'])==changed
    assert evidence['native_tables_unchanged']==2
    assert digest(BASELINE)==plan['baseline_sha256']
    assert digest(ROOT/'work/DWG_20261020_Review/source_original.dwg')==read(GEOMETRY)['source_sha256']
    assert digest(ROOT/'output/NSS_TKK_Editor_v0.2.3.zip')=='f3b973b15c05c34d12310961e180295b31b6c8eefb32101a29eebfa8a92ac7fb'
    checks=dict(success=True, native=evidence, native_smoke=smoke, reopened_smoke=reopen,
                baseline_sha256=plan['baseline_sha256'], original_modelspace_entities=len(original),
                unchanged_original_modelspace_entities=len(original)-len(changed),
                changed_source_handles=sorted(changed_entities), added_review_entities=len(current)-len(original),
                wells_before_after=[112,112], spans_before_after=[109,109], warnings_before_after=[29,23],
                all_numbers_unchanged=True, all_109_span_lengths_unchanged_within_m=1e-7,
                remaining_issue_locations_unchanged=True,
                geometry_comparison='DXF tags of every original modelspace entity, excluding AcDbEntity proxy graphics; table roundtrip Xrecord data compared independently of regenerated dictionary handles',
                proxy_cache_only_differences=len(cache_only), native_table_content_and_geometry_unchanged=2,
                source_original_sha256=digest(ROOT/'work/DWG_20261020_Review/source_original.dwg'),
                baseline_release_zip_sha256=digest(ROOT/'output/NSS_TKK_Editor_v0.2.3.zip'))
    (out/'VERIFICATION.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in checks.items() if k not in ('native','native_smoke','reopened_smoke')},ensure_ascii=True,indent=2))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--verify-native',type=Path)
    parser.add_argument('--verify-reopened',type=Path)
    args=parser.parse_args()
    if args.verify_native:
        verify(args.out.resolve(),args.verify_native.resolve(),args.verify_reopened.resolve())
    else:prepare(args.out.resolve())


if __name__=='__main__':main()
