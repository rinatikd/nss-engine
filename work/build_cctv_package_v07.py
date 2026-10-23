"""Apply the fence-only CCTV revision to the verified v06 DXF."""
from pathlib import Path
import ezdxf, math, re, json

ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'work'/'CCTV_Source_v06.dxf'
OUT=ROOT/'work'/'CCTV_Source_v07.dxf'
REPORT=ROOT/'work'/'cctv_v07_build_report.json'
doc=ezdxf.readfile(SRC); m=doc.modelspace(); LW=40

def ensure_layer(name,color,linetype='CONTINUOUS'):
    if name not in doc.layers:
        doc.layers.new(name,dxfattribs={'color':color,'lineweight':LW,'linetype':linetype})
    else:
        l=doc.layers.get(name); l.dxf.color=color; l.dxf.lineweight=LW; l.dxf.linetype=linetype

for name,color,lt in [
 ('СВН_Зоны_обзора_фикс',5,'CONTINUOUS'),
 ('СВН_Зоны_VCA_тепловизоры',1,'CONTINUOUS'),
 ('СВН_Опоры_освещения',3,'CONTINUOUS'),
 ('СВН_Кронштейны_тепловизоров',6,'CONTINUOUS'),
 ('СВН_Оптика_кольцевая_магистраль',4,'CONTINUOUS'),
 ('СВН_Труба_ПНД_к_шкафам',2,'DASHED'),
]: ensure_layer(name,color,lt)

fence_layer='СО_ВОЛС_ограждение'
fences=[e for e in m.query('LWPOLYLINE') if e.dxf.layer==fence_layer and e.closed]
if len(fences)!=1: raise RuntimeError(f'Ожидалась одна замкнутая линия ограждения: {len(fences)}')
fence=fences[0]; pts=[(p[0],p[1]) for p in fence.get_points('xy')]
segs=[]; perimeter=0.0
for a,b in zip(pts,pts[1:]+pts[:1]):
    dist=math.hypot(b[0]-a[0],b[1]-a[1])
    if dist>1e-8: segs.append((perimeter,dist,a,b)); perimeter+=dist
area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(pts,pts[1:]+pts[:1]))/2
inward=1 if area>0 else -1

def at_s(s):
    s%=perimeter
    for start,dist,a,b in segs:
        if start<=s<start+dist:
            t=(s-start)/dist
            return (a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]),math.degrees(math.atan2(b[1]-a[1],b[0]-a[0])))
    start,dist,a,b=segs[-1]
    return (b[0],b[1],math.degrees(math.atan2(b[1]-a[1],b[0]-a[0])))

def project(x,y):
    best=(float('inf'),0.0)
    for start,dist,a,b in segs:
        dx=b[0]-a[0];dy=b[1]-a[1]
        t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/(dist*dist)))
        px=a[0]+t*dx;py=a[1]+t*dy;d=math.hypot(px-x,py-y)
        if d<best[0]: best=(d,start+t*dist)
    return best[1]

def inward_xy(x,y,angle,offset):
    a=math.radians(angle+inward*90)
    return x+offset*math.cos(a),y+offset*math.sin(a)

def id_num(text):
    mt=re.search(r'-(\d+)$',text or '')
    return int(mt.group(1)) if mt else -1

def inserts_and_labels(layer,prefix):
    ins=[e for e in m.query('INSERT') if e.dxf.layer==layer]
    texts=[e for e in m.query('TEXT') if e.dxf.layer==layer and e.dxf.text.startswith(prefix)]
    pairs=[]; used=set()
    for i in ins:
        avail=[t for t in texts if t.dxf.handle not in used]
        if not avail: break
        t=min(avail,key=lambda q:math.hypot(q.dxf.insert.x-i.dxf.insert.x,q.dxf.insert.y-i.dxf.insert.y))
        used.add(t.dxf.handle); pairs.append((id_num(t.dxf.text),i,t))
    return sorted(pairs,key=lambda z:z[0])

def delete_entities(entities):
    for e in list(entities): m.delete_entity(e)

def set_camera(i,t,x,y,ang,new_label,offset=5.0):
    i.dxf.insert=(x,y,0); i.dxf.rotation=ang%360
    norm=math.radians(ang+inward*90)
    t.dxf.insert=(x+offset*math.cos(norm),y+offset*math.sin(norm),0)
    t.dxf.text=new_label

