# СВН для AutoCAD 2026 (v0.1, ядро без плагина)
1. В AutoCAD: SAVEAS → DXF (R2000/R2010 ASCII) → plan.dxf.
2. Заполнить cameras.csv (x,y — в единицах чертежа, мм; rotation — от оси X против часовой).
3. python3 cctv_cli.py plan.dxf cameras.csv result.dxf --layers <слои стен> --days 30 --xlsx spec.xlsx
4. В AutoCAD: открыть result.dxf (или XREF/INSERT) — слои CCTV_CAM, CCTV_FOV, CCTV_DORI, CCTV_TEXT, WALLS_REF.
Ограничения v0.1: 2D, стены только LINE/POLYLINE/LWPOLYLINE (блоки и ARC не читаются), ASCII DXF,
нормы РК не проверяются (ждём тексты СТ РК 4031-2026 и правил видеомониторинга), результат в реальном AutoCAD не проверялся.
Тесты: python3 test_cctv_core.py
