from pathlib import Path
import math,json,re,csv,hashlib,collections,html,textwrap
import ezdxf
from ezdxf.xref import Loader
from ezdxf import bbox
from ezdxf.lldxf.tagwriter import TagCollector
from tkk_integrity import tkk_block_fingerprints, verify_tkk_blocks
from shapely.geometry import Polygon,Point,LineString
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points,unary_union
from scipy.optimize import linear_sum_assignment
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'output/CCTV_v09';OUT.mkdir(parents=True,exist_ok=True)
SOURCE=ROOT/'ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией_исправлены_УГО_04мм.dxf'
PREV=ROOT/'output/CCTV_v08_review/CCTV_Source_v08_review.dxf'
TKK='ТЕЛЕФОННАЯ_КАБЕЛЬНАЯ_КАНАЛИЗАЦИЯ'
G=json.loads((ROOT/'output/CCTV_v08_review/plot_geometry.json').read_text(encoding='utf-8'))
OLD=json.loads((ROOT/'output/CCTV_v08_review/review_v08.json').read_text(encoding='utf-8'))
CAND=json.loads((ROOT/'output/cctv_chain_candidate.json').read_text(encoding='utf-8'))
fence=Polygon(G['fence']);boundary=LineString(fence.exterior.coords);L=boundary.length
area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(G['fence'],G['fence'][1:]+G['fence'][:1]))/2
outer=orient(fence.buffer(.6,join_style=2),sign=1 if area>0 else -1);offset=LineString(outer.exterior.coords)
start=offset.project(Point(G['objects']['ТВ-08-01']['x'],G['objects']['ТВ-08-01']['y']))
BASE=[tuple(offset.interpolate((start+j*offset.length/34)%offset.length).coords)[0] for j in range(34)]
COL={1:'#be2534',2:'#a27b09',3:'#22764c',4:'#087d9b',5:'#245a9d',6:'#9e377e',7:'#172a3d',8:'#8996a1',30:'#b46726'}

def tkk_record(doc):
 result={}
 for e in doc.modelspace():
  if e.dxf.layer==TKK:
   tags=TagCollector.dxftags(e,doc.dxfversion)
   s='\n'.join(f'{t.code}:{str(t.value)}' for t in tags)
   result[e.dxf.handle]={'type':e.dxftype(),'hash':hashlib.sha256(s.encode()).hexdigest()}
 return result

class Sheet:
 def __init__(self,doc,name,title,no,w=841,h=594):
  self.doc=doc;self.name=name;self.w=w;self.h=h;self.svg=[]
  if name in doc.layouts:doc.layouts.delete(name)
  self.p=doc.layouts.new(name);self.p.page_setup(size=(w,h),margins=(0,0,0,0),units='mm',scale=(1,1),device='DWG To PDF.pc3')
  self.rect(8,8,w-16,h-16);self.rect(8,8,w-16,30)
  self.text(16,h-23,title,7,5);self.text(16,h-35,'СВН периметра · v09 · проектный вариант для согласования',3.4,8)
  self.text(16,25,'ПОСЁЛОК · СИСТЕМА ВИДЕОНАБЛЮДЕНИЯ И ОХРАНЫ ПЕРИМЕТРА',3.2)
  self.text(16,14,'Решения требуют привязки к обследованным опорам, ограждению и питанию.',2.6,8)
  self.text(w-96,24,no,4.2,5);self.text(w-96,14,f'{w} × {h} мм',2.5,8)
 def line(self,a,b,c=7,lw=.4,dash=False):
  self.p.add_line(a,b,dxfattribs={'layer':'СВН_СХЕМЫ','color':c,'lineweight':int(lw*100)})
  self.svg.append(f'<line x1="{a[0]}" y1="{self.h-a[1]}" x2="{b[0]}" y2="{self.h-b[1]}" stroke="{COL.get(c,COL[7])}" stroke-width="{lw}"'+(' stroke-dasharray="3 2"' if dash else '')+'/>')
 def poly(self,pts,c=7,fill=None,lw=.4,closed=True):
  self.p.add_lwpolyline(pts,close=closed,dxfattribs={'layer':'СВН_СХЕМЫ','color':c,'lineweight':int(lw*100)})
  if fill:
   h=self.p.add_hatch(color=fill,dxfattribs={'layer':'СВН_СХЕМЫ'});h.paths.add_polyline_path(pts,is_closed=True)
  ps=' '.join(f'{x},{self.h-y}' for x,y in pts);tag='polygon' if closed else 'polyline'
  self.svg.append(f'<{tag} points="{ps}" fill="{COL.get(fill,"none")}" stroke="{COL.get(c,COL[7])}" stroke-width="{lw}"/>')
 def rect(self,x,y,w,h,c=7,lw=.4):self.poly([(x,y),(x+w,y),(x+w,y+h),(x,y+h)],c,lw=lw)
 def circle(self,x,y,r,c=7,lw=.4):
  self.p.add_circle((x,y),r,dxfattribs={'layer':'СВН_СХЕМЫ','color':c,'lineweight':int(lw*100)})
  self.svg.append(f'<circle cx="{x}" cy="{self.h-y}" r="{r}" fill="white" stroke="{COL.get(c,COL[7])}" stroke-width="{lw}"/>')
 def text(self,x,y,s,h=3,c=7):
  self.p.add_text(str(s),dxfattribs={'layer':'СВН_СХЕМЫ','insert':(x,y),'height':h,'style':'SVN_Diagram','color':c})
  self.svg.append(f'<text x="{x}" y="{self.h-y}" font-family="Arial,DejaVu Sans,sans-serif" font-size="{h}" fill="{COL.get(c,COL[7])}">{html.escape(str(s))}</text>')
 def para(self,x,y,s,width,h=3,c=7):
  lines=[]
  for raw in s.split('\n'):lines+=textwrap.wrap(raw,max(6,int(width/(h*.56))),break_long_words=False,break_on_hyphens=False) or ['']
  for i,line in enumerate(lines):self.text(x,y-i*h*1.45,line,h,c)
  return y-len(lines)*h*1.45
 def arrow(self,a,b,c=5,lw=.5):
  self.line(a,b,c,lw);an=math.atan2(b[1]-a[1],b[0]-a[0]);q=3
  self.poly([b,(b[0]-q*math.cos(an-.4),b[1]-q*math.sin(an-.4)),(b[0]-q*math.cos(an+.4),b[1]-q*math.sin(an+.4))],c,fill=c)
 def callout(self,point,elbow,label,x,y,width=160,c=7):
  self.line(point,elbow,c,.25);self.line(elbow,(x,y+1.5),c,.25);self.para(x,y+4,label,width,3,c)
 def save(self,directory,stem):
  svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}mm" height="{self.h}mm" viewBox="0 0 {self.w} {self.h}"><rect width="100%" height="100%" fill="white"/>'+''.join(self.svg)+'</svg>'
  (directory/f'{stem}.svg').write_text(svg,encoding='utf-8')