# Remove all old generated sector graphics and support/branch symbols before rebuilding.
generated={'СВН_Зоны_обзора_фикс','СВН_Зоны_обзора_купольные','СВН_Зоны_VCA_тепловизоры','СВН_Зоны_PTZ_патруль_360','СВН_Зоны_PTZ_оперативные','СВН_Кронштейны_тепловизоров','СВН_Оптика_кольцевая_магистраль'}
for e in list(m):
    if e.dxf.layer in generated or e.dxf.layer=='СВН_Опоры_освещения': m.delete_entity(e)
for e in list(m):
    if e.dxf.layer=='СВН_Труба_ПНД_к_шкафам': m.delete_entity(e)

# Fixed VН cameras only remain on the perimeter. Target a 74.0 m spacing against 80 m DORI Detect.
fixed_layer='СВН_Камеры_периметр'
fixed=inserts_and_labels(fixed_layer,'КП-08-')
if len(fixed)!=57: raise RuntimeError(f'Ожидалось 57 v06 fixed perimeter cameras, получено {len(fixed)}')
first_s=project(fixed[0][1].dxf.insert.x,fixed[0][1].dxf.insert.y)
fixed_count=45; fixed_spacing=perimeter/fixed_count; fixed_positions=[]
for j,(_,ins,txt) in enumerate(fixed):
    if j>=fixed_count:
        m.delete_entity(ins);m.delete_entity(txt);continue
    x,y,ang=at_s(first_s+j*fixed_spacing+0.01)
    x,y=inward_xy(x,y,ang,4.0)
    set_camera(ins,txt,x,y,ang,f'ВН-08-{j+1:02d}')
    fixed_positions.append((j+1,x,y,ang))

# Remove internal-road, plaza dome, and PTZ cameras for this fence-only phase.
for layer in ('СВН_Камеры_проезды','СВН_Камеры_купольные','СВН_Камеры_PTZ'):
    delete_entities(m.query(f'INSERT[layer=="{layer}"]'))
    delete_entities(m.query(f'TEXT[layer=="{layer}"]'))

# 17 back-to-back thermal stations on fence brackets. Each sensor covers 105 m along the fence;
# opposing directions give 210 m total longitudinal reach versus ~196 m station spacing.
thermal_layer='СВН_Тепловизоры'; thermals=inserts_and_labels(thermal_layer,'ТВ-08-')
if len(thermals)!=34: raise RuntimeError(f'Ожидалось 34 тепловизора, получено {len(thermals)}')
therm_start=project(thermals[0][1].dxf.insert.x,thermals[0][1].dxf.insert.y)
station_count=17; station_spacing=perimeter/station_count; thermal_positions=[]; brackets=[]
for number,ins,txt in thermals:
    station=(number-1)//2; odd=(number%2)==1
    x0,y0,ang=at_s(therm_start+station*station_spacing+0.02)
    # Two compact, opposed devices share one bracket line; the small along-fence offset keeps UGO legible.
    normal=math.radians(ang+inward*90); tangent=math.radians(ang)
    side=0.55 if odd else -0.55; along=0.65 if odd else -0.65
    x=x0+0.7*math.cos(normal)+along*math.cos(tangent)+side*math.cos(normal)
    y=y0+0.7*math.sin(normal)+along*math.sin(tangent)+side*math.sin(normal)
    aim=ang if odd else ang+180
    ins.dxf.insert=(x,y,0);ins.dxf.rotation=aim%360
    txt.dxf.insert=(x+2.2*math.cos(normal),y+2.2*math.sin(normal),0)
    brackets.append((x0,y0,x,y))
    thermal_positions.append({'id':txt.dxf.text,'station':station+1,'xy':[x,y],'rotation':aim%360})

# Keep 11 outdoor cabinets at camera poles. Each is balanced for no more than 8 PoE devices,
# including adjacent fixed cameras and nearby thermal sensors.
cab_layer='СВН_Шкафы_коммутационные'; cabs=inserts_and_labels(cab_layer,'ШК-08-')
if len(cabs)!=13: raise RuntimeError(f'Ожидалось 13 шкафов из v06, получено {len(cabs)}')
cab_by_old=sorted(cabs,key=lambda z:z[0])
cabinet_positions=[]
cab_anchors=[1,5,9,13,17,21,25,29,33,37,41]
fixed_groups=[]
for idx,(_,ins,txt) in enumerate(cab_by_old):
    if idx>=len(cab_anchors):
        m.delete_entity(ins);m.delete_entity(txt);continue
    anchor=cab_anchors[idx]; _,cx,cy,ca=fixed_positions[anchor-1]
    norm=math.radians(ca+inward*90)
    # Graphic offset separates the cabinet UGO while preserving the same physical pole location.
    ox,oy=cx+1.6*math.cos(norm),cy+1.6*math.sin(norm)
    ins.dxf.insert=(ox,oy,0);ins.dxf.rotation=ca%360;txt.dxf.text=f'ШК-08-{idx+1:02d}'
    txt.dxf.insert=(ox+3.6*math.cos(norm),oy+3.6*math.sin(norm),0)
    group_end=cab_anchors[idx+1]-1 if idx+1<len(cab_anchors) else 45
    fixed_group=[f'ВН-08-{n:02d}' for n in range(anchor,group_end+1)]
    fixed_groups.append((first_s+(anchor-1)*fixed_spacing,fixed_group))
    cabinet_positions.append({'id':txt.dxf.text,'anchor_camera':f'ВН-08-{anchor:02d}','xy':[ox,oy], 'camera_group':fixed_group,'thermal_group':[]})

