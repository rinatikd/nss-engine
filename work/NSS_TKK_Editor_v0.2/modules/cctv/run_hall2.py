import sys, io, contextlib, math, json, numpy as np
sys.path.insert(0,"/home/claude/cctv")
with contextlib.redirect_stdout(io.StringIO()):
    exec(open("run_rooms.py").read().split("# контуры в DXF")[0])
import axes
from scipy.ndimage import distance_transform_edt
M=np.zeros_like(lab,bool)
for z in out:
    if abs(z["area_label"]-81.2)<.1 or abs(z["area_label"]-46.06)<.1: M|=z["mask"]
ix=int((79698-rooms.X0)/50); iy=int((-194083-rooms.Y0)/50); ln=lab[iy,ix]
print("метка северной части:",ln,"big:",big)
if ln and ln!=big: M|=(lab==ln)
else:
    from scipy.ndimage import binary_closing as bc
    box=np.zeros_like(M); X,Y=np.meshgrid(Xc0:=rooms.X0+(np.arange(M.shape[1])+.5)*50, rooms.Y0+(np.arange(M.shape[0])+.5)*50)
    M|=(X>74700)&(X<85500)&(Y>-196650)&(Y<-192300)
tot=M.sum(); cell=rooms.CELL**2/1e6
print("зал целиком, м²:",round(tot*cell,1))
Xc=rooms.X0+(np.arange(nx)+.5)*rooms.CELL; Yc=rooms.Y0+(np.arange(ny)+.5)*rooms.CELL
def cov(poly): return mask_of(poly)&M
base_r=np.zeros_like(M); base_o=np.zeros_like(M)
for k,ox,oy,po,pr in draw:
    if k in("1.14","1.15"): base_r|=cov(pr); base_o|=cov(po)
print("существующие ВН-1.14+1.15: Observe %.0f%%, Recognize %.0f%%"%(base_o.sum()/tot*100,base_r.sum()/tot*100))
ys,xs=np.where(M); x0,x1=rooms.X0+xs.min()*50,rooms.X0+xs.max()*50; y0,y1=rooms.Y0+ys.min()*50,rooms.Y0+ys.max()*50
print("габариты, м: %.1f × %.1f"%((x1-x0)/1000,(y1-y0)/1000))
near=[w for w in walls if x0-1500<max(w[0][0],w[1][0]) and min(w[0][0],w[1][0])<x1+1500 and y0-1500<max(w[0][1],w[1][1]) and min(w[0][1],w[1][1])<y1+1500]
dt=distance_transform_edt(M)*rooms.CELL
ring=np.argwhere(M&(dt>220)&(dt<330)); cand=[]
for iy,ix in ring:
    p=(rooms.X0+(ix+.5)*50,rooms.Y0+(iy+.5)*50)
    if all(math.dist(p,q)>900 for q in cand): cand.append(p)
cx,cy=(x0+x1)/2,(y0+y1)/2; res=[]
for p in cand:
    a0=math.degrees(math.atan2(cy-p[1],cx-p[0]))
    for da in(-45,-22,0,22,45):
        ang=a0+da
        mr=cov(cc.visibility_polygon(p,ang,99,11000,near,rays=90)); mo=cov(cc.visibility_polygon(p,ang,99,23000,near,rays=90))
        res.append(((base_r|mr).sum()/tot,(base_o|mo).sum()/tot,p,ang,mr,mo))
res.sort(key=lambda r:-(r[0]+.3*r[1])); b=res[0]
print("+1 камера: Recognize %.0f%%, Observe %.0f%%"%(b[0]*100,b[1]*100),axes.ref(*b[2]),"напр.",round(b[3]%360),axes.compass(b[3]))
for r in res[1:200]:
    if math.dist(r[2],b[2])>3000: print("альтернатива: Recognize %.0f%%"%(r[0]*100),axes.ref(*r[2]),round(r[3]%360),axes.compass(r[3])); break