def camera(s,x,y,scale=1,c=1):
 pts=[(x,y),(x+28*scale,y),(x+32*scale,y+13*scale),(x+4*scale,y+13*scale)]
 s.poly(pts,c,lw=.7);s.poly([(x+4*scale,y+13*scale),(x+9*scale,y+18*scale),(x+36*scale,y+18*scale),(x+32*scale,y+13*scale)],c)
 s.poly([(x+28*scale,y),(x+35*scale,y+4*scale),(x+39*scale,y+17*scale),(x+32*scale,y+13*scale)],c)
 s.circle(x+33.5*scale,y+6.8*scale,2*scale,c);s.circle(x+35*scale,y+12*scale,1.6*scale,c)
 s.line((x+11*scale,y),(x+11*scale,y-8*scale),7,.8);s.line((x+6*scale,y-8*scale),(x+20*scale,y-8*scale),7,.8)

def cabinet(s,x,y,w=102,h=100,title='Шкаф'):
 s.rect(x,y,w,h,5,.65);s.poly([(x,y+h),(x+5,y+h+5),(x+w+5,y+h+5),(x+w,y+h)],5)
 s.line((x+w,y),(x+w+5,y+5),5);s.line((x+w+5,y+5),(x+w+5,y+h+5),5)
 s.text(x+5,y+h-10,title,4,5)
 s.rect(x+7,y+8,w-14,20,5);s.text(x+10,y+21,'PoE 1…8 / SFP A, B',2.7)
 for k in range(8):s.rect(x+10+k*(w-25)/8,y+11,6,4,5)
 s.line((x+7,y+35),(x+w-7,y+35),8,.5)

def make_structure(doc,directory,cabs,links,nthermal):
 s=Sheet(doc,'СВН-02_Структурная','02 · Структурная схема: каждый полевой узел и оптическое кольцо','СВН-02')
 s.text(20,535,f'45 камер ВН + {nthermal} двухспектральных ТВ = {45+nthermal} устройств / {45+2*nthermal} видеоканалов',4,5)
 s.text(20,525,'Сплошная синяя линия — физическое оптическое кольцо; вертикальные вводы — локальный Ethernet/PoE.',3.2)
 positions=[]
 for j in range(len(cabs)):
  if j<6:positions.append((40+j*126,365))
  else:positions.append((670-(j-6)*126,185))
 # Ring edges drawn first, then cabinets; physical core is a separate ring node in lower left.
 for j in range(len(positions)-1):
  x,y=positions[j];xx,yy=positions[j+1]
  if j<5:s.line((x+104,y+18),(xx,yy+18),4,.85)
  elif j==5:s.poly([(x+104,y+18),(810,y+18),(810,yy+18),(xx+104,yy+18)],4,lw=.85,closed=False)
  else:s.line((x,y+18),(xx+104,yy+18),4,.85)
 core=(85,150)
 x,y=positions[-1];s.poly([(x,y+18),(x-10,y+18),(x-10,163),(85,163),core],4,lw=.85,closed=False)
 x,y=positions[0];s.poly([(35,131),(20,131),(20,y+18),(x,y+18)],4,lw=.85,closed=False)
 for (x,y),cab in zip(positions,cabs):
  cabinet(s,x,y,104,112,cab['id'])
  ids=lambda names:','.join(n.rsplit('-',1)[1] for n in sorted(names)) or '—'
  s.para(x+7,y+87,'ВН: '+ids(cab['camera_group']),90,3.7)
  s.para(x+7,y+69,'ТВ: '+ids(cab['thermal_group']),90,3.7)
  load=len(cab['camera_group'])+len(cab['thermal_group']);s.text(x+7,y+43,f'Порты: {load}/8',3.2,3)
  s.arrow((x+51,y+132),(x+51,y+117),7,.35)
  camera(s,x+25,y+133,.5,5);camera(s,x+53,y+133,.5,1)
 # Core and rack sit outside field cabinets; connection is explicit.
 s.rect(35,112,110,38,5,.7);s.text(41,138,'ЯДРО СЕТИ',4,5);s.text(41,126,'2 SFP в кольцо + uplink',3);s.text(41,116,'VLAN CCTV / тревоги',2.8)
 s.arrow((145,130),(195,130),5,.7)
 s.rect(195,70,180,80,5);s.text(204,137,'HikCentral / сервер VMS',4,5)
 s.rect(205,93,160,28,5);s.text(214,109,'Видеопотоки + события',3.2)
 for i in range(8):s.circle(213+i*9,99,1,5)
 s.rect(405,70,180,80,5);s.text(414,137,'Система хранения',4,5);s.text(414,124,'RAID / архив по ТЗ',3.2)
 for i in range(5):s.rect(416+i*30,84,23,30,8);s.circle(427+i*30,90,1,3)
 s.arrow((375,110),(405,110),5,.6)
 s.rect(615,70,180,80,5);s.text(624,137,'АРМ оператора',4,5);s.rect(636,95,115,28,5);s.line((692,95),(692,86),5);s.line((673,85),(713,85),5)
 s.poly([(285,150),(285,158),(705,158),(705,150)],5,lw=.4,closed=False);s.arrow((705,158),(705,150),5,.4)
 s.para(42,350,'SFP A/B — два направления кольца. Ethernet/PoE — камеры конкретного шкафа по CSV.\nСенсор ограждения → свой контроллер → ядро/VMS. Питание узлов круглосуточное, с резервированием.',745,3.5)
 s.para(20,62,'Ведомость подключений содержит каждую камеру один раз. Длины предварительные; Long Range, PoE-бюджет, источник питания, оптический бюджет и режим резервирования подлежат расчёту.',790,2.7,8)
 s.save(directory,'02_structure')

