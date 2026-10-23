import sys, io, contextlib, numpy as np
sys.path.insert(0,"/home/claude/cctv")
with contextlib.redirect_stdout(io.StringIO()):
    exec(open("run_rooms.py").read().split("# контуры в DXF")[0])
for z in out:
    if abs(z["area_label"]-81.2)<0.1:
        m=z["mask"]; ys,xs=np.where(m)
        print("z4 контур м²",round(z["area"],1),"x",rooms.X0+xs.min()*50,rooms.X0+xs.max()*50,"y",rooms.Y0+ys.min()*50,rooms.Y0+ys.max()*50)