# Balance all 34 thermal PoE devices into the nearest cabinet group without exceeding 8 ports.
def arc_distance(s1,s2):
    d=abs((s1-s2)%perimeter);return min(d,perimeter-d)
cab_loads=[len(c['camera_group']) for c in cabinet_positions]
for th in sorted(thermal_positions,key=lambda q:(q['station'],id_num(q['id']))):
    th_s=(therm_start+(th['station']-1)*station_spacing)%perimeter
    candidates=sorted(range(len(cabinet_positions)),key=lambda j:arc_distance(th_s,fixed_groups[j][0]))
    target=next((j for j in candidates if cab_loads[j]<8),None)
    if target is None: raise RuntimeError('Недостаточно свободных PoE портов для тепловизоров')
    cabinet_positions[target]['thermal_group'].append(th['id']);cab_loads[target]+=1
if max(cab_loads)>8 or sum(cab_loads)!=79: raise RuntimeError(f'Проверка нагрузки шкафов не пройдена: {cab_loads}')

# Lighting-support symbols denote the required existing host points; positions must be snapped to the as-built pole register.
for number,x,y,ang in fixed_positions:
    m.add_circle((x,y),2.1,dxfattribs={'layer':'СВН_Опоры_освещения','color':3,'lineweight':LW})
    m.add_line((x-1.4,y),(x+1.4,y),dxfattribs={'layer':'СВН_Опоры_освещения','color':3,'lineweight':LW})
    m.add_line((x,y-1.4),(x,y+1.4),dxfattribs={'layer':'СВН_Опоры_освещения','color':3,'lineweight':LW})
    m.add_text(f'ОС-08-{number:02d}',dxfattribs={'insert':(x+2.4,y+2.4),'height':1.35,'style':'Standard','layer':'СВН_Опоры_освещения','lineweight':LW})

# Fence bracket symbols for the paired thermal units.
for x0,y0,x,y in brackets:
    m.add_line((x0,y0),(x,y),dxfattribs={'layer':'СВН_Кронштейны_тепловизоров','color':6,'lineweight':LW})
    m.add_circle((x0,y0),0.8,dxfattribs={'layer':'СВН_Кронштейны_тепловизоров','color':6,'lineweight':LW})

# CCTV optical ring follows the perimeter camera chain.
ring=[(x,y) for _,x,y,_ in fixed_positions]
m.add_lwpolyline(ring,close=True,dxfattribs={'layer':'СВН_Оптика_кольцевая_магистраль','color':4,'lineweight':LW})

# PND ducts from the nearest visible TKK network vertices to the 9 pole cabinets.
tkk_layer=next(e.dxf.layer for e in m.query('INSERT') if e.dxf.name=='в0')
nodes=[]
for e in m:
    if e.dxf.layer!=tkk_layer: continue
    if e.dxftype()=='LINE': ps=[e.dxf.start,e.dxf.end]
    elif e.dxftype()=='LWPOLYLINE': ps=[(q[0],q[1]) for q in e.get_points('xy')]
    else: continue
    for q in ps:
        xx=float(q[0] if not hasattr(q,'x') else q.x); yy=float(q[1] if not hasattr(q,'y') else q.y)
        if 5000<xx<7000 and -11500<yy<-10300: nodes.append((xx,yy,e.dxf.handle))
if not nodes: raise RuntimeError('Не найдены узлы видимой ТКК трассы в координатах генплана')
pnd_lengths=[]
for cab in cabinet_positions:
    cx,cy=cab['xy'];wx,wy,handle=min(nodes,key=lambda q:math.hypot(q[0]-cx,q[1]-cy));dist=math.hypot(wx-cx,wy-cy)
    m.add_lwpolyline([(wx,wy),(cx,cy)],dxfattribs={'layer':'СВН_Труба_ПНД_к_шкафам','color':2,'lineweight':LW,'linetype':'DASHED'})
    ang=math.degrees(math.atan2(cy-wy,cx-wx))
    m.add_text(f'ПНД → {cab["id"]}',dxfattribs={'insert':((wx+cx)/2,(wy+cy)/2+2),'height':1.7,'rotation':ang,'style':'Standard','layer':'СВН_Труба_ПНД_к_шкафам','lineweight':LW})
    pnd_lengths.append({'cabinet':cab['id'],'nearest_visible_TKK_handle':handle,'length_m':round(dist,1)})

