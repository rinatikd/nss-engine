import sys, json, collections
sys.path.insert(0,'/home/claude/cctv')
BOX=(300000,430000,-130000,10000)
def parse(path):
    f=open(path,encoding='utf-8',errors='replace'); rec=None;sec=None;pend=False
    def ent(rec):
        t=rec[0][1]; d={};vx=[]
        for k,x in rec[1:]:
            if k=="10" and t=="LWPOLYLINE": vx.append([float(x),None])
            elif k=="20" and t=="LWPOLYLINE" and vx and vx[-1][1] is None: vx[-1][1]=float(x)
            else: d.setdefault(k,x)
        return t,d,vx
    while True:
        c=f.readline()
        if not c:break
        v=f.readline().rstrip("\r\n");c=c.strip()
        if c=="0":
            if rec and sec=="ENTITIES" and rec[0][1] in("LINE","LWPOLYLINE","CIRCLE","ARC","TEXT","MTEXT","INSERT","SOLID"):
                yield ent(rec)
            rec=None
            if v=="SECTION":pend=True
            elif v=="ENDSEC":sec=None
            elif sec=="ENTITIES":rec=[(c,v)]
            continue
        if pend and c=="2":sec=v;pend=False;continue
        if rec is not None:rec.append((c,v))
out=[]
for t,d,vx in parse('/home/claude/in/x/Садик СС.dxf'):
    try:
        if t=="LWPOLYLINE":
            if not vx or vx[0][1] is None: continue
            x,y=vx[0]
            if not(BOX[0]<x<BOX[1] and BOX[2]<y<BOX[3]):continue
            out.append({"t":t,"l":d.get("8"),"v":vx,"closed":int(d.get("70","0"))&1})
        else:
            x,y=float(d["10"]),float(d["20"])
            if not(BOX[0]<x<BOX[1] and BOX[2]<y<BOX[3]):continue
            o={"t":t,"l":d.get("8"),"x":x,"y":y,"txt":d.get("1"),"name":d.get("2"),"r":d.get("40"),"rot":d.get("50")}
            if t=="LINE": o["x2"]=float(d["11"]);o["y2"]=float(d["21"])
            out.append(o)
    except KeyError: pass
json.dump(out,open('/home/claude/cctv/demo/site_ents.json','w'),ensure_ascii=False)
print(len(out), collections.Counter(o["l"] for o in out).most_common(40))