def make_mount(doc,directory):
 s=Sheet(doc,'СВН-03_Монтаж','03 · Монтаж тепловизора снаружи ограждения: виды и детали крепления','СВН-03')
 s.text(20,535,'М1 · Общий вид со стороны наружной территории',4.2,5)
 # Perspective fence panels, structural post, flanges and cantilever to outside.
 s.poly([(40,315),(210,365),(210,495),(40,445)],8,lw=.65)
 for j in range(1,10):
  x=40+j*17;s.line((x,315+(x-40)*50/170),(x,445+(x-40)*50/170),8,.25)
 for y in [345,385,425]:s.line((40,y),(210,y+50),8,.5)
 s.poly([(128,339),(143,344),(143,474),(128,469)],7,lw=1)
 s.poly([(143,344),(150,350),(150,480),(143,474)],7,lw=.6)
 for y in [399,435]:
  s.rect(122,y,30,12,5,.8)
  for x in [126,148]:s.circle(x,y+6,1.7,5)
 s.poly([(138,408),(145,414),(254,367),(247,361)],5,lw=1)
 s.poly([(247,361),(254,367),(254,380),(247,374)],5,lw=.8)
 s.line((143,440),(247,367),5,.75)
 camera(s,225,390,1.25,1)
 s.line((247,380),(247,389),5,1)
 s.line((231,388),(228,382),4,.6);s.poly([(228,382),(221,375),(214,380),(145,410)],4,lw=.5,closed=False)
 s.callout((137,446),(180,488),'01  Крепление к несущей стойке',218,495,168)
 s.callout((204,389),(248,350),'02  Выносной кронштейн с подкосом',260,351,130)
 s.callout((240,403),(270,440),'03  Двухспектральный тепловизор',275,443,125,1)
 s.callout((214,379),(245,323),'04  Кабель в защите, петля вниз',250,325,145,4)
 s.text(40,300,'ВНУТРИ: стойка и ограждение',3.5,8);s.text(226,290,'СНАРУЖИ: камера и зона контроля',3.5,1)
 s.text(432,535,'М1 · Вид сверху / направление цепочки',4.2,5)
 for y in [463,470]:s.line((440,y),(800,y),8,1)
 for x in [462,640]:
  s.rect(x,460,10,14,7,.65);s.line((x+5,460),(x+5,411),5,1)
  s.rect(x-2,409,14,9,5,.6);camera(s,x-7,390,.65,1)
  s.line((x+13,400),(x+13,458),8,.25)
 s.arrow((488,403),(633,403),1,.8);s.text(516,414,'ТВ-i → ТВ-(i+1)',4,1)
 s.text(444,485,'ВНУТРЕННЯЯ ТЕРРИТОРИЯ',3.3,8);s.text(444,365,'НАРУЖНАЯ ПОЛОСА ВДОЛЬ ОГРАЖДЕНИЯ',3.3,1)
 s.line((477,460),(490,460),7,.25);s.line((477,411),(490,411),7,.25);s.arrow((487,460),(487,411),7,.25)
 s.text(495,433,'L ≈ 600 мм*',3.2)
 s.para(440,341,'Ось камеры направлена к следующей точке цепочки. Ограждение не должно перекрывать оптическую ось. Сектор показывается только снаружи; направления внутрь закрыть масками.',355,3.2)
 s.line((20,270),(820,270),8,.3)
 s.text(20,252,'М1 · Фасад крепления / регулируемые размеры',4.2,5)
 s.rect(75,94,42,132,7,.8)
 for y in [120,185]:
  s.rect(62,y,68,22,5,.7)
  for x in [70,122]:s.circle(x,y+11,2.8,5);s.circle(x,y+11,1.2,5)
 s.line((97,144),(97,183),5,2);s.text(150,205,'Планки / анкеры или охватывающий узел',3.2)
 s.callout((122,196),(142,191),'Болтовые соединения: подобрать по расчёту',150,185,225)
 s.callout((97,158),(140,146),'Регулируемая площадка: азимут и наклон',150,146,225)
 s.para(150,111,'Не крепить к декоративному заполнению. Сечение кронштейна, анкеры, сварные швы, высоту H и ветровую нагрузку назначить по обследованию и расчёту конструктора.',242,3)
 s.text(432,252,'М2 · Камера ВН и шкаф на существующей опоре',4.2,5)
 s.rect(480,88,12,133,8,.8);camera(s,484,208,.7,5)
 s.poly([(490,165),(541,165),(541,172),(490,172)],5,lw=.8)
 cabinet(s,541,99,99,107,'ШК-08-xx')
 for yy in [115,185]:s.rect(474,yy,24,7,7,.65)
 s.poly([(510,212),(510,180),(550,180)],4,lw=.6,closed=False)
 s.poly([(547,104),(520,85),(486,85),(486,67)],3,lw=.65,closed=False)
 for i,width in enumerate([15,10,5]):s.line((486-width/2,67-i*4),(486+width/2,67-i*4),3,.5)
 s.para(663,211,'Круглосуточное питание\nЗащита ввода / УЗИП\nРезервный источник DC\nPoE-коммутатор\nОптический кросс\nPE-шина и уравнивание потенциалов',145,3.2)
 s.para(20,63,'* Вынос 600 мм — компоновочное допущение, не монтажный размер. Высоту, вынос на углах, несущую способность и отсутствие заслонения проверить на объекте. Все соединения защитить от воды и коррозии.',790,2.8,1)
 s.save(directory,'03_mounting')