# Regenerate the fixed and thermal sector layers from the manufacturer's DORI/VCA range and field of view.
def wedge(x,y,angle,fov,reach,layer,color):
    a=math.radians(angle);half=math.radians(fov/2);steps=max(24,int(fov/1.0))
    poly=[(x,y)]+[(x+reach*math.cos(a-half+2*half*k/steps),y+reach*math.sin(a-half+2*half*k/steps)) for k in range(steps+1)]
    hatch=m.add_hatch(color=color,dxfattribs={'layer':layer,'lineweight':LW});hatch.set_solid_fill(color=color);hatch.paths.add_polyline_path(poly,is_closed=True);hatch.transparency=86
    m.add_lwpolyline(poly,close=True,dxfattribs={'layer':layer,'color':color,'lineweight':LW})
    m.add_line((x,y),(x+min(18,reach*.22)*math.cos(a),y+min(18,reach*.22)*math.sin(a)),dxfattribs={'layer':layer,'color':color,'lineweight':LW})
for _,x,y,ang in fixed_positions: wedge(x,y,ang,84,80,'СВН_Зоны_обзора_фикс',5)
for ent in m.query(f'INSERT[layer=="{thermal_layer}"]'):
    wedge(ent.dxf.insert.x,ent.dxf.insert.y,ent.dxf.rotation,42.5,105,'СВН_Зоны_VCA_тепловизоры',1)

