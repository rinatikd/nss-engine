from pathlib import Path
import ezdxf,json
root=Path(__file__).resolve().parents[1];p=root/'work'/'CCTV_Source_v06.dxf'
d=ezdxf.readfile(p);changes=[]
repls=[
 ('172 видеоканала + ресурсы КПП/домофонии по ведомости','154 видеоканала + ресурсы КПП/домофонии по ведомости'),
 ('Концепция без КПП: 134 физических камеры, 172 канала','Концепция без КПП: 120 физических камер, 154 канала'),
 ('ориентир 35,4 ТБ raw','ориентир 35,9 ТБ raw'),
 ('35,4 ТБ raw','35,9 ТБ raw'),
 ('78 наружных фиксированных + 4 купольных + 4 PTZ','78 фиксированных/дорожных + 4 купольных + 4 PTZ'),
]
for lo in d.layouts:
 for e in lo:
  if e.dxftype()=='TEXT':s=e.dxf.text
  elif e.dxftype()=='MTEXT':s=e.text
  else:continue
  old=s
  for a,b in repls:s=s.replace(a,b)
  if s!=old:
   if e.dxftype()=='TEXT':e.dxf.text=s
   else:e.text=s
   changes.append({'layout':lo.name,'old':old[:100],'new':s[:100]})
audit=d.audit()
if audit.errors:raise RuntimeError(f'audit errors {len(audit.errors)}')
d.saveas(p)
check=ezdxf.readfile(p);issues=[]
for lo in check.layouts:
 if not ('01_' in lo.name or '05_' in lo.name or '06_' in lo.name):continue
 for e in lo:
  s=e.dxf.text if e.dxftype()=='TEXT' else e.text if e.dxftype()=='MTEXT' else ''
  if any(v in s for v in ('172 видеоканала','134 физических камеры','35,4 ТБ raw')):issues.append(s[:160])
rep=json.loads((root/'work'/'cctv_v06_build_report.json').read_text(encoding='utf-8'));rep['paper_text_corrections']=len(changes);rep['stale_total_notes']=issues
(root/'work'/'cctv_v06_build_report.json').write_text(json.dumps(rep,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'paper_changes':len(changes),'stale_notes':len(issues),'audit_errors':len(check.audit().errors)},ensure_ascii=False))