def make_connection(doc,directory):
 s=Sheet(doc,'СВН-04_Подключение','04 · Полевой шкаф: размещение оборудования и подключения','СВН-04',841,594)
 s.text(20,535,'Вид спереди при открытой двери',4.2,5)
 s.rect(30,95,330,410,5,1);s.rect(43,108,304,384,8,.4)
 s.rect(53,420,108,55,5);s.text(61,457,'Оптический кросс',3.8,5);s.text(61,441,'A / B, сварка, запас',3.1)
 s.rect(189,420,140,55,5);s.text(197,457,'Ввод 230 В / защита',3.8,5);s.text(197,441,'Автомат, УЗИП*',3.1)
 s.line((53,401),(329,401),8,2)
 s.rect(53,316,276,63,5);s.text(61,359,'DS-3T1512HP-SI-8P4F',4,5);s.text(61,341,'8 PoE · SFP A/B · DC 48…57 В*',3.3)
 for j in range(8):s.rect(62+j*25,323,14,8,5)
 for j in range(2):s.rect(276+j*22,323,16,8,4)
 s.line((53,291),(329,291),8,2)
 s.rect(53,201,124,66,5);s.text(61,247,'БП / DC-UPS*',4,5);s.text(61,229,'Резерв по расчёту',3.2)
 s.rect(200,201,129,66,5);s.text(208,247,'Защита линий*',4,5);s.text(208,229,'Ethernet / PoE',3.2)
 s.rect(53,137,276,26,3);s.text(62,146,'PE / уравнивание потенциалов',3.7,3)
 for j in range(8):s.circle(170+j*17,148,2,3)
 # Unambiguous cable routes inside cabinet.
 s.poly([(105,420),(105,392),(287,392),(287,331)],4,lw=.7,closed=False)
 s.poly([(115,420),(115,386),(309,386),(309,331)],4,lw=.7,closed=False)
 s.poly([(240,420),(240,400),(340,400),(340,285),(115,285),(115,267)],30,lw=.7,closed=False)
 s.poly([(115,267),(115,305),(183,305),(183,316)],30,lw=.7,closed=False)
 s.poly([(264,267),(264,305),(150,305),(150,323)],5,lw=.65,closed=False)
 s.line((264,201),(264,166),3,.5)
 for xx in [80,145,220,288]:s.circle(xx,118,4,7)
 s.text(50,78,'Вводы снизу; гермовводы, капельные петли, разделение питания и слаботочных линий.',3,8)
 s.text(400,535,'Схема связей и границы расчёта',4.2,5)
 for y,title,body,c in [(440,'Оптика A/B','Два направления кольца → кросс → SFP A/B',4),(348,'Камеры ВН / ТВ','Порт PoE → защита → наружный кабель → камера',5),(256,'Питание','230 В постоянно → защита → резервный DC → PoE',30),(164,'PE и монтаж','Корпус / кронштейн / УЗИП → проектная PE-шина',3)]:
  s.rect(408,y,390,60,c,.7);s.text(420,y+42,title,4,c);s.para(420,y+24,body,365,3.5)
  s.arrow((360,y+30),(408,y+30),c,.5)
 s.para(410,128,'* Состав защиты, тип БП/UPS, номиналы, расход энергии и автономию подобрать по реальным нагрузкам. 8 занятых портов не доказывают достаточность PoE-бюджета. Long Range — по каждой линии и модели камеры.',386,3.2,1)
 s.save(directory,'04_connections')

def strip_mtext(s):
 s=re.sub(r'\\[A-Za-z][^;]*;','',s).replace('\\P',' ')
 return s.replace('{','').replace('}','')

def sector_polygon(x,y,aim,reach=105,fov=42.5):
 pts=[(x,y)]
 for k in range(87):
  a=math.radians(aim-fov/2+fov*k/86);end=(x+reach*math.cos(a),y+reach*math.sin(a));ray=LineString([(x,y),end]);hit=ray.intersection(boundary)
  if not hit.is_empty:
   candidates=[]
   def take(g):
    if hasattr(g,'geoms'):
     for v in g.geoms:take(v)
    elif hasattr(g,'coords'):
     for q in g.coords:
      dist=math.hypot(q[0]-x,q[1]-y)
      if dist>.0001:candidates.append(dist)
   take(hit)
   if candidates:
    dist=max(0,min(candidates)-.001);end=(x+dist*math.cos(a),y+dist*math.sin(a))
  pts.append(end)
 poly=Polygon(pts)
 return (poly if poly.is_valid else poly.buffer(0)).difference(fence)

def add_sector(m,poly,layer,c):
 parts=list(poly.geoms) if hasattr(poly,'geoms') else [poly]
 for p in parts:
  if p.area<.001:continue
  points=list(p.exterior.coords)
  h=m.add_hatch(color=c,dxfattribs={'layer':layer,'lineweight':18})
  h.set_pattern_fill('ANSI31',color=c,angle=0,scale=4)
  h.paths.add_polyline_path(points,is_closed=True)
  h.transparency=0
  m.add_lwpolyline(points,close=True,dxfattribs={'layer':layer,'color':c,'lineweight':18})

