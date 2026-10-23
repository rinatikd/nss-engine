"""Build a separate, symbol-based CCTV/security drawing issue from v04."""
from pathlib import Path
from math import cos, sin, radians, pi
import json
import ezdxf
from ezdxf.addons import Importer
from ezdxf import bbox

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'work' / 'CCTV_Source_v04.dxf'
SYMBOLS = ROOT / 'work' / 'Садик СС_из_архива.dxf'
OUT = ROOT / 'work' / 'CCTV_Source_v05.dxf'
LW = 40
doc = ezdxf.readfile(SRC)
symbol_doc = ezdxf.readfile(SYMBOLS)
msp = doc.modelspace()

def add_layer(name, color, ltype='CONTINUOUS'):
    if name not in doc.layers:
        doc.layers.new(name, dxfattribs={'color': color, 'lineweight': LW, 'linetype': ltype})
    else:
        ly=doc.layers.get(name); ly.dxf.color=color; ly.dxf.lineweight=LW; ly.dxf.linetype=ltype

for n,c,lt in [
    ('СВН_Зоны_обзора_фикс',5,'CONTINUOUS'),
    ('СВН_Зоны_обзора_купольные',4,'CONTINUOUS'),
    ('СВН_Зоны_VCA_тепловизоры',1,'CONTINUOUS'),
    ('СВН_Зоны_PTZ_оперативные',6,'DASHED'),
    ('СКУД_Устройства',2,'CONTINUOUS'),
    ('Домофония_Устройства',3,'CONTINUOUS'),
]: add_layer(n,c,lt)

# Import exactly the camera and access-control UGO used by the kindergarten drawing.
src_names={
    'fixed':'камера уличная',
    'dome':'купольная цветная вк',
    'access':'10220 - 2',
}
importer=Importer(symbol_doc,doc)
for name in src_names.values(): importer.import_block(name)
importer.finalize()

# Normalize imported block base points so symbols can be inserted at our metre-based site coordinates.
symbol_scales={}
for kind,name in src_names.items():
    block=doc.blocks.get(name)
    ext=bbox.extents(block,fast=True)
    if not ext.has_data: raise RuntimeError(f'No geometry in source UGO block {name}')
    cx=(ext.extmin.x+ext.extmax.x)/2; cy=(ext.extmin.y+ext.extmax.y)/2
    width=max(ext.extmax.x-ext.extmin.x,ext.extmax.y-ext.extmin.y)
    block.block.dxf.base_point=(cx,cy,0)
    desired=3.4 if kind in ('fixed','dome') else 3.0
    symbol_scales[kind]=desired/width
    for e in block:
        if e.dxf.hasattr('layer'): e.dxf.layer='0'
        if e.dxf.hasattr('color'): e.dxf.color=0  # BYBLOCK
        if e.dxf.hasattr('lineweight'): e.dxf.lineweight=-2  # BYBLOCK

remap={'UGO_SVN_CAMERA':'fixed','UGO_SVN_DOME':'dome','UGO_SVN_PTZ':'dome','UGO_SVN_THERMAL':'fixed'}
counts={}
camera_layer_names={
    'СВН_Камеры_периметр':('fixed',31.0,84.0,'СВН_Зоны_обзора_фикс'),
    'СВН_Камеры_проезды':('fixed',31.0,84.0,'СВН_Зоны_обзора_фикс'),
    'СВН_Камеры_купольные':('dome',26.0,103.0,'СВН_Зоны_обзора_купольные'),
    'СВН_Тепловизоры':('fixed',105.0,42.5,'СВН_Зоны_VCA_тепловизоры'),
}

def fill_sector(x,y,heading,width_deg,reach,layer_name,color):
    half=radians(width_deg/2); base=radians(heading)
    steps=max(8,int(width_deg/4))
    points=[(x,y)]
    for i in range(steps+1):
        a=base-half+2*half*i/steps
        points.append((x+reach*cos(a),y+reach*sin(a)))
    hatch=msp.add_hatch(color=color,dxfattribs={'layer':layer_name,'lineweight':LW})
    hatch.set_solid_fill(color=color)
    hatch.paths.add_polyline_path(points,is_closed=True)
    hatch.transparency=0.78
    outline=msp.add_lwpolyline(points,close=True,dxfattribs={'layer':layer_name,'color':color,'lineweight':LW})
    counts[layer_name]=counts.get(layer_name,0)+1

for e in list(msp.query('INSERT')):
    kind=remap.get(e.dxf.name)
    if kind:
        e.dxf.name=src_names[kind]
        e.dxf.xscale=symbol_scales[kind]
        e.dxf.yscale=symbol_scales[kind]
        e.dxf.zscale=1.0
        e.dxf.lineweight=LW
    params=camera_layer_names.get(e.dxf.layer)
    if params:
        kind,reach,fov,zone_layer=params
        fill_sector(e.dxf.insert.x,e.dxf.insert.y,e.dxf.rotation,fov,reach,zone_layer,doc.layers.get(zone_layer).dxf.color)
    elif e.dxf.layer=='СВН_Камеры_PTZ':
        msp.add_circle(e.dxf.insert, radius=65, dxfattribs={'layer':'СВН_Зоны_PTZ_оперативные','color':6,'lineweight':LW,'linetype':'DASHED'})
        counts['СВН_Зоны_PTZ_оперативные']=counts.get('СВН_Зоны_PTZ_оперативные',0)+1