json.dump({"x":b[2][0],"y":b[2][1],"dir":b[3]%360,"rec":b[0],"obs":b[1],"ref":axes.ref(*b[2])},open("demo/hall_cam.json","w"),ensure_ascii=False)
import matplotlib.pyplot as plt
fig,ax=plt.subplots(figsize=(11,10))
for a,c in near: ax.plot([a[0],c[0]],[a[1],c[1]],color="#444",lw=.7)
ax.contourf(Xc,Yc,M.astype(float),[.5,1.5],colors=["#dddddd"])
ax.contourf(Xc,Yc,base_r.astype(float),[.5,1.5],colors=["#3366dd"],alpha=.5)
ax.contourf(Xc,Yc,(b[4]&~base_r).astype(float),[.5,1.5],colors=["#ff9900"],alpha=.6)
ax.plot(b[2][0],b[2][1],"r^",ms=11)
for k,ox,oy,po,pr in draw:
    if k in("1.14","1.15"): ax.plot(ox,oy,"b^",ms=9)
ax.set_aspect("equal"); ax.set_xlim(x0-1000,x1+1000); ax.set_ylim(y0-1000,y1+1000)
ax.set_title("Актовый зал: синий — Recognize от ВН-1.14/1.15; оранжевый — добавит новая камера (красный ▲)")
fig.savefig("demo/hall_proposal.png",dpi=90,bbox_inches="tight")

# две картинки: вариант А (лучший) и вариант Б (альтернатива)
alt=[r for r in res[1:] if math.dist(r[2],b[2])>3000][0]
for tag,r in (("A",b),("B",alt)):
    fig,ax=plt.subplots(figsize=(11,10))
    for a,c in near: ax.plot([a[0],c[0]],[a[1],c[1]],color="#444",lw=.7)
    ax.contourf(Xc,Yc,M.astype(float),[.5,1.5],colors=["#dddddd"])
    ax.contourf(Xc,Yc,base_r.astype(float),[.5,1.5],colors=["#3366dd"],alpha=.5)
    ax.contourf(Xc,Yc,(r[4]&~base_r).astype(float),[.5,1.5],colors=["#ff9900"],alpha=.6)
    for k,ox,oy,po,pr in draw:
        if k in("1.14","1.15"): ax.plot(ox,oy,"b^",ms=9); ax.annotate("ВН-"+k,(ox,oy),xytext=(5,8),textcoords="offset points")
    ax.plot(r[2][0],r[2][1],"r^",ms=12); ax.annotate("НОВАЯ",(r[2][0],r[2][1]),xytext=(8,-14),textcoords="offset points",color="red",weight="bold")
    ax.set_aspect("equal"); ax.set_xlim(x0-1000,x1+1000); ax.set_ylim(y0-1000,y1+1000)
    ax.set_title("Вариант %s: %s, напр. %s (%d°)\nRecognize %.0f%%, Observe %.0f%%. Синий — уже закрыто ВН-1.14/1.15, оранжевый — добавит новая"%(tag,axes.ref(*r[2]),axes.compass(r[3]),round(r[3]%360),r[0]*100,r[1]*100),fontsize=10)
    fig.savefig("demo/hall_variant_%s.png"%tag,dpi=90,bbox_inches="tight")

# текущее состояние: только ВН-1.14 и ВН-1.15 (Recognize синий, Observe зелёный)
fig,ax=plt.subplots(figsize=(11,10))
for a,c in near: ax.plot([a[0],c[0]],[a[1],c[1]],color="#444",lw=.7)
ax.contourf(Xc,Yc,M.astype(float),[.5,1.5],colors=["#dddddd"])
ax.contourf(Xc,Yc,base_o.astype(float),[.5,1.5],colors=["#66cc66"],alpha=.6)
ax.contourf(Xc,Yc,base_r.astype(float),[.5,1.5],colors=["#3366dd"],alpha=.6)
for k,ox,oy,po,pr in draw:
    if k in("1.14","1.15"): ax.plot(ox,oy,"b^",ms=9); ax.annotate("ВН-"+k,(ox,oy),xytext=(5,8),textcoords="offset points")
ax.set_aspect("equal"); ax.set_xlim(x0-1000,x1+1000); ax.set_ylim(y0-1000,y1+1000)
ax.set_title("Без новых камер: только ВН-1.14 и ВН-1.15\nRecognize %.0f%% (синий), Observe %.0f%% (зелёный — только Observe), серый — не просматривается"%(base_r.sum()/tot*100,base_o.sum()/tot*100),fontsize=10)
fig.savefig("demo/hall_current.png",dpi=90,bbox_inches="tight")
