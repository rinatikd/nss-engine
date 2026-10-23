from pathlib import Path
import hashlib,json,shutil,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_AutoBuild_v0232'
old=root/'output/NSS_AutoBuild_v0.23/NSS_AutoBuild_v023/Runs/20261017_064735_f74e10bc'
def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
evidence=p/'Evidence';evidence.mkdir(exist_ok=True)
shutil.copy2(old/'status.json',evidence/'hung_run_status.json')
for f in (old/'reports').glob('*.json'):shutil.copy2(f,evidence/f.name)
latest=sorted((p/'Runs').glob('*/status.json'))[-1]
state=json.loads(latest.read_text(encoding='utf8'));assert state['phase']=='PREPARED' and state['checks']=='selftest'
shutil.copy2(latest,evidence/'prepared_fix_status.json')
shutil.copy2(latest.parent/'build.log',evidence/'prepared_fix_build.log')
assert 'NSS_EXPORT_DIAGNOSTICS' not in (latest.parent/'gui.scr').read_text(encoding='ascii')
assert sha(Path(json.loads((old/'status.json').read_text(encoding='utf8'))['original_source']))=='f17689b8db639a993a9358a8bbb28102cda0f493b58d3e1076e2b9cc7e15444a'
readme='''# NSS AutoBuild 0.23.2 — проверка после зависания

## Сначала

В зависшем AutoCAD попробуйте Esc или Ctrl+C. Если отмена не работает, закрытие процесса через Диспетчер задач приведёт к потере несохранённых изменений во всех чертежах этого процесса. Исходный DXF сценарий не редактировал — открывалась его копия. Не загружайте исправленную DLL поверх уже загруженной старой: используйте новый запуск AutoCAD после закрытия зависшего экземпляра.

Распакуйте этот комплект в отдельную папку. Дважды щёлкните **Build-And-Run.cmd**. Теперь по умолчанию создаётся маленький smoke.dxf и выполняются только четыре NSS_SELFTEST. Полный анализ автоматически не запускается. Ожидаемый результат: **SELFTEST_PASSED**. Этот результат не означает проверки реального чертежа.

Команда для первого повторного теста:

```bat
Build-And-Run.cmd --mode gui --checks selftest --timeout 180
```

Пока проверьте только этот шаг и сообщите папку Runs и результат. На этом этапе не подставляйте реальный DXF: сначала нужно убедиться, что окно AutoCAD нормально открывается после самопроверок.

## Что исправлено

- Диагностический экспорт отделён от загрузки DLL и самопроверок.
- Поиск узлов графа использует пространственную сетку вместо просмотра всех ранее созданных узлов; сохраняются 3D-допуск и выбор самого раннего подходящего узла.
- Затратные проходы проверяют бюджет работы: 250000 контрольных операций на этап, 5 секунд на этап и 25 секунд на весь анализ. Это мягкие ограничения между контрольными точками. Они не могут прервать один зависший нативный вызов AutoCAD и не ограничивают загрузку DXF самим AutoCAD.
- Прогресс пишется в `Runs/<запуск>/reports/analysis_progress.jsonl`: этап, начало/завершение/прерывание, время и счётчик операций. Если нативный вызов не вернётся, в журнале останется последний начатый этап.
- Прерванный анализ получает `analysisComplete=false`, замечание ошибки и состояние `ANALYSIS_INCOMPLETE`, а не PASSED. Полный диагноз может быть частичным; нулевые счётчики такого результата не доказывают отсутствие проблем.

Полный анализ — отдельный последующий тест, после успешного первого шага:

```bat
Build-And-Run.cmd --mode gui --checks full --drawing "C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\Садик НСС.dxf" --timeout 180
```

Результаты: `SELFTEST_PASSED` — прошли только четыре самопроверки; `PASSED` — полный экспорт завершён и проверен; `ANALYSIS_INCOMPLETE` (код 5) — часть анализа прервана/не выполнена. `PREPARED` (режим --mode prepare) означает только сборку и подготовку.

Для кооперативной отмены **нового** полного анализа:

```bat
Build-And-Run.cmd --cancel "Runs\\папка_запуска"
```

Команда создаёт `cancel.request`, который проверяется между контрольными точками; она не завершает процесс AutoCAD. На старую DLL 0.23.1 этот механизм не действует. Также добавлен опрос HostApplicationServices.UserBreak для Ctrl+C, но его работа в UI на этой версии ещё не испытана. При таймауте нового полного запуска сценарий автоматически создаёт запрос отмены и оставляет AutoCAD открытым.

Повторный сбор результата:

```bat
Build-And-Run.cmd --collect "Runs\\папка_запуска"
```

Нужны AutoCAD 2026 и .NET SDK для net8.0-windows. Python включён. Отдельный регрессионный проект Regression использует SDK/.NET 10 для запуска проверок без AutoCAD; он не требуется для запуска плагина. DLL по-прежнему собирается для .NET 8.

## Что фактически проверено

18 тестов запускателя и 10 C#-проверок ограничений/пространственного индекса прошли. Среди C#-проверок — сравнение с полным перебором и 20000 поисков узлов в пределах линейного бюджета сравнений. Финальная сборка DLL 0.23.2.0 прошла с 0 ошибками и предупреждениями. Подготовка запускателя проверена. Повторный AutoCAD агентом не запускался, чтобы не создавать ещё один сеанс во время зависшего пользовательского запуска. Поэтому устранение зависания внутри AutoCAD ещё не подтверждено.

Причина по имеющимся доказательствам: DLL уже загрузилась и прошла четыре теста на реальном файле; итогового диагноза нет. Точный зависший этап старой версии неизвестен, так как журнала этапов в ней не было. Обнаружены затратные попарные проходы и линейный поиск узлов. Это вероятный источник длительной блокировки, а не доказанный стек зависания. На машине сохранялась активность CPU процесса. Новый журнал позволит установить точный этап при повторении.

Проверка остановки по бюджету не доказывает полноту инженерного анализа. Перенос алгоритмов блоков Python v0.23 в C# не выполнялся. Нормативные проверки не добавлялись. Исторический README предыдущего комплекта заменён этой актуальной инструкцией; Evidence содержит исходные подтверждения и журнал сборки.

Документация API отмены: [Autodesk HostApplicationServices.UserBreak](https://help.autodesk.com/cloudhelp/2026/ENU/OARX-ManagedRefGuide/files/OARX-ManagedRefGuide-Autodesk_AutoCAD_DatabaseServices_HostApplicationServices_UserBreak.html).
'''
(p/'README_RU.md').write_text(readme,encoding='utf8')
report='''# Проверка исправления NSS AutoBuild 0.23.2

Дата: 17.10.2026. Отдельная копия work/NSS_AutoBuild_v0232. Пользовательский зависший процесс не завершался агентом, прежний комплект и исходный DXF сохранены.

В пользовательском запуске f74e10bc от 06:47 есть JSON NSS_SELFTEST с четырьмя успешными случаями, но нет завершённого диагностического экспорта. Следовательно, загрузка DLL и базовые проверки прошли, а точное место последующего зависания по старым логам установить нельзя. В процессе проверки CPU процесса 1208 вырос примерно со 184 до 361 секунды; это показывает активность, но не доказывает конкретный участок исполнения.

Изменены: Core/AnalysisWork.cs (кооперативные бюджеты и PointGrid); AnalyzerEngine (журнал этапов и неполный результат); CollisionAnalyzer, ConnectionCandidateAnalyzer, NetworkQualityAnalyzer, TopologyConfidenceAnalyzer и NetworkGraphAnalyzer (контрольные точки); NetworkGraphBuilder (пространственный индекс); MainPlugin/ReadableReportWriter (полнота результата); autobuild.py (режим selftest по умолчанию, отдельный full, отмена и запрет PASSED для неполного анализа). Версия DLL 0.23.2.0. RuntimeSelfTests содержат прежние четыре проверки; их выполнение в новой DLL в AutoCAD не проверялось.

Фактически выполнено:

```text
runtime/python.exe -E -s -X utf8 -m unittest -v test_autobuild
dotnet run --project Regression/Regression.csproj -p:NuGetAudit=false
dotnet build AutoCAD_Project/NssEngine.csproj -c Release -o build_check -p:NuGetAudit=false
Build-And-Run.cmd --mode prepare
```

Результаты: 18 Python-тестов и 10 C#-регрессионных проверок прошли; сборка плагина и prepare успешны, 0 ошибок/предупреждений. Сетевой аудит NuGet отключён. Первая попытка консольных регрессионных проверок для net8.0 не смогла скачать отсутствующий пакет через запрещённую сеть; отдельный проверочный проект переключён на установленный net10.0 и выполнен успешно. Целевая версия самого плагина не менялась: net8.0-windows.

Покрытие новых проверок: лимит операций, лимит этапа, общий срок при смене этапа, отмена, heartbeat, восстановление контекста, границы и отрицательные координаты сетки, разделение сетей и Z, стабильный выбор узла, сравнение с полным перебором, 20000 поисков; отдельный режим без полного анализа, отсутствие ложного PASSED при неполном результате, кооперативная отмена без запуска процесса.

Фактический повтор на реальном DXF с новой DLL не запускался. Проверка UI и устранения чёрного окна остаётся следующим шагом пользователя по README_RU.md. Мягкие бюджеты не прерывают один зависший нативный вызов и не гарантируют отзывчивость UI во время каждого вызова AutoCAD. Изменения позволяют ограничить собственные проходы и локализовать следующий сбой; заявлять полное устранение зависания пока нельзя.

Упаковка проверяет CRC и SHA-256. Отдельная проверка распакованного ZIP с тестами и prepare записывается в output/verification_fix0232.log.
'''
(p/'REPORT_RU.md').write_text(report,encoding='utf8')
skip={'__pycache__','obj','bin','Runs','build_check'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and f.name not in ('MANIFEST_SHA256.json','attempts.json')]
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_AutoBuild_v0.23.2_Fix.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files):z.write(f,'NSS_AutoBuild_v0232/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,digest in manifest.items():assert hashlib.sha256(z.read('NSS_AutoBuild_v0232/'+name)).hexdigest()==digest
(root/'output/SHA256_Fix0232.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
shutil.copy2(p/'REPORT_RU.md',root/'output/REPORT_Fix0232_RU.md')
print('Fix ZIP verified:',archive.stat().st_size,'bytes')