def model_preview(doc,positions,sectors,directory):
 # Editable SVG preview of actual model geometry. Preserve TKK texts/lines, render source blocks by virtual decomposition.
 from ezdxf.disassemble import recursive_decompose
 xmin,xmax,ymin,ymax=4900,6960,-11550,-10250
 W,H=2200,1450;sc=min((W-100)/(xmax-xmin),(H-150)/(ymax-ymin));ox=50;oy=100
 def xy(x,y):return (ox+(x-xmin)*sc,oy+(ymax-y)*sc)
 shapes=[]
 def ln(points,c,width=.6):
  q=[xy(x,y) for x,y in points]
  if len(q)<2:return
  shapes.append('<polyline points="'+' '.join(f'{x:.2f},{y:.2f}' for x,y in q)+f'" fill="none" stroke="{c}" stroke-width="{width}"/>')
 def tx(x,y,text,h,c):
  if not xmin-20<x<xmax+20 or not ymin-20<y<ymax+20:return
  px,py=xy(x,y);shapes.append(f'<text x="{px:.2f}" y="{py:.2f}" font-family="Arial,sans-serif" font-size="{max(2.4,h*sc):.2f}" fill="{c}">{html.escape(text)}</text>')
 for e in recursive_decompose(doc.modelspace()):
  ly=e.dxf.layer;t=e.dxftype()
  if ly.startswith(('СВН_Зоны','СВН_Проверка')):continue
  is_tkk=ly==TKK
  c='#1863a3' if is_tkk else '#9ba5ad'
  if ly.startswith(('СВН_','СО_')):c=COL.get(e.dxf.get('color',7),'#172a3d')
  try:
   if t=='LINE':ln([(e.dxf.start.x,e.dxf.start.y),(e.dxf.end.x,e.dxf.end.y)],c,.65 if is_tkk else .35)
   elif t in ('LWPOLYLINE','POLYLINE'):
    ps=list(e.get_points('xy')) if t=='LWPOLYLINE' else [(p.x,p.y) for p in e.points()]
    if e.is_closed:ps+=ps[:1]
    ln(ps,c,.65 if is_tkk else .35)
   elif t in ('CIRCLE','ARC'):
    a=e.dxf.start_angle if t=='ARC' else 0;b=e.dxf.end_angle if t=='ARC' else 360
    if b<a:b+=360
    ps=[(e.dxf.center.x+e.dxf.radius*math.cos(math.radians(a+(b-a)*k/40)),e.dxf.center.y+e.dxf.radius*math.sin(math.radians(a+(b-a)*k/40))) for k in range(41)];ln(ps,c,.65 if is_tkk else .35)
   elif t in ('TEXT','MTEXT'):
    s=e.dxf.text if t=='TEXT' else e.plain_text();h=e.dxf.height if t=='TEXT' else e.dxf.char_height
    for j,row in enumerate(s.splitlines()):tx(e.dxf.insert.x,e.dxf.insert.y-j*h*1.4,strip_mtext(row),h,c)
  except (AttributeError,TypeError,ValueError):continue
 # patterned sectors after light source base, no solid fill.
 patterns='<defs><pattern id="th" patternUnits="userSpaceOnUse" width="12.7" height="12.7" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="12.7" stroke="#be2534" stroke-width=".5"/></pattern><pattern id="vn" patternUnits="userSpaceOnUse" width="12.7" height="12.7" patternTransform="rotate(135)"><line x1="0" y1="0" x2="0" y2="12.7" stroke="#245a9d" stroke-width=".45"/></pattern></defs>'
 for key,polys in sectors.items():
  for poly in polys:
   pp=[xy(x,y) for x,y in list(poly.exterior.coords)]
   shapes.append('<polygon points="'+' '.join(f'{x:.2f},{y:.2f}' for x,y in pp)+f'" fill="url(#{"th" if key=="thermal" else "vn"})" stroke="{COL[1] if key=="thermal" else COL[5]}" stroke-width=".5"/>')
 for j,(x,y) in enumerate(positions):
  px,py=xy(x,y);shapes.append(f'<circle cx="{px}" cy="{py}" r="2.5" fill="#be2534"/>')
 title=f'v09 · Тепловизоры последовательно снаружи · {len(positions)} шт. · ТКК восстановлена из исправленного исходника'
 head=f'<text x="30" y="32" font-size="23" font-family="Arial" fill="#172a3d">{title}</text><text x="30" y="62" font-size="15" font-family="Arial" fill="#172a3d">Штриховка ANSI31 / scale 4. Прямая видимость учитывает ограждение в 2D; рельеф и высота требуют проверки.</text>'
 (directory/'01_plan.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><rect width="100%" height="100%" fill="white"/>{patterns}<defs><clipPath id="plotClip"><rect x="0" y="90" width="{W}" height="{H-90}"/></clipPath></defs>{head}<g clip-path="url(#plotClip)">'+''.join(shapes)+'</g></svg>',encoding='utf-8')