# Sheet text: change the concept from broad-area coverage to fence protection only.
replacements={
 'Концепция по генплану · без новых отдельно стоящих опор · камеры на существующих опорах освещения':'Периметральная стадия · без камер внутренних проездов и площадок · ВН на существующих опорах освещения; ТВ на кронштейнах ограждения',
 'Периметр и наружный рубеж':'Периметр и наружный рубеж',
 '• Контур территории: 49,2 га; виллы: 17,2 га; общая территория: 32,1 га\\P• Периметр по ведомости: 3 370 м (геометрия уточняется)\\P• DS-2TD2667-15/PY: 34 двухспектральные камеры / 17 пар, шаг ~196 м; VCA human 105 м':'• Контур территории: 49,2 га; виллы: 17,2 га; общая территория: 32,1 га\\P• Фактическая полилиния ограждения: 3 331,75 м\\P• DS-2TD2667-15/PY: 34 камеры / 17 пар на кронштейнах; шаг станций 195,98 м\\P• VCA human 105 м в каждом направлении: суммарно 210 м и около 14 м перекрытия станций',
 'Внутренняя линия вдоль ограждения':'Линия камер ВН на опорах освещения',
 '• 57 камер DS-2CD2043G2-I, 4 мм; касательное направление, DORI Detect до 80 м.\\P• Шаг по фактической полилинии 58,5 м с добавлением точек на углах\\P• Ориентация на ограждение и общую дорогу':'• 45 камер ВН-08-01…45 DS-2CD2043G2-I, 4 мм, установлены вдоль ограждения\\P• Шаг 74,04 м; направление по касательной, HFOV 84°, DORI Detect до 80 м\\P• Маркеры опор условные посадочные точки — совместить с исполнительным реестром',
 'Общая территория и узлы':'Граница текущей стадии',
 '• Внутренние проезды: 21 × DS-2CD2043G2-I, 4 мм; DORI Detect 80 м, HFOV 84°; ось показывает направление.\\P• Площадки/беседка: 4 купольные + 4 PTZ\\P• КПП: камеры и оборудование доступа учтены отдельно,':'• Камеры внутренних проездов, площадок и беседок в эту стадию не входят.\\P• ВД-08-XX и подобные внутренние позиции исключены.\\P• КПП и проходы рассматриваются отдельным проектным блоком.',
 'Монтаж и инженерные условия':'Монтаж и инженерные условия',
 '• Нанесённые в этом комплекте опоры являются концептуальными и требуют привязки по фактическому плану освещения':'• Условные точки ОС-08-01…45 совмещают камеру ВН и шкаф в узловых точках; фактические опоры уточнить по реестру',
 'Открытые проверки до рабочей документации':'Открытые проверки до рабочей документации',
 'КОЛИЧЕСТВА КОНЦЕПЦИИ (БЕЗ КПП)':'КОЛИЧЕСТВА ПЕРИМЕТРАЛЬНОЙ СТАДИИ (БЕЗ КПП)',
 '38 тепловизионных · 67 периметральных · 21 на внутренних проездах':'34 тепловизионных · 45 камер ВН на периметре · 9 шкафов на опорах камер',
 '4 купольные · 4 PTZ · 1 оптоволоконная сенсорная линия вдоль забора':'Кронштейны ТВ на ограждении · 1 оптоволоконная сенсорная линия',
 'ИТОГО: 120 физических камер / 154 видеоканала без КПП; предварительно.':'ИТОГО: 79 физических камер / 113 видеоканалов без КПП; предварительно.',
 'Зоны цветом нанесены отдельными слоями: видимые камеры — DORI Observe; тепловизоры — VCA 105 м. Проверить рельеф, ограждение и опоры.':'Зоны нанесены отдельными слоями: ВН — DORI Detect 80 м / HFOV 84°; ТВ — VCA human 105 м / HFOV 42,5°. Сектора показаны по азимуту оборудования, без 3D-рельефа и заслонений.',
 'СВН_Зоны_обзора_фикс — DORI Observe 31 м':'СВН_Зоны_обзора_фикс — DORI Detect 80 м, HFOV 84°',
 'СВН_Камеры_проезды — DS-2CD2043G2-I / 4 мм':'СВН_Опоры_освещения — точки совмещения ВН и ШК (уточнить по реестру)',
 'СВН_Зоны_VCA_тепловизоры — 105 м, HFOV 42,5°':'СВН_Кронштейны_тепловизоров — парный монтаж на ограждении',
 'СВН_Кабель_ТКК — CCTV-кабель в телефонной канализации':'СВН_Оптика_кольцевая_магистраль — периметральная магистраль CCTV',
 'Все новые линии: 0,40 мм; подписи: Standard / isocpeui.ttf, 1,275.':'Линии СВН: 0,40 мм; подписи Standard / isocpeui.ttf. 11 шкафов ставятся на опорах ВН; нагрузка каждого — не более 8 PoE-устройств.',
 'УГО камер/СКУД импортированы из Садик СС.dxf; купольный UGO для PTZ применён как обозначение корпуса.':'УГО камер и шкафов импортированы из Садик СС.dxf; тепловизоры показаны парой на кронштейне ограждения.',
 'ОС — условная точка установки на существующей опоре освещения; привязать по исполнительному плану.\\PПНД — от ближайшего узла видимой трассы ТКК к полевому шкафу; точку колодца уточнить по исходному DWG.':'ОС-08 — маркер места установки камеры ВН и шкафа на одной существующей опоре; заменить маркером реальной опоры после получения реестра.\\PТВ — кронштейн парных камер непосредственно на ограждении; направление — вдоль периметра.\\PПНД от ближайшего узла видимой трассы ТКК к каждому из 9 шкафов; фактический колодец уточнить по исходному DWG.',
 '19 узлов × 2 направления\\P(38 камер, предварительно)':'17 узлов × 2 направления\\P(34 тепловизора; шаг ~195,98 м; перекрытие ~14 м)',
 '67 периметральных фиксированных\\P21 камера внутренних дорог\\P4 купольные + 4 PTZ':'45 фиксированных ВН на опорах по ограждению\\P0 камер внутренних проездов / площадок в этой стадии',
 'Уровень поля':'Полевые устройства только по периметру',
 'Узел М1 · тепловизор на опоре освещения':'Узел М1 · парные тепловизоры на кронштейне ограждения',
 'Кронштейн с хомутовым креплением к существующей опоре; антивибрационная прокладка; ориентация наружу вдоль сектора ограждения. Проверить несущую способность и ветровую нагрузку. Питание/сеть — в герме':'Кронштейн с креплением к стойке/элементу ограждения; два DS-2TD2667-15/PY направить встречно по касательным к ограждению. Высота, ветровая нагрузка, вибрация и отсутствие помех для ограждения — проверить по месту.',
 'Узел М2 · фиксированная камера внутри':'Узел М2 · камера ВН и шкаф на существующей опоре освещения',
 'Крепление на существующей опоре освещения, камера направлена вдоль ограждения и общей дороги. Настроить приватные маски вилл, WDR/ИК и аналитику пересечения линии. Проверить встречные фары и слепые зоны.':'Камера DS-2CD2043G2-I на опоре освещения направлена по касательной вдоль ограждения. Узловой шкаф устанавливать на той же опоре; один шкаф обслуживает до пяти последовательных камер и ближайшую пару ТВ.',
 'Цепь видеокамеры':'Цепь периметральной камеры ВН',
 'Для PTZ — проверить бюджет PoE, питание нагревателя и канал управления.':'Пять соседних камер ВН подключить к шкафу на одной из опор этой группы; шкаф включить в оптическое кольцо.',
 'Цепь тепловизора':'Цепь парного тепловизионного узла',
 'Тепловизор → PoE/питание согласно паспорту → полевой коммутатор/медиаконвертер → оптика → сеть CCTV → VMS.\\PСобытия аналитики связать с картой и ближайшей фиксированной камерой.':'Два тепловизора на общем кронштейне → кабельные вводы к ближайшему узловому шкафу ВН → кольцевая оптика → сеть CCTV / HikCentral. Узел назначить на ближайшую группу из пяти камер ВН.',
 'Количество на текущем плане':'Камеры только по периметру',
 '19 парных узлов, шаг ~178 м; VCA human 105 м':'17 парных узлов, шаг 195,98 м; VCA 105 м в каждую сторону; перекрытие ≈14 м',
 'Размещение по контуру, ~58,5 м по фактическому периметру':'Периметральный шаг 74,04 м; DORI Detect 80 м; направление по касательной',
 '154 видеоканала + ресурсы КПП/домофонии по ведомости':'113 видеоканалов на текущем плане; КПП/домофония отдельно',
 '12 ПНД-ответвлений от ближайших узлов видимой ТКК к шкафам на опорах; привязку к колодцам и диаметры уточнить.':'11 ПНД-ответвлений от ближайших видимых узлов ТКК к шкафам на опорах камер ВН; привязку к реальным колодцам уточнить.',
}

