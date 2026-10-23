import sys, numpy as np
sys.path.insert(0,"/home/claude/cctv")
exec(open("run_hall.py").read().split("walls = obstacles.get()")[0])   # mask, lab и т.д.
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    import run_sadik2 as r2
ny, nx = mask.shape
Xc = rooms.X0 + (np.arange(nx)+.5)*rooms.CELL; Yc = rooms.Y0 + (np.arange(ny)+.5)*rooms.CELL
XX,YY = np.meshgrid(Xc,Yc); pts=np.column_stack([XX.ravel(),YY.ravel()])
tot=mask.sum()
U=np.zeros_like(mask)
for k,ox,oy,po,pr in r2.draw:
    if k in ("1.14","1.15"):
        p=Path(pr); m=p.contains_points(pts).reshape(ny,nx)&mask; U|=m
        print(k, round(ox), round(oy), "Recognize %.0f%%"%(m.sum()/tot*100))
print("объединение Recognize %.0f%%"%(U.sum()/tot*100))
