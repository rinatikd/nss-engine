import sys, json, math, numpy as np
sys.path.insert(0,'/home/claude/cctv')
import cctv_core as cc
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from matplotlib.path import Path
E=json.load(open('demo/site_ents.json'))
fence=[o for o in E if o["l"]=="1 ограждение"][0]["v"]
FP=Path(fence)
# препятствия: полилинии слоя 0 и линии внутри участка (здания)
segs=[]
def add(pts,closed):
    for i in range(len(pts)-1): segs.append((tuple(pts[i]),tuple(pts[i+1])))
    if closed: segs.append((tuple(pts[-1]),tuple(pts[0])))
for o in E:
    if o["l"]=="0":
        if o["t"]=="LWPOLYLINE" and all(FP.contains_point(v) for v in o["v"]): add(o["v"],o["closed"])
        elif o["t"]=="LINE" and FP.contains_point((o["x"],o["y"])): segs.append(((o["x"],o["y"]),(o["x2"],o["y2"])))
print("препятствий внутри участка:",len(segs))
# периметр: точки каждые 1 м
per=[]
for i in range(len(fence)-1):
    a,b=np.array(fence[i]),np.array(fence[i+1]); L=np.linalg.norm(b-a)
    for t in np.arange(0,L,1000): per.append(tuple(a+(b-a)*t/L))
per=np.array(per); print("длина ограждения, м:",round(len(per)),"точек")
HF,OBS,REC=103,26000,13000   # DS-2CD2043G2-I по даташиту
# существующие камеры (по уголкам: прямой угол = положение, биссектриса = направление)
cams={}
for o in E:
    if o["l"]=="КАМЕРА" and len(o["v"])==3:
        P=[np.array(v) for v in o["v"]]
        d=[(np.dot(P[(i+1)%3]-P[i],P[(i+2)%3]-P[i]),i) for i in range(3)]
        i=min(d,key=lambda t:abs(t[0]))[1]; c=P[i]; u=(P[(i+1)%3]-c)/np.linalg.norm(P[(i+1)%3]-c)+(P[(i+2)%3]-c)/np.linalg.norm(P[(i+2)%3]-c)
        cams[len(cams)]=(tuple(c),math.degrees(math.atan2(u[1],u[0]))%360)
names={}
lab=[(o["txt"],o["x"],o["y"]) for o in E if o["t"] in("TEXT","MTEXT") and o["txt"] and o["txt"].startswith("ВН")]
for k,(c,a) in cams.items():
    free=[l for l in lab if l[0] not in names.values()] or lab
    n=min(free,key=lambda l:math.dist(c,(l[1],l[2])))[0]; names[k]=n; print(n,[round(v) for v in c],round(a))
def cover_pts(pos,ang,R,pts):
    poly=cc.visibility_polygon(pos,ang,HF,R,segs,rays=120)
    return Path(poly).contains_points(pts)
def cov(camlist,R):
    m=np.zeros(len(per),bool)
    for pos,ang in camlist: m|=cover_pts(pos,ang,R,per)
    return m
ex=list(cams.values())
mo,mr=cov(ex,OBS),cov(ex,REC)
print("существующие: периметр Observe %.0f%%, Recognize %.0f%%"%(mo.mean()*100,mr.mean()*100))
# кандидаты: на ограждении, сдвиг внутрь 0,5 м, шаг 4 м, 16 направлений; цель — Recognize по периметру на 13 м (ворота/калитка) — основная метрика Observe
inner=[]
for i in range(len(fence)-1):
    a,b=np.array(fence[i]),np.array(fence[i+1]); L=np.linalg.norm(b-a); 
    for t in np.arange(0,L,4000):
        p=a+(b-a)*t/L; n=np.array([-(b-a)[1],(b-a)[0]])/L
        for s in(500,-500):
            q=p+n*s
            if FP.contains_point(q): inner.append(tuple(q))
cand=[(p,ang) for p in inner for ang in range(0,360,20)]
print("кандидатов:",len(cand))
def greedy(base,R,target=.97,maxn=10):
    cur=base.copy(); chosen=[]
    cache={}
    while cur.mean()<target and len(chosen)<maxn:
        best=None
        for c in cand:
            if c not in cache: cache[c]=cover_pts(c[0],c[1],R,per)
            g=(cache[c]&~cur).sum()
            if best is None or g>best[0]: best=(g,c)
        if best[0]<3: break
        chosen.append(best[1]); cur|=cache[best[1]]
    return chosen,cur
chosen,cur=greedy(mo,OBS)
mr2=mr.copy()
for c in chosen: mr2|=cover_pts(c[0],c[1],REC,per)
print("Recognize по периметру после добавления: %.0f%%"%(mr2.mean()*100))
print("добавлено камер для Observe по периметру:",len(chosen),"-> %.0f%%"%(cur.mean()*100))
for c,a in chosen: print([round(v) for v in c],round(a))
json.dump({"existing":[(names[k],c,a) for k,(c,a) in cams.items()],"added":chosen,"obs_before":mo.mean(),"rec_before":mr.mean(),"obs_after":cur.mean()},open("demo/site_plan.json","w"),ensure_ascii=False)
# рисунок
fig,ax=plt.subplots(figsize=(15,10))
for a,b in segs: ax.plot([a[0],b[0]],[a[1],b[1]],color="#555",lw=.7)
ax.plot([p[0] for p in fence],[p[1] for p in fence],color="green",lw=2)
ax.scatter(per[:,0],per[:,1],c=np.where(cur,"#2a9d2a",np.where(mo,"#2a9d2a","#dd2222")),s=8,zorder=3)
for pos,ang in ex+chosen:
    pass
for tag,lst,colr in (("сущ.",ex,"blue"),("нов.",chosen,"red")):
    for pos,ang in lst:
        poly=np.array(cc.visibility_polygon(pos,ang,HF,OBS,segs,rays=120)); ax.fill(poly[:,0],poly[:,1],color=colr,alpha=.08)
        ax.plot(pos[0],pos[1],"^",color=colr,ms=10)
ax.set_aspect("equal"); ax.set_xlim(360000,410000); ax.set_ylim(-75000,-35000)
ax.set_title("Периметр: зелёные точки — в зоне Observe (26 м), красные — не просматриваются.\nСиние ▲ — существующие ВН-3.1/3.2/3.4/1.19, красные ▲ — предлагаемые добавочные")
fig.savefig("demo/site_proposal.png",dpi=85,bbox_inches="tight")