def replace_sheet_text(s):
    for a,b in replacements.items():
        if a and a in s: s=s.replace(a,b)
    return s

for lo in doc.layouts:
    if lo.name.lower()=='model': continue
    if '05_' in lo.name:
        texts=list(lo.query('TEXT'))
        obsolete_y=[e.dxf.insert.y for e in texts if e.dxf.text.strip() in ('КМ-ДОР','КМ-КУП','КМ-PTZ')]
        fixed_y=[e.dxf.insert.y for e in texts if e.dxf.text.strip()=='КМ-ПР']
        switch_y=[e.dxf.insert.y for e in texts if 'DS-3T1512HP-SI-8P4F' in e.dxf.text]
        for e in list(lo.query('TEXT')):
            if any(abs(e.dxf.insert.y-y)<0.5 for y in obsolete_y): lo.delete_entity(e)
        for e in lo.query('TEXT'):
            if any(abs(e.dxf.insert.y-y)<0.5 for y in fixed_y) and e.dxf.text.strip()=='57': e.dxf.text='45'
            if any(abs(e.dxf.insert.y-y)<0.5 for y in switch_y) and e.dxf.text.strip() in ('12','по расчёту','по расчету'):
                e.dxf.text='11'
    for e in list(lo):
        if e.dxftype()=='TEXT': e.dxf.text=replace_sheet_text(e.dxf.text)
        elif e.dxftype()=='MTEXT': e.text=replace_sheet_text(e.text)
    if '03_' in lo.name:
        for e in lo:
            if e.dxftype()=='TEXT' and e.dxf.text.strip()=='камера внутри': e.dxf.text='камера ВН на опоре'
    if '06_' in lo.name:
        for e in list(lo):
            if e.dxftype() in ('TEXT','MTEXT') and 'КЛ-PTZ-01' in (e.dxf.text if e.dxftype()=='TEXT' else e.text):
                lo.delete_entity(e)

# Remove the obsolete PTZ plaza cable row before normalizing inherited text.
sheet6=next(l for l in doc.layouts if '06_' in l.name)
ptz_rows=[]
for e in list(sheet6):
    if e.dxftype()=='TEXT': content=e.dxf.text
    elif e.dxftype()=='MTEXT': content=e.text
    else: continue
    if 'PTZ площадок' in content or 'КЛ-PTZ-01' in content: ptz_rows.append(e.dxf.insert.y)
for e in list(sheet6):
    if e.dxftype() not in ('TEXT','MTEXT'): continue
    if any(abs(e.dxf.insert.y-y)<0.5 for y in ptz_rows): sheet6.delete_entity(e)

