"""Headless AutoCAD smoke test. The source drawing is copied before opening."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--drawing", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--isolate", action="store_true")
    parser.add_argument("--trust-test-dlls", action="store_true")
    parser.add_argument("--prepare-plan", type=Path)
    parser.add_argument("--engineering-plan", type=Path)
    parser.add_argument("--engineering-reopen", action="store_true")
    parser.add_argument("--scenario", action="store_true")
    parser.add_argument("--geometry-report", type=Path)
    parser.add_argument("--auto-probe", action="store_true")
    parser.add_argument("--session-probe", action="store_true")
    parser.add_argument("--full-app", action="store_true")
    parser.add_argument("--gui-scenario", action="store_true")
    parser.add_argument("--gui-cancellation", action="store_true")
    parser.add_argument("--gui-native-smoke", action="store_true")
    parser.add_argument("--profile", default='NSS_TKK_AUTOTEST_V022')
    args = parser.parse_args()
    if args.engineering_plan and (args.prepare_plan or args.full_app or args.scenario):
        parser.error('--engineering-plan requires a prepared disposable Core Console copy without another scenario')
    if args.engineering_reopen and (args.engineering_plan or args.full_app or not args.geometry_report):
        parser.error('--engineering-reopen requires --geometry-report and a separate Core Console reopening')
    if args.gui_scenario and not args.full_app:
        parser.error('--gui-scenario requires --full-app')
    if args.gui_cancellation and (not args.full_app or args.gui_scenario):
        parser.error('--gui-cancellation requires --full-app and excludes --gui-scenario')
    if args.gui_native_smoke and (not args.full_app or args.gui_scenario or args.gui_cancellation):
        parser.error('--gui-native-smoke requires --full-app and excludes other GUI scenarios')
    if args.full_app:
        import winreg
        if not args.profile.startswith('NSS_TKK_AUTOTEST_'):
            raise ValueError('Only a separate NSS test profile is allowed')
        found = False
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Autodesk\AutoCAD\R25.1') as version:
            for index in range(winreg.QueryInfoKey(version)[0]):
                product = winreg.EnumKey(version, index)
                try:
                    with winreg.OpenKey(version, product+'\\Profiles\\'+args.profile):
                        found = True
                except FileNotFoundError:
                    pass
        if not found:
            raise ValueError('Create the separate AutoCAD test profile first: '+args.profile)
    root, drawing, out = args.package.resolve(), args.drawing.resolve(), args.out.resolve()
    if out.exists() and any(out.iterdir()):
        raise ValueError('Use a new output folder; old evidence must not be mistaken for this run')
    out.mkdir(parents=True, exist_ok=True)
    copy = out / ("NSS_20_10_26_RESULT_MLEADER" + drawing.suffix.lower())
    if drawing == copy:
        raise ValueError("A distinct disposable drawing is required")
    shutil.copy2(drawing, copy)
    harness = Path(__file__).resolve().parents[1] / "native/bin/NssTkkNativeSmoke.V002.dll"
    script = out / "smoke.scr"
    plugin = next((root/'plugin').glob('NssTkkEditor.V*.dll'))
    plugin_sha256 = hashlib.sha256(plugin.read_bytes()).hexdigest()
    trust_dlls = args.isolate or args.trust_test_dlls
    trust = f'(setq nss_test_trust (getvar "TRUSTEDPATHS"))\n(setvar "TRUSTEDPATHS" (strcat nss_test_trust ";{harness.parent.as_posix()};{plugin.parent.as_posix()}"))\n' if trust_dlls else ''
    restore = '(setvar "TRUSTEDPATHS" nss_test_trust)\n' if trust_dlls else ''
    scenario = '''NSS_TKK_CHECK
NSS_TKK_REBUILD
NSS_TKK_NATIVE_BEGIN
NSS_TKK_NATIVE_ADD
NSS_TKK_REBUILD
NSS_TKK_NATIVE_ASSERT_ADD
NSS_TKK_NATIVE_MOVE
NSS_TKK_REBUILD
NSS_TKK_NATIVE_ASSERT_MOVE
NSS_TKK_NATIVE_DELETE
_.UNDO
1
NSS_TKK_NATIVE_ASSERT_UNDO
NSS_TKK_STATUS
NSS_TKK_CHECK
NSS_TKK_ISSUES
_.REDO
NSS_TKK_NATIVE_ASSERT_REDO
NSS_TKK_REBUILD
NSS_TKK_NATIVE_REVIEW_BEGIN
NSS_TKK_ISSUES
NSS_TKK_NEXT_ISSUE
NSS_TKK_ISSUE
1
NSS_TKK_NATIVE_ASSERT_REVIEW
NSS_TKK_REBUILD
NSS_TKK_NATIVE_FINISH
NSS_TKK_AUTO_OFF
''' if args.scenario else ''
    if args.auto_probe:
        scenario+='NSS_TKK_NATIVE_AUTO_PROBE_BEGIN\nNSS_TKK_AUTO_ON\n'+('_.DELAY\n250\n'*40)+'NSS_TKK_NATIVE_AUTO_PROBE_END\nNSS_TKK_AUTO_OFF\n'
    if args.session_probe:
        scenario+='NSS_TKK_NATIVE_SESSION_PROBE\n'
    gui_command='NSS_TKK_NATIVE_GUI_CANCEL_START' if args.gui_cancellation else ('NSS_TKK_NATIVE_GUI_SCENARIO_START' if args.gui_scenario else 'NSS_TKK_NATIVE_GUI_PROBE_START')
    engineering='NSS_TKK_NATIVE_ENGINEERING\n' if args.engineering_plan else ''
    review_verify='NSS_TKK_NATIVE_ENGINEERING_VERIFY\n' if args.engineering_reopen else ''
    body=f'{engineering}NSS_TKK_NATIVE_SMOKE\n{scenario}{review_verify}_.QUIT\n_Y\n' if not args.full_app else ('_.NETLOAD\n"'+plugin.as_posix()+'"\n_.NETLOAD\n"'+harness.as_posix()+'"\nNSS_TKK_NATIVE_SMOKE\n_.QUIT\n_Y\n' if args.gui_native_smoke else gui_command+'\n')
    transcript=f'(setvar "FILEDIA" 0)\n(setvar "CMDDIA" 0)\n(setvar "LOGFILEPATH" "{out.as_posix()}/")\n(setvar "LOGFILEMODE" 1)\n' if args.full_app else ''
    script.write_text(f'{transcript}{trust}_.NETLOAD\n"{plugin.as_posix()}"\n_.NETLOAD\n"{harness.as_posix()}"\n{restore}{body}', encoding="utf8")
    env = dict(os.environ, NSS_TKK_PACKAGE=str(root), NSS_TKK_NATIVE_OUT=str(out), NSS_TKK_NATIVE_INPUT=str(copy))
    env.pop('NSS_TKK_PLAN', None)
    env.pop('NSS_TKK_ENGINEERING_PLAN', None)
    if args.engineering_plan:
        env['NSS_TKK_ENGINEERING_PLAN'] = str(args.engineering_plan.resolve())
    if args.prepare_plan:
        env['NSS_TKK_PLAN'] = str(args.prepare_plan.resolve())
    env.pop('NSS_TKK_GEOMETRY_REPORT', None)
    if args.geometry_report:
        env['NSS_TKK_GEOMETRY_REPORT'] = str(args.geometry_report.resolve())
    console = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Autodesk/AutoCAD 2026/accoreconsole.exe"
    command = [str(console), "/p", args.profile, "/i", str(copy), "/s", str(script), "/l", "en-US"]
    if args.isolate:
        command += ["/isolate", "NSS_TKK_V002_TEST", str(out / "profile")]
    if args.full_app:
        console=console.with_name('acad.exe')
        command=[str(console),str(copy),'/b',str(script),'/nologo','/nossm','/nohardware','/p',args.profile]
    with (out / "console.log").open("wb") as log:
        try:
            startup=subprocess.STARTUPINFO();startup.dwFlags|=subprocess.STARTF_USESHOWWINDOW;startup.wShowWindow=0
            proc=subprocess.Popen(command,env=env,cwd=out,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW,startupinfo=startup)
            (out/'expected_pid.txt').write_text(str(proc.pid),encoding='ascii')
            try:exit_code=proc.wait(timeout=180)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait();raise
        except subprocess.TimeoutExpired:
            exit_code = "TIMEOUT"
    summary = out / "native_summary.json"
    result = json.loads(summary.read_text("utf8")) if summary.exists() else {"success": False, "error": "Native harness did not finish"}
    if args.full_app:
        if args.gui_native_smoke:
            native=out/'native_summary.json'
            result=json.loads(native.read_text('utf8')) if native.exists() else {'success':False,'error':'Full AutoCAD native smoke did not finish'}
        else:
            gui=out/('native_gui_cancellation.json' if args.gui_cancellation else ('native_gui_scenario.json' if args.gui_scenario else 'native_gui_probe.json'))
            result=json.loads(gui.read_text('utf8')) if gui.exists() else {'success':False,'error':'Full AutoCAD probe did not finish'}
    result["console_exit_code"] = exit_code
    result['plugin_sha256'] = plugin_sha256
    result['full_application'] = args.full_app
    if args.full_app:
        result['test_profile'] = args.profile
    if args.scenario:
        scenario_file=out/'native_scenario_summary.json'
        scenario_result=json.loads(scenario_file.read_text('utf8')) if scenario_file.exists() else {'success':False,'complete':False}
        result['scenario']=scenario_result
        result['success']=result['success'] and scenario_result['success'] and scenario_result['complete']
    if args.engineering_plan:
        engineering_file=out/'engineering_summary.json'
        engineering_result=json.loads(engineering_file.read_text('utf8')) if engineering_file.exists() else {'success':False,'error':'Engineering command did not finish'}
        result['engineering_review']=engineering_result
        result['success']=result['success'] and engineering_result['success']
    if args.engineering_reopen:
        review_file=out/'engineering_reopened.json'
        review_result=json.loads(review_file.read_text('utf8')) if review_file.exists() else {'success':False,'error':'Saved review verification did not finish'}
        result['engineering_reopened']=review_result
        result['success']=result['success'] and review_result['success']
    if args.auto_probe:
        probe_file=out/'native_auto_probe.json'
        probe=json.loads(probe_file.read_text('utf8')) if probe_file.exists() else {'success':False,'error':'probe did not finish'}
        result['auto_probe']=probe
        result['success']=result['success'] and probe['success']
    (out / "runner_summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    # Full raw status remains in the evidence file; do not flood the terminal with every warning.
    print(json.dumps({key:value for key,value in result.items() if key not in ('status','engineering_review')}, ensure_ascii=False, indent=2))
    return 0 if result["success"] and exit_code == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
