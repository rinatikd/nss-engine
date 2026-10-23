# вспомогательное: INSERT-блоки слоя КАМЕРА из ASCII DXF
def inserts(path):
    f = open(path, encoding="utf-8", errors="replace"); sec = None; pend = False; rec = None
    while True:
        c = f.readline()
        if not c: break
        v = f.readline().rstrip("\r\n"); c = c.strip()
        if c == "0":
            if rec and sec == "ENTITIES" and rec[0][1] == "INSERT":
                d = {}
                for k, x in rec[1:]: d.setdefault(k, x)
                if d.get("8") == "КАМЕРА": yield d
            rec = None
            if v == "SECTION": pend = True
            elif v == "ENDSEC": sec = None
            elif sec == "ENTITIES": rec = [(c, v)]
            continue
        if pend and c == "2": sec = v; pend = False; continue
        if rec is not None: rec.append((c, v))

