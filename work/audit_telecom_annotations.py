import json, math, re
from pathlib import Path
import ezdxf

ROOT = Path(__file__).resolve().parents[1]
DXF = ROOT / 'ГП_Виллы_12.10.26 для СС_с_телефонной_канализацией.dxf'
LAYER = '\u0422\u0415\u041b\u0415\u0424\u041e\u041d\u041d\u0410\u042f_\u041a\u0410\u0411\u0415\u041b\u042c\u041d\u0410\u042f_\u041a\u0410\u041d\u0410\u041b\u0418\u0417\u0410\u0426\u0418\u042f'

doc = ezdxf.readfile(DXF)
msp = doc.modelspace()
def xy(p): return (float(p[0]), float(p[1]))
def dist(a,b): return math.hypot(a[0]-b[0],a[1]-b[1])
def is_tele(e): return e.dxf.layer == LAYER

# Number callouts: the last leader vertex is the well's arrow anchor.
nodes = {}
special = []
for e in msp.query('MULTILEADER'):
    if not is_tele(e): continue
    try:
        content = e.context.mtext.default_content
        pts = e.context.leaders[0].lines[0].vertices
        p = xy(pts[-1])
    except Exception:
        continue
    m = re.search(r'КК\s*-?\s*(\d+)', content, re.I)
    if m: nodes[int(m.group(1))] = p
    else: special.append({'content':content,'anchor':p})

# Extract route geometry, project well anchors to it and create consecutive spans.
paths=[]
for e in msp:
    if not is_tele(e) or e.dxftype() not in ('LINE','LWPOLYLINE'): continue
    if e.dxftype() == 'LINE': pts=[xy(e.dxf.start),xy(e.dxf.end)]
    else: pts=[xy(p) for p in e.get_points('xy')]
    if len(pts)<2: continue
    segs=[]; station=0.0
    for a,b in zip(pts,pts[1:]):
        ln=dist(a,b)
        if ln>1e-7: segs.append((a,b,station,ln)); station+=ln
    if station>0.2: paths.append((e.dxf.handle,e.dxftype(),segs,station))

edges=[]
for handle,kind,segs,total in paths:
    hits=[]
    for n,p in nodes.items():
        best=None
        for a,b,s,l in segs:
            t=max(0,min(1,((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]))/(l*l)))
            q=(a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]))
            d=dist(p,q)
            if best is None or d<best[0]: best=(d,s+t*l,q,s+t*l)
        if best and best[0]<0.05: hits.append((best[1],n,p))
    hits.sort()
    ded=[]
    for h in hits:
        if not ded or h[1]!=ded[-1][1]: ded.append(h)
    for (s1,n1,p1),(s2,n2,p2) in zip(ded,ded[1:]):
        if s2-s1<0.25: continue
        midstation=(s1+s2)/2
        for a,b,s,l in segs:
            if s-1e-8<=midstation<=s+l+1e-8:
                t=(midstation-s)/l
                mid=(a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1]));break
        edges.append({'path':handle,'a':n1,'b':n2,'length':s2-s1,'mid':mid,'p1':p1,'p2':p2})

texts=[]
for e in msp.query('MTEXT'):
    if not is_tele(e): continue
    raw=e.text
    p=xy(e.dxf.insert)
    cm=re.search(r'0\s*/\s*\d+',raw)
    lm=re.search(r'L\s*=\s*[\d,.]+\s*м',raw,re.I)
    if cm or lm: texts.append({'handle':e.dxf.handle,'raw':raw,'kind':'count' if cm else 'length','value':cm.group(0) if cm else lm.group(0),'p':p})

def assign(kind):
    candidates=[t for t in texts if t['kind']==kind]
    pairs=[]
    for ed in edges:
        for t in candidates:
            pairs.append((dist(ed['mid'],t['p']),ed,t))
    used_e=set();used_t=set(); assigned=[]
    for d,ed,t in sorted(pairs,key=lambda x:x[0]):
        ek=(ed['path'],ed['a'],ed['b']);tk=t['handle']
        if ek in used_e or tk in used_t: continue
        if d>20: continue
        used_e.add(ek);used_t.add(tk)
        assigned.append({'path':ed['path'],'a':ed['a'],'b':ed['b'],'dist':d,'handle':tk,'value':t['value'],'at':t['p']})
    return assigned

ac=assign('count'); al=assign('length')
allkeys={(e['path'],e['a'],e['b']) for e in edges}
ck={(e['path'],e['a'],e['b']) for e in ac}; lk={(e['path'],e['a'],e['b']) for e in al}
sym=[]
for e in msp.query('INSERT'):
    if not is_tele(e): continue
    try:
        for v in e.virtual_entities():
            if v.dxftype()=='CIRCLE': sym.append({'insert':e.dxf.handle,'name':e.dxf.name,'center':xy(v.dxf.center),'radius':v.dxf.radius})
    except Exception: pass
missing_symbols=[]
for n,p in sorted(nodes.items()):
    d=min((dist(p,s['center']) for s in sym),default=1e9)
    if d>0.05: missing_symbols.append({'well':n,'anchor':p,'nearest_symbol_m':d})

out={'dxf':str(DXF),'layer':LAYER,'numbered_wells':len(nodes),'special_callouts':special,'route_edges':len(edges),'edges':edges,'count_labels':len(ac),'length_labels':len(al),'counts_assigned':ac,'lengths_assigned':al,'edges_missing_count':[e for e in edges if (e['path'],e['a'],e['b']) not in ck],'edges_missing_length':[e for e in edges if (e['path'],e['a'],e['b']) not in lk],'circle_symbols':len(sym),'missing_symbols':missing_symbols}
path=ROOT/'work/telecom_annotation_audit.json'
path.write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'wells':len(nodes),'edges':len(edges),'count_labels':len(ac),'length_labels':len(al),'edges_missing_count':len(out['edges_missing_count']),'edges_missing_length':len(out['edges_missing_length']),'circle_symbols':len(sym),'missing_symbols':len(missing_symbols),'report':str(path)},ensure_ascii=False,indent=2))
