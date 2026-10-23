import sys, io, contextlib
sys.path.insert(0,"/home/claude/cctv")
with contextlib.redirect_stdout(io.StringIO()):
    exec(open("run_rooms.py").read().split("# контуры в DXF")[0])
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(13,10))
for a,b in walls:
    if 72000<a[0]<92000 and -206500<a[1]<-190000: ax.plot([a[0],b[0]],[a[1],b[1]],color="#444",lw=.7)
for a,b in cc.read_walls(rooms.SRC,["СТЕНЫ НАРУЖНЫЕ"]):
    if abs(a[1]+196507)<20 and abs(b[1]+196507)<20 and abs(a[0]-b[0])>10000: ax.plot([a[0],b[0]],[a[1],b[1]],color="red",lw=2,ls="--")
for k,ox,oy,po,pr in draw:
    if k in ("1.7","1.14","1.15","1.16"):
        import numpy as np; p=np.array(pr); ax.fill(p[:,0],p[:,1],alpha=.18); ax.plot(ox,oy,"^",ms=9); ax.annotate("ВН-"+k,(ox,oy))
for a,x,y,n in labels:
    if 72000<x<92000 and -206000<y<-190000: ax.annotate("%.1f м²"%a,(x,y),color="blue",fontsize=11)
ax.set_xlim(72000,92000); ax.set_ylim(-206500,-190000); ax.set_aspect("equal")
ax.set_title("Красный пунктир — исключённая линия y≈-196,5 м (граница эстрады?)")
fig.savefig("demo/hall_overview.png",dpi=90,bbox_inches="tight")
