#!/usr/bin/env python3
"""Лёгкая выжимка из большого ASCII DXF: оставляет только нужные слои.
Запуск:  python extract_light.py big.dxf light.dxf                 -> только список слоёв (статистика), без записи
         python extract_light.py big.dxf light.dxf --layers "СЛОЙ1,СЛОЙ2"   -> копия сущностей этих слоёв
Статистика (слои, число объектов, типы, имена блоков) печатается всегда и сохраняется в light.dxf.txt.
Потоковая обработка: 48 МБ читаются построчно, память почти не расходуется."""
import sys, argparse, collections

ap = argparse.ArgumentParser()
ap.add_argument("src"); ap.add_argument("dst")
ap.add_argument("--layers", default="")
ap.add_argument("--encoding", default="cp1251", help="cp1251 для R2004-; utf-8 для R2007+")
a = ap.parse_args()
want = {x.strip().upper() for x in a.layers.split(",") if x.strip()}

def read_pairs(path, enc):
    with open(path, "r", encoding=enc, errors="replace") as f:
        while True:
            c = f.readline()
            if not c:
                return
            v = f.readline()
            yield c.strip(), v.rstrip("\r\n")

stats = collections.defaultdict(collections.Counter)  # layer -> type -> n
blocks = collections.Counter()
SUB = ("VERTEX", "SEQEND", "ATTRIB")
out = []            # список сохраняемых записей (каждая — список пар)
section = None
pending_sec = False
rec = None          # текущая запись [(code,val),...]
rec_type = None
rec_layer = "0"
keep_main = False   # сохраняем ли последнюю основную сущность (для её VERTEX/ATTRIB/SEQEND)

def flush():
    global rec, rec_type, rec_layer, keep_main
    if rec is not None and section == "ENTITIES":
        if rec_type not in SUB:
            stats[rec_layer.upper()][rec_type] += 1
            keep_main = bool(want) and rec_layer.upper() in want
            if keep_main:
                out.append(rec)
        elif keep_main:
            out.append(rec)
    rec = None; rec_type = None; rec_layer = "0"

for code, val in read_pairs(a.src, a.encoding):
    if code == "0":
        flush()
        if val == "SECTION":
            pending_sec = True
        elif val == "ENDSEC":
            section = None
        if section == "ENTITIES" and val not in ("SECTION", "ENDSEC"):
            rec = [(code, val)]; rec_type = val
        continue
    if pending_sec and code == "2":
        section = val; pending_sec = False
        continue
    if rec is not None:
        rec.append((code, val))
        if code == "8" and rec_type not in SUB:
            rec_layer = val
        if code == "2" and rec_type == "INSERT":
            blocks[val] += 1
flush()
lines = ["Слои и типы объектов (ENTITIES):"]
for layer, c in sorted(stats.items(), key=lambda kv: -sum(kv[1].values())):
    lines.append(f"  {layer}: {sum(c.values())}  " + ", ".join(f"{k}={v}" for k, v in c.most_common(6)))
lines.append("Блоки (INSERT), топ-40:")
for n, k in blocks.most_common(40):
    lines.append(f"  {n}: {k}")
txt = "\n".join(lines)
print(txt)
open(a.dst + ".txt", "w", encoding="utf-8").write(txt + "\n")

if want:
    layer_names = sorted(want)
    with open(a.dst, "w", encoding="utf-8") as f:
        f.write("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n")
        f.write("0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n%d\n" % len(layer_names))
        for n in layer_names:
            f.write(f"0\nLAYER\n2\n{n}\n70\n0\n62\n7\n6\nCONTINUOUS\n")
        f.write("0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n")
        for ent in out:
            for c, v in ent:
                if c in ("5", "330", "100", "102", "105"):  # хэндлы/подклассы не нужны для R12
                    continue
                f.write(f"{c}\n{v}\n")
        f.write("0\nENDSEC\n0\nEOF\n")
    print(f"\nЗаписано: {a.dst}")