# Add thermal channel marker to the imported outdoor camera UGO.
for e in list(msp.query('INSERT[layer=="СВН_Тепловизоры"]')):
    t=msp.add_text('T',dxfattribs={'insert':(e.dxf.insert.x-1.7,e.dxf.insert.y-1.1),'height':1.8,'style':'Standard','layer':'СВН_Тепловизоры','lineweight':LW})

def replace_text(layout_name, old, new):
    layout=doc.layouts.get(layout_name); changed=0
    for e in layout:
        if e.dxftype()=='TEXT' and e.dxf.text==old:
            e.dxf.text=new; changed+=1
        elif e.dxftype()=='MTEXT' and old in e.text:
            e.text=e.text.replace(old,new); changed+=1
    return changed

# Update plan assumptions and keep all coordinate-dependent points explicitly provisional.
replace_text('СВН-01_План','Наружное тепловизионное обнаружение: ориентир 38 камер / 19 узлов, шаг около 180 м; проверить модель, оптику и рельеф',
             'DS-2TD2667-15/PY: 38 двухспектральных камер / 19 пар, шаг ~178 м; VCA по человеку 105 м, угол теплового канала 42,5°; сектор показан отдельным слоем.')
replace_text('СВН-01_План','67 фиксированных камер с аналитикой — предварительная раскладка','67 камер DS-2CD2043G2-I, 4 мм; сектор Observe показан до 31 м по DORI (концепция).')
replace_text('СВН-01_План','Внутренние проезды: 21 фиксированная камера; прежний 2D-расчёт показывал 98% полосы','Внутренние проезды: 21 × DS-2CD2043G2-I, 4 мм; зоны 31 м без учёта высоты/препятствий.')
replace_text('СВН-01_План','На исходном плане световые опоры не идентифицированы','Координаты опор не входят в исходный генплан; WordPark использован только как образец трассировки, не как координатная подложка.')
replace_text('СВН-01_План','38 тепловизионных камер · 67 периметральных фиксированных · 21 внутренняя фиксированная','38 тепловизионных · 67 периметральных · 21 на внутренних проездах')
replace_text('СВН-01_План','ИТОГО: 134 камеры без КПП (предварительно; после проверки модели и опор пересчитать)','ИТОГО: 134 физических камеры / 172 видеоканала без КПП; предварительно.')
replace_text('СВН-01_План','Размещение камер показано как принцип зонирования; точные точки на опорах будут нанесены после обследования.','Зоны цветом нанесены отдельными слоями: видимые камеры — DORI Observe; тепловизоры — VCA 105 м. Проверить рельеф, ограждение и опоры.')

# Detailed model selection and platform scope in the equipment schedule.
for old,new in [
 ('Наружная тепловизионная IP-камера, дальность аналитики и объектив подтвердить','Hikvision DS-2TD2667-15/PY, dual-spectrum 640×512 + 4MP'),
 ('19 парных узлов, концепция ~180 м','19 парных узлов, шаг ~178 м; VCA human 105 м'),
 ('Модель не закреплена','Модель выбрана; проверить полевой макет'),
 ('Фиксированная IP-камера аналитики вдоль ограждения','Hikvision DS-2CD2043G2-I, фикс. объектив 4 мм'),
 ('Фиксированная IP-камера внутренних проездов','Hikvision DS-2CD2043G2-I, объектив 4 мм'),
 ('Купольная IP-камера для площадок/беседки','Hikvision DS-2CD2143G2-LI(S), 2.8 мм'),
 ('PTZ IP-камера с автосопровождением','Hikvision DS-2DE7A432IWG1-E, 4 MP, 32×, Auto Tracking 2.0'),
 ('PoE-коммутаторы, шкафы, УЗИП, БП/ИБП','DS-3T1512HP-SI-8P4F; IP65 шкаф; питание/УЗИП'),
 ('Лицензии, сервер/архив, рабочее место','HikCentral Professional 3.1.1: Video + Access Control + Video Intercom'),
 ('Добавить новые камеры и события','172 видеоканала + ресурсы КПП/домофонии по ведомости'),
 ('Камеры КПП и оборудование доступа','DS-K1T673DX + DS-KV9503-WBE1 + DS-K2604T'),
 ('Уже учтено в отдельном блоке','Количество по числу автомобильных/пешеходных проходов'),
 ('Не дублировать','HikCentral licenses and intercom module required'),
]: replace_text('СВН-05_Спецификация',old,new)