# Normalize legacy sheet copy that referred to the broader v05/v06 concept.
global_text_fixes={
 '3 370 м':'3 332 м','3 707 м':'3 665 м','120 физических камер':'79 физических камер',
 '154 видеоканала':'113 видеоканала','154 канала':'113 канала','35,9 ТБ':'26,4 ТБ',
 '≥50 ТБ':'≥36 ТБ','67 периметральных':'45 периметральных','9 шкафов':'11 шкафов',
 '38 камер, предварительно':'34 тепловизора, предварительно','4 купольные + 4 PTZ':'камеры внутренних площадок не включены',
 '21 камера внутренних дорог':'0 камер внутренних дорог','3 370 м геометрии':'3 332 м геометрии',
 'Связь/питание PTZ площадок':'',
}
for lo in doc.layouts:
    if lo.name.lower()=='model': continue
    for e in list(lo):
        if e.dxftype()=='TEXT':
            s=e.dxf.text
            for a,b in global_text_fixes.items(): s=s.replace(a,b)
            e.dxf.text=s
        elif e.dxftype()=='MTEXT':
            s=e.text
            for a,b in global_text_fixes.items(): s=s.replace(a,b)
            e.text=s

# Full replacement of the three explanatory plan groups avoids truncated inherited paragraphs.
plan=next(l for l in doc.layouts if '01_' in l.name)
for e in plan.query('MTEXT'):
    s=e.text
    if 'Контур территории:' in s:
        e.text='• Контур: 49,2 га; участки вилл: 17,2 га; общая территория: 32,1 га\\P• Ограждение по геометрии генплана: 3 331,75 м\\P• ТВ-08: 34 двухспектральные камеры на 17 парных кронштейнах; шаг 195,99 м\\P• Дальность VCA Human 105 м в каждом направлении; продольное перекрытие соседних станций около 14 м.'
    elif '45 камер ВН-08-01' in s or '57 камер DS-2CD2043G2-I' in s:
        e.text='• 45 камер ВН-08-01…45 DS-2CD2043G2-I на опорах освещения вдоль ограждения\\P• Шаг 74,04 м по фактической длине контура; HFOV 84°, DORI Detect 80 м; азимут по касательной\\P• Посадочные маркеры опор заменить на координаты из исполнительного реестра.'
    elif 'Камеры внутренних проездов' in s or 'Внутренние проезды:' in s:
        e.text='• В текущей стадии предусмотрены только периметральные камеры и охрана ограждения.\\P• ВД-08-XX, камеры проездов, площадок и парка исключены.\\P• Оборудование КПП учитывается отдельным проектным блоком.'
    elif 'Новые самостоятельные опоры' in s or 'Нанесённые в этом комплекте' in s:
        e.text='• Камеры ВН и шкаф каждого узла совмещаются на одной существующей опоре освещения.\\P• 11 шкафов распределены вдоль ограждения; нагрузка каждого ограничена 8 PoE-устройствами с балансировкой соседних камер.\\P• ТВ устанавливаются на кронштейнах, закреплённых непосредственно на ограждении.\\P• Реальные точки опор, питание, заземление и несущую способность подтвердить по исполнительному плану/обследованию.'
    elif '38 тепловизионных' in s or '67 периметральных' in s:
        e.text='34 тепловизора · 45 камер ВН по ограждению · 11 узловых шкафов'
    elif '4 купольные' in s or '1 оптоволоконная сенсорная линия' in s:
        e.text='Камеры внутренних проездов и площадок в эту стадию не входят · 1 оптоволоконная сенсорная линия'
    elif 'Сенсорный контур по выбранным полилиниям' in s:
        e.text='Сенсорный контур по геометрии ограждения: 3 331,75 м; монтажный запас уточнить.'
    elif 'ИТОГО:' in s and ('физических камер' in s or 'видеоканала' in s):
        e.text='ИТОГО: 79 физических камер / 113 видеоканалов без КПП; предварительная концепция.'