def build(positions,variant):
 directory=OUT/variant;directory.mkdir(exist_ok=True)
 doc=ezdxf.readfile(SOURCE);source_sig=tkk_record(doc);source_count=collections.Counter(e.dxftype() for e in doc.modelspace() if e.dxf.layer==TKK)
 source_blocks=tkk_block_fingerprints(doc,TKK)
 prev=ezdxf.readfile(PREV);loader=Loader(prev,doc)
 loader.load_modelspace(filter_fn=lambda e:e.dxf.layer.startswith(('СВН_','СО_')))
 for lo in prev.layouts:
  if lo.name.startswith('СВН-') and not lo.name.startswith(('СВН-02','СВН-03','СВН-04')):loader.load_paperspace_layout(lo)
 loader.execute();m=doc.modelspace()
 if 'SVN_Diagram' not in doc.styles:doc.styles.new('SVN_Diagram',dxfattribs={'font':'arial.ttf','width':1.0})
 for name,col in [('СВН_СХЕМЫ',5),('СВН_ТВ_видимость_следующего',1),('СВН_Кронштейны_тепловизоров',6)]:
  if name not in doc.layers:doc.layers.new(name,dxfattribs={'color':col,'lineweight':40})
 # Remove previous thermal devices/labels and regeneration products; source TKK never touched.
 old_thermal=[e for e in m.query('INSERT') if e.dxf.layer=='СВН_Тепловизоры'];template=old_thermal[0].copy()
 clear={'СВН_Тепловизоры','СВН_Зоны_VCA_тепловизоры','СВН_Кронштейны_тепловизоров','СВН_Проверка_разрывы_ТВ','СВН_Проверка_разрывы_ВН','СВН_Труба_ПНД_к_шкафам'}
 for e in list(m):
  if e.dxf.layer in clear:m.delete_entity(e)
 for e in m.query('HATCH'):
  if e.dxf.layer.startswith('СВН_Зоны'):
   e.set_pattern_fill('ANSI31',color=e.dxf.color,angle=0,scale=4);e.transparency=0
 objects={k:dict(v) for k,v in G['objects'].items() if k.startswith('ВН')};sectors=[];next_checks=[];brackets=[]
 for j,(x,y) in enumerate(positions):
  nx,ny=positions[(j+1)%len(positions)];aim=math.degrees(math.atan2(ny-y,nx-x))%360;name=f'ТВ-08-{j+1:02d}'
  ent=template.copy();m.add_entity(ent);ent.dxf.insert=(x,y,0);ent.dxf.rotation=aim
  assert not fence.contains(Point(x,y))
  foot=nearest_points(boundary,Point(x,y))[0];distance=foot.distance(Point(x,y));brackets.append({'camera':name,'outreach_m':round(distance,3)})
  m.add_line((foot.x,foot.y),(x,y),dxfattribs={'layer':'СВН_Кронштейны_тепловизоров','color':6,'lineweight':40})
  m.add_circle((foot.x,foot.y),.25,dxfattribs={'layer':'СВН_Кронштейны_тепловизоров','color':6,'lineweight':40})
  vec=Point(x,y).distance(foot);ux=(x-foot.x)/vec;uy=(y-foot.y)/vec
  m.add_text(name,dxfattribs={'insert':(x+4*ux,y+4*uy),'height':1.35,'style':'Standard','layer':'СВН_Тепловизоры','lineweight':40})
  objects[name]={'x':x,'y':y,'rotation':aim,'layer':'СВН_Тепловизоры'}
  poly=sector_polygon(x,y,aim);assert not poly.is_empty
  # Guard: no thermal sector interior is allowed inside the fence.
  assert poly.intersection(fence.buffer(-.002)).area<.01
  add_sector(m,poly,'СВН_Зоны_VCA_тепловизоры',1);sectors.extend(list(poly.geoms) if hasattr(poly,'geoms') else [poly])
  sight=LineString([(x,y),(nx,ny)]);blocked=sight.intersection(fence.buffer(-.005)).length>.001
  next_checks.append({'camera':name,'next_camera':f'ТВ-08-{(j+1)%len(positions)+1:02d}','distance_m':round(sight.length,3),'blocked_by_fence_2d':blocked,'next_in_visible_sector':not blocked and sight.length<=105})
  if blocked:
   m.add_lwpolyline([(x,y),(nx,ny)],dxfattribs={'layer':'СВН_ТВ_видимость_следующего','color':1,'linetype':'DASHED','lineweight':40})
 # Nearest-capacity cabinet allocation. A proposal >88 physical cameras needs one additional node.
 cabs=json.loads(json.dumps(OLD['cabinet_groups']));fixed_names=sorted(n for n in objects if n.startswith('ВН'))
 def routes_for(cabs):
  s={n:boundary.project(Point(v['x'],v['y'])) for n,v in objects.items()};lat={n:boundary.distance(Point(v['x'],v['y'])) for n,v in objects.items()}
  def distance(c,n):
   a=c['anchor_camera'];delta=abs(s[a]-s[n]);return 0.0 if a==n else min(delta,L-delta)+lat[a]+lat[n]
  return distance
 def assignment(cabs):
  route=routes_for(cabs);names=sorted(objects);slots=[j for j in range(len(cabs)) for _ in range(8)]
  a,b=linear_sum_assignment([[route(cabs[j],n) for j in slots] for n in names]);assert len(a)==len(names)
  result=[(names[i],slots[k],route(cabs[slots[k]],names[i])) for i,k in zip(a,b)]
  return result
 if len(objects)>8*len(cabs):
  used={c['anchor_camera'] for c in cabs};options=[]
  for name in fixed_names:
   if name in used:continue
   v=objects[name];new={'id':'ШК-08-12','anchor_camera':name,'xy':[v['x'],v['y']],'camera_group':[],'thermal_group':[],'status':'ADDITIONAL PROPOSAL'}
   result=assignment(cabs+[new]);options.append((max(q[2] for q in result),sum(q[2] for q in result),name,new))
  best=min(options,key=lambda q:q[:3]);cabs.append(best[3])
  oldc=next(e for e in m.query('INSERT') if e.dxf.layer=='СВН_Шкафы_коммутационные');new=oldc.copy();m.add_entity(new);new.dxf.insert=(*best[3]['xy'],0)
  m.add_text('ШК-08-12*',dxfattribs={'insert':(best[3]['xy'][0]+4,best[3]['xy'][1]+4),'height':1.35,'style':'Standard','layer':'СВН_Шкафы_коммутационные','color':1})
 alloc=assignment(cabs)
 for c in cabs:c['camera_group']=[];c['thermal_group']=[]
 links=[]
 for name,j,length in alloc:
  c=cabs[j];c['camera_group' if name.startswith('ВН') else 'thermal_group'].append(name)
  links.append({'cabinet':c['id'],'device':name,'fence_route_estimate_m':round(length,2),'with_10pct_m':round(length*1.1,2),'long_range_review':length*1.1>100})
 # Build well register from real rendered block geometry, not insertion points with shifted block bases.
 well_labels=[]
 for e in m.query('MULTILEADER'):
  if e.dxf.layer!=TKK or not e.context or not e.context.mtext:continue
  label=strip_mtext(e.context.mtext.default_content)
  if not re.fullmatch(r'КК\s*\d+',label):continue
  for leader in e.context.leaders:
   for ln in leader.lines:
    if ln.vertices:well_labels.append((label,Point(ln.vertices[0].x,ln.vertices[0].y)))
 wells=[]
 for e in m.query('INSERT'):
  if e.dxf.layer==TKK and e.dxf.name in ('в0','ккс-20'):
   ext=bbox.extents([e]);p=Point(ext.center.x,ext.center.y)
   near=min(well_labels,key=lambda q:q[1].distance(p)) if well_labels else None
   label=near[0] if near and near[1].distance(p)<6 else 'проверить ID'
   wells.append({'point':p,'handle':e.dxf.handle,'block':e.dxf.name,'label':label})
 pnd=[]
 for c in cabs:
  target=Point(*c['xy']);well=min(wells,key=lambda v:v['point'].distance(target));p=well['point'];length=p.distance(target)
  m.add_lwpolyline([(p.x,p.y),(target.x,target.y)],dxfattribs={'layer':'СВН_Труба_ПНД_к_шкафам','color':2,'lineweight':40,'linetype':'DASHED'})
  label=f'{well["label"]} → {c["id"]}: {length:.1f} м*'
  m.add_text(label,dxfattribs={'insert':((p.x+target.x)/2,(p.y+target.y)/2+2),'height':1.4,'style':'Standard','layer':'СВН_Труба_ПНД_к_шкафам','color':2})
  pnd.append({'cabinet':c['id'],'well_handle':well['handle'],'well_id':well['label'],'well_block':well['block'],'straight_plan_m':round(length,2),'status':'Прямая плановая связь, трассу и ввод уточнить'})
 # Correct plan explanatory text and set viewport wide enough for all four western new wells.
 for lo in doc.layouts:
  if not lo.name.startswith('СВН-'):continue
  if lo.name.startswith('СВН-01'):
   for vp in lo.query('VIEWPORT'):
    if vp.dxf.id>1:vp.dxf.view_center_point=(5900,-10850);vp.dxf.view_height=1850;vp.frozen_layers=[]
  for e in list(lo):
   if e.dxftype() not in ('TEXT','MTEXT'):continue
   text=e.dxf.text if e.dxftype()=='TEXT' else e.text;new=text
   if any(t in new for t in ['195,98','195,99','в каждую сторону','17 узлов','17 пар']):new=f'{len(positions)} ТВ последовательно снаружи; вынос ~600 мм; VCA 105 м. Углы проверить.'
   if len(positions)!=34 and lo.name.startswith('СВН-05') and e.dxftype()=='TEXT' and abs(e.dxf.insert.y-253)<.5 and new.strip()=='11':new='12'
   new=re.sub(r'34 камеры / 17 пар[^\\]*',f'{len(positions)} ТВ в последовательной цепочке; направление к следующей точке',new)
   new=new.replace('34 двухспектральные камеры на 17 парных кронштейнах; шаг 195,99 м',f'{len(positions)} ТВ на индивидуальных выносных кронштейнах снаружи ограждения')
   new=new.replace('ТВ устанавливаются на кронштейнах, закреплённых непосредственно на ограждении.','ТВ устанавливаются снаружи на выносных кронштейнах к несущим стойкам ограждения.')
   new=new.replace('тепловизоры показаны парой на кронштейне ограждения.','тепловизоры показаны последовательно снаружи ограждения.')
   new=new.replace('17 парных','индивидуальных').replace('парный монтаж','индивидуальный вынос наружу').replace('34 тепловизора',f'{len(positions)} тепловизоров')
   if '105 м в каждом направлении' in new or 'около 14 м' in new or 'Перекрытие на прямой' in new:
    new=f'• {len(positions)} тепловизоров в однонаправленной цепочке снаружи ограждения.\\P• Вынос от плоскости — около 600 мм, на углах уточнить.\\P• Ось камеры направлена к следующему тепловизору.\\P• Дальность 105 м — исходное допущение; заслонение ограждением учтено в 2D.'
   if len(positions)!=34:
    new=new.replace('79 физических камер','92 физических камеры').replace('113 видеоканалов','139 видеоканалов').replace('11 шкафов','12 шкафов').replace('11 узловых шкафов','12 узловых шкафов')
    if new.strip()=='34':new='47'
    # Do not keep the v07 storage claim for the enlarged proposal.
    if '26,4' in new or '26.4' in new or '≥36' in new:new='Архив и лицензии: пересчитать для 139 видеоканалов; прежняя оценка v07 неприменима.'
   if new!=text:
    if e.dxftype()=='TEXT':e.dxf.text=new
    else:e.text=new
 make_structure(doc,directory,cabs,links,len(positions));make_mount(doc,directory);make_connection(doc,directory)
 # Explicit TKK detail sheet: original source annotations remain visible through a model viewport.
 detail=Sheet(doc,'СВН-07_ТКК','07 · Восстановленная ТКК: новые колодцы, номера и подписи трасс','СВН-07')
 detail.para(20,529,'Исходная сеть ТКК включена целиком, без фильтра по типам сущностей и без обрезки по окну. В том числе сохранены 4 новых блока ккс-20, все 107 MULTILEADER и 18 POLYLINE.',795,3.4)
 detail.p.add_viewport(center=(420,291),size=(790,415),view_center_point=(5225,-10560),view_height=375,status=2,dxfattribs={'layer':'СВН_ЛИСТЫ'})
 detail.rect(20,80,800,415,8,.3);detail.para(20,63,'Выноска, номер и подписанная длина сохранены из исправленного исходника. ПНД-подключения СВН — отдельные предварительные линии; исходную нумерацию ТКК не меняют.',790,2.8,8)
 # Write inventories and CSV before final save.
 for filename,rows in [('camera_links.csv',links),('thermal_chain.csv',next_checks),('pnd_branches.csv',pnd),('brackets.csv',brackets)]:
  with (directory/filename).open('w',encoding='utf-8-sig',newline='') as h:
   w=csv.DictWriter(h,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
 source_text=[]
 for e in m:
  if e.dxf.layer!=TKK:continue
  if e.dxftype() in ('TEXT','MTEXT','MULTILEADER'):
   text=e.dxf.text if e.dxftype()=='TEXT' else e.plain_text() if e.dxftype()=='MTEXT' else e.context.mtext.default_content if e.context and e.context.mtext else ''
   source_text.append({'source_handle':e.dxf.handle,'type':e.dxftype(),'text':text})
 with (directory/'tkk_source_annotations.csv').open('w',encoding='utf-8-sig',newline='') as h:
  w=csv.DictWriter(h,fieldnames=['source_handle','type','text']);w.writeheader();w.writerows(source_text)
 preaudit=doc.audit();assert not preaudit.errors
 # Original TKK entity payloads must remain identical after serialization.
 path=directory/f'CCTV_v09_{variant}.dxf';doc.saveas(path);check=ezdxf.readfile(path);saved=tkk_record(check)
 verify_tkk_blocks(check,TKK,source_blocks)
 missing=sorted(set(source_sig)-set(saved));changed=[h for h in source_sig.keys()&saved.keys() if source_sig[h]!=saved[h]]
 assert not missing and not changed,{'missing':missing,'changed':changed[:10]}
 assert not check.audit().errors
 hs=[e for e in check.modelspace().query('HATCH') if e.dxf.layer.startswith('СВН_Зоны')]
 assert hs and all(e.dxf.solid_fill==0 and abs(e.dxf.pattern_scale-4)<1e-8 for e in hs)
 assert len(links)==len(objects) and len({v['device'] for v in links})==len(objects)
 assert max(len(c['camera_group'])+len(c['thermal_group']) for c in cabs)<=8
 union=unary_union(sectors);band=fence.buffer(5).difference(fence)
 exterior5=LineString(fence.buffer(5,join_style=2).exterior.coords)
 summary={'variant':variant,'thermal_cameras':len(positions),'fixed_cameras':45,'physical_cameras':len(objects),'video_channels':45+2*len(positions),'cabinets':len(cabs),'all_next_visible_2d':all(v['next_in_visible_sector'] for v in next_checks),'blocked_next_links':sum(v['blocked_by_fence_2d'] for v in next_checks),'max_next_distance_m':max(v['distance_m'] for v in next_checks),'max_connection_estimate_m':max(v['fence_route_estimate_m'] for v in links),'long_range_review_links':sum(v['long_range_review'] for v in links),'hatch_pattern':'ANSI31','hatch_scale':4,'all_sector_hatches_patterned':True,'source_TKK_counts':dict(source_count),'tkk_entities_preserved_identically':len(saved),'tkk_missing':missing,'tkk_changed':changed,'source_new_well_blocks':4,'source_insert_base_warning':'Well positions resolved from transformed block geometry, never raw INSERT point.','exterior_strip_0_5m_geometric_area_coverage_pct':round(union.intersection(band).area/band.area*100,2),'exterior_5m_offset_line_coverage_pct':round(union.intersection(exterior5).length/exterior5.length*100,2),'dxf_audit_errors':0,'cabinet_groups':cabs,'brackets':brackets,'notes':['Thermal aim points to next station, all mounts outside fence; 2D rays stop at fence.','600 mm outreach is provisional; corner miter points may require longer bracket or two-face mounting.','Original corrected TKK source is preserved with identical DXF entity tags after save/read.','Existing optical-ring and sensor lines retained; power/PoE and actual duct paths still require design confirmation.','The 47-camera variant is an unapproved proposal with one additional cabinet; archive, licenses and quantities need approval/recalculation.','No claim of full exterior-area coverage, performance, installation height or structural adequacy.']}
 (directory/'review.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
 fixed_polys=[Polygon(list(e.get_points('xy'))) for e in check.modelspace().query('LWPOLYLINE') if e.dxf.layer=='СВН_Зоны_обзора_фикс' and e.closed]
 model_preview(check,positions,{'thermal':sectors,'fixed':fixed_polys},directory)
 print(json.dumps({k:summary[k] for k in ['variant','thermal_cameras','cabinets','all_next_visible_2d','blocked_next_links','max_next_distance_m','tkk_entities_preserved_identically','exterior_strip_0_5m_geometric_area_coverage_pct','dxf_audit_errors']},ensure_ascii=False),flush=True)
 return summary

if __name__=='__main__':
 a=build(BASE,'34_chain');b=build([tuple(p) for p in CAND['positions']],'47_corner_proposal')
 (OUT/'comparison.json').write_text(json.dumps([a,b],ensure_ascii=False,indent=2),encoding='utf-8')