# Rework provisional count and storage notes to distinguish physical cameras from video channels.
replace_text('СВН-05_Спецификация',
 'Расчётный ориентир комплекта: 134 камеры без КПП (38 + 67 + 21 + 4 + 4). Это предложение для проверки, а не утверждённая закупочная ведомость. Замена исходных 24 тепловизоров на 38 рекомендована только при подтверждении дальности аналитики выбранной модели и геометрии рубежа.',
 'Концепция без КПП: 134 физических камеры, 172 канала (38 двухспектральных тепловизоров дают 76 потоков). Архив 30 сут при 0,72 Мбит/с/канал: ориентир 40,1 ТБ raw; закладывать ≥50 ТБ полезного RAID-объёма с резервом. Рассчитать заново по профилям кодирования.')
replace_text('СВН-05_Спецификация',
 'Текущая сметная оценка варианта 5а: 333,5 млн ₸ ±30–50% до пересчёта. Из неё исключить новые самостоятельные опоры и пересчитать адаптеры, круглосуточное питание, шкафы, УЗИП и монтаж по фактическому реестру существующих опор.',
 'Узлы на существующих опорах освещения; WordPark использован только как пример прокладки линий. Требуются реестр опор, расчёт нагрузок/ветра, постоянное питание, оптические SFP и проверка бюджета PoE.')

# Put concrete Hikvision access and intercom devices in the gate row without inventing gate quantities.
replace_text('СВН-05_Спецификация','Камеры КПП и оборудование доступа','Hikvision: DS-K1T673DX face terminal; DS-KV9503-WBE1 door station; DS-K2604T 4-door controller')

# Cable journal: WordPark routing is a drafting precedent; route coordinates and lengths remain site-specific.
replace_text('СВН-06_Кабельный_журнал','Топология/запас по паспорту','Контроллер поставщика; сигнал в HCP через API/интегратор или сухие контакты')
replace_text('СВН-06_Кабельный_журнал','Реестр опор и шкафов','Кольцо/магистраль по ТКК и действующей трассе освещения; геометрию WordPark не переносить')
replace_text('СВН-06_Кабельный_журнал','Тип/длина по паспорту','Cat.6 наружный; Ethernet-участок ≤90 м')
replace_text('СВН-06_Кабельный_журнал','Проверить PoE и длину','Узел существующей опоры; PTZ и тепловизор — проверить энергобюджет')

# Add proposed manhole spacing note based on user's 70–100 m guidance; bends/junctions retain access points.
layout=doc.layouts.get('СВН-06_Кабельный_журнал')
for text,x,y,h in [
 ('ТКК-КК',13.5,229,2.1),
 ('Колодцы телефонной канализации: уточнить шаг на прямых участках',61.5,229,2.1),
 ('70–100 м',251.5,229,2.1),
 ('По трассе освещения / ТКК; WordPark — только образец',346.5,229,2.1),
 ('Сохранить колодцы на поворотах, ответвлениях и узлах',466.5,229,2.1),
]: layout.add_text(text,dxfattribs={'insert':(x,y),'height':h,'style':'Standard','layer':'СВН_ЛИСТЫ','lineweight':LW})

# Add a symbol/coverage legend in the plan's existing right-hand legend area.
plan=doc.layouts.get('СВН-01_План')
replace_text('СВН-01_План','СЛОИ И УГО СВН / СО','ЗОНЫ ОБЗОРА И УГО СВН / СО')
replace_text('СВН-01_План','СВН_Тепловизоры — наружная тепловизионная камера','СВН_Зоны_VCA_тепловизоры — 105 м, HFOV 42,5°')
replace_text('СВН-01_План','СВН_Камеры_периметр — фиксированная камера','СВН_Зоны_обзора_фикс — DORI Observe 31 м')
replace_text('СВН-01_План','СВН_Камеры_проезды — камера общей дороги','СВН_Камеры_проезды — DS-2CD2043G2-I / 4 мм')
plan.add_text('УГО камер/СКУД импортированы из Садик СС.dxf; купольный UGO для PTZ применён как обозначение корпуса.',
              dxfattribs={'insert':(860,135),'height':2.2,'style':'Standard','layer':'СВН_ЛИСТЫ','lineweight':LW})

doc.header['$INSUNITS']=4
audit=doc.audit()
if audit.errors: raise RuntimeError(f'DXF audit errors: {len(audit.errors)}')
doc.saveas(OUT)
report={
 'output':str(OUT),'source_symbol_blocks':src_names,'source_symbol_scales':symbol_scales,
 'zone_entities':counts,'physical_camera_count':134,'video_channel_count':172,
 'HCP':'3.1.1','audit_errors':len(audit.errors),'audit_fixes':len(audit.fixes),
 'assumptions':['coverage sectors ignore terrain/obstacles','lighting pole coordinates are not identified','gate counts and exact positions not present','fiber sensor model to be chosen with vendor','WordPark is routing precedent only'],
}
(ROOT/'work'/'cctv_v05_build_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'Saved {OUT.name}; model UGO replaced; coverage sectors {counts}; audit errors {len(audit.errors)}')