for lo in doc.layouts:
    if lo.name.lower()=='model': continue
    switch_rows=[e.dxf.insert.y for e in lo.query('TEXT') if 'DS-3T1512HP-SI-8P4F' in e.dxf.text]
    for e in lo.query('MTEXT'):
        s=e.text
        if 'Локальные шкафы только на существующих опорах' in s or 'PoE-коммутаторы / медиаконвертеры' in s:
            e.text='11 шкафов на опорах камер ВН; по кольцевой оптике к ядру.\\PНагрузка каждого шкафа ограничена 8 PoE-устройствами: соседние ВН и ближайшие ТВ распределить между узлами.'
        elif 'Узловой шкаф устанавливать на той же опоре' in s or 'один шкаф обслуживает до пяти' in s:
            e.text='Камера DS-2CD2043G2-I на существующей опоре освещения направлена по касательной вдоль ограждения. Шкаф устанавливается на этой же опоре; соседние ВН и ТВ балансируются между шкафами с пределом 8 PoE-устройств на узел.'
        elif 'Пять соседних камер ВН подключить' in s or 'группу из пяти камер ВН' in s:
            e.text='Каждый шкаф на опоре ВН подключает ближайшие камеры и ТВ, но не более 8 PoE-устройств. Медные участки выполнить короткими в пределах опоры/кронштейна; межузловая магистраль — оптическое кольцо.'
        elif 'Распределённые узлы' in s:
            e.text=s.replace('Распределённые узлы','11 шкафов на опорах ВН; до 8 PoE-портов на узел')
    for e in lo.query('TEXT'):
        if not any(abs(e.dxf.insert.y-y)<0.5 for y in switch_rows): continue
        if e.dxf.text.strip()=='Распределённые узлы': e.dxf.text='11 шкафов на опорах ВН; до 8 PoE устройств'
        elif e.dxf.text.strip()=='Нужны ведомость нагрузок и обследование': e.dxf.text='Максимум 8 устройств на шкаф; проверить PoE-бюджет и питание'

for lo in doc.layouts:
    if lo.name.lower()=='model': continue
    for e in lo:
        if e.dxftype()=='TEXT':
            e.dxf.text=e.dxf.text.replace('113 канала','113 видеоканалов')

# Replace the remaining outdated device row on the cable schedule.

# Recalculate schedule values on plan/spec notes. Replace stale headline storage calculation.
for lo in doc.layouts:
    if lo.name.lower()=='model': continue
    for e in lo:
        if e.dxftype()=='TEXT': s=e.dxf.text
        elif e.dxftype()=='MTEXT': s=e.text
        else: continue
        s=s.replace('35,9 ТБ raw','26,4 ТБ raw').replace('35.9 ТБ raw','26.4 ТБ raw').replace('≥50 ТБ полезного','≥36 ТБ полезного')
        s=s.replace('3 707 м*','3 665 м*').replace('3 370 м × 1,1','3 332 м × 1,1')
        if e.dxftype()=='TEXT': e.dxf.text=s
        else: e.text=s

doc.header['$INSUNITS']=4
audit=doc.audit()
if audit.errors: raise RuntimeError(f'DXF audit errors: {len(audit.errors)}')
doc.saveas(OUT)
check=ezdxf.readfile(OUT); cm=check.modelspace()
counts={layer:len(list(cm.query(f'INSERT[layer=="{layer}"]'))) for layer in ('СВН_Камеры_периметр','СВН_Камеры_проезды','СВН_Камеры_купольные','СВН_Камеры_PTZ','СВН_Тепловизоры','СВН_Шкафы_коммутационные')}
report={
 'output':str(OUT),'perimeter_m':round(perimeter,2),'fixed_cameras':counts['СВН_Камеры_периметр'],'fixed_spacing_m':round(fixed_spacing,2),
 'thermal_cameras':counts['СВН_Тепловизоры'],'thermal_pairs':station_count,'thermal_station_spacing_m':round(station_spacing,2),
 'cabinets':counts['СВН_Шкафы_коммутационные'],'cabinet_max_poE_devices':max(cab_loads),'physical_cameras':counts['СВН_Камеры_периметр']+counts['СВН_Тепловизоры'],
 'video_channels':counts['СВН_Камеры_периметр']+2*counts['СВН_Тепловизоры'],
 'lighting_host_markers':len(list(cm.query('CIRCLE[layer=="СВН_Опоры_освещения"]'))),
 'thermal_bracket_lines':len(list(cm.query('LINE[layer=="СВН_Кронштейны_тепловизоров"]'))),
 'optical_ring_polylines':len(list(cm.query('LWPOLYLINE[layer=="СВН_Оптика_кольцевая_магистраль"]'))),
 'pnd_branches':len(pnd_lengths),'pnd_lengths':pnd_lengths,'cabinet_groups':cabinet_positions,
 'perimeter_cameras_only':counts['СВН_Камеры_проезды']==0 and counts['СВН_Камеры_купольные']==0 and counts['СВН_Камеры_PTZ']==0,
 'audit_errors':len(check.audit().errors),
 'notes':['Lighting host markers are provisional locations; snap to the actual lighting-pole register before construction.',
          'Thermal coverage uses the 105 m human VCA distance in both directions; 17 paired stations overlap by about 14 m on the longitudinal perimeter axis.',
          'PND branches start at nearest visible TKK geometry; manhole identities remain unverified.',
          'No cameras are included for internal roads, plazas, or park in this phase.']}
REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ('pnd_lengths','cabinet_groups','notes')},ensure_ascii=False))
