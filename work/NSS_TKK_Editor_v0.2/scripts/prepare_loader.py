"""Make a loader for this extracted folder without changing AutoCAD security settings."""
from pathlib import Path

root = Path(__file__).resolve().parents[1]
dll = root / 'plugin/NssTkkEditor.V002.dll'
for required in (dll, root/'engine/tkk_editor_core.py', root/'runtime/python.exe', root/'protected_numbers.json'):
    if not required.is_file():
        raise SystemExit(f'Missing package file: {required}')
lisp = '''(cond
  ((member "NSS_TKK_EDITOR_ENABLE_V001" (atoms-family 1))
    (princ "\\nNSS: v0.1 is already loaded. Restart AutoCAD before loading v0.2."))
  (T
    (if (not (member "NSS_TKK_EDITOR_ENABLE_V002" (atoms-family 1)))
      (command-s "_.NETLOAD" "DLLPATH"))
    (if (member "NSS_TKK_EDITOR_ENABLE_V002" (atoms-family 1))
      (NSS_TKK_EDITOR_ENABLE_V002)
      (princ "\\nNSS: DLL not loaded. Inspect the NETLOAD error; no update started."))))
(princ)
'''.replace('DLLPATH', dll.as_posix())
(root/'LOAD_NSS_TKK_EDITOR.lsp').write_text(lisp, encoding='utf8')
print('Ready:', root/'LOAD_NSS_TKK_EDITOR.lsp')
