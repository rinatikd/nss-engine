from pathlib import Path
p=Path('work/build_cctv_package_v06.py')
s=p.read_text(encoding='utf-8')
try:
 fixed=s.encode('cp1251',errors='replace').decode('utf-8')
 print(repr(s.splitlines()[9][:50]))
 print(repr(fixed.splitlines()[9][:50]))
 p.write_text(fixed,encoding='utf-8')
except Exception as e: print(type(e).__name__,e)
