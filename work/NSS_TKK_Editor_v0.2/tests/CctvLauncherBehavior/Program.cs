using System;
using System.Collections.Generic;
using System.IO;

static class Program
{
    static int _failed;
    static readonly List<string> _log = new();

    static void Check(bool ok, string name, string detail = "")
    {
        _log.Add((ok ? "PASS " : "FAIL ") + name + (detail.Length > 0 ? " :: " + detail : ""));
        if (!ok) _failed++;
    }

    static string MakeTempDir()
    {
        string d = Path.Combine(Path.GetTempPath(), "nss_cctv_beh_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(d);
        return d;
    }

    static void WritePlan(string path)
        => File.WriteAllText(path,
            "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nA-WALL\n10\n0\n20\n0\n30\n0\n11\n1000\n21\n0\n31\n0\n0\nENDSEC\n0\nEOF\n");

    static void WriteCameras(string path, params string[] rows)
    {
        var lines = new List<string> { "name,x,y,rotation_deg,model,focal_mm,height_m,tilt_deg,bitrate_mbps" };
        lines.AddRange(rows);
        File.WriteAllText(path, string.Join("\n", lines) + "\n");
    }

    static string PrepareFakeInstall(string repoModulesCctv)
    {
        // GetRoot() = РЎР‚Р С•Р Т‘Р С‘РЎвЂљР ВµР В»РЎРЉ Р С—Р В°Р С—Р С”Р С‘ РЎРѓР В±Р С•РЎР‚Р С”Р С‘. Р вЂќР В»РЎРЏ bin/Release/net8.0 РЎРЊРЎвЂљР С• bin/Release.
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
        string module = Path.Combine(root, "modules", "cctv");
        Directory.CreateDirectory(module);
        foreach (var name in new[] { "cctv_cli.py", "cctv_core.py", "catalog.csv" })
        {
            string src = Path.Combine(repoModulesCctv, name);
            if (File.Exists(src)) File.Copy(src, Path.Combine(module, name), true);
        }
        string runtime = Path.Combine(root, "runtime");
        Directory.CreateDirectory(runtime);
        string stub = "@echo off\r\necho fake-python-stub\r\nexit /b 0\r\n";
        File.WriteAllText(Path.Combine(runtime, "python.exe"), stub);
        return root;
    }

    static string Joined() => string.Join("\n", FakeAutoCad.Messages);

    static void Main()
    {
        string? repo = Environment.CurrentDirectory;
        while (repo != null && !Directory.Exists(Path.Combine(repo, "work", "NSS_TKK_Editor_v0.2", "modules", "cctv")))
            repo = Path.GetDirectoryName(repo);
        if (repo == null) { Console.WriteLine("REPO ROOT NOT FOUND"); Environment.Exit(2); return; }
        string modules = Path.Combine(repo, "work", "NSS_TKK_Editor_v0.2", "modules", "cctv");

        // Р В Р’В Р В Р вЂ№Р В Р Р‹Р Р†Р вЂљР’В Р В Р’В Р вЂ™Р’ВµР В Р’В Р В РІР‚В¦Р В Р’В Р вЂ™Р’В°Р В Р Р‹Р В РІР‚С™Р В Р’В Р РЋРІР‚ВР В Р’В Р Р†РІР‚С›РІР‚вЂњ 6: Р В Р’В Р В РІР‚В¦Р В Р’В Р вЂ™Р’ВµР В Р Р‹Р Р†Р вЂљРЎв„ў packaged python runtime
        {
            string root = PrepareFakeInstall(modules);
            File.Delete(Path.Combine(root, "runtime", "python.exe"));
            string plan = Path.Combine(root, "plan.dxf");
            string cams = Path.Combine(root, "cams.csv");
            WritePlan(plan); WriteCameras(cams);
            FakeAutoCad.Reset();
            FakeAutoCad.QueueFile(plan);
            FakeAutoCad.QueueFile(cams);
            new CctvCommands().Analyze();
            string log = Joined();
            Check(log.Contains("packaged Python runtime is missing") || log.Contains("CCTV module or packaged Python runtime"),
                  "scenario6: missing runtime reported",
                  log.Length > 200 ? log.Substring(0, 200) + "..." : log);
        }

        // Р В Р’В Р В Р вЂ№Р В Р Р‹Р Р†Р вЂљР’В Р В Р’В Р вЂ™Р’ВµР В Р’В Р В РІР‚В¦Р В Р’В Р вЂ™Р’В°Р В Р Р‹Р В РІР‚С™Р В Р’В Р РЋРІР‚ВР В Р’В Р Р†РІР‚С›РІР‚вЂњ 4: Р В Р’В Р РЋРІР‚вЂќР В Р Р‹Р РЋРІР‚СљР В Р Р‹Р В РЎвЂњР В Р Р‹Р Р†Р вЂљРЎв„ўР В Р’В Р РЋРІР‚СћР В Р’В Р Р†РІР‚С›РІР‚вЂњ CSV (Р В Р Р‹Р Р†Р вЂљРЎв„ўР В Р’В Р РЋРІР‚СћР В Р’В Р вЂ™Р’В»Р В Р Р‹Р В Р вЂ°Р В Р’В Р РЋРІР‚СњР В Р’В Р РЋРІР‚Сћ Р В Р’В Р вЂ™Р’В·Р В Р’В Р вЂ™Р’В°Р В Р’В Р РЋРІР‚вЂњР В Р’В Р РЋРІР‚СћР В Р’В Р вЂ™Р’В»Р В Р’В Р РЋРІР‚СћР В Р’В Р В РІР‚В Р В Р’В Р РЋРІР‚СћР В Р’В Р РЋРІР‚Сњ)
        {
            string root = PrepareFakeInstall(modules);
            string plan = Path.Combine(root, "plan.dxf");
            string cams = Path.Combine(root, "cams.csv");
            WritePlan(plan); WriteCameras(cams);
            FakeAutoCad.Reset();
            FakeAutoCad.QueueFile(plan);
            FakeAutoCad.QueueFile(cams);
            FakeAutoCad.QueueInteger(7);
            FakeAutoCad.QueueKeyword("Millimeters");
            FakeAutoCad.QueueString("");
            new CctvCommands().Analyze();
            string log = Joined();
            Check(log.Contains("failed (exit") || log.Contains("no camera rows") || log.Contains("Python process did not start") || log.Contains("An error occurred trying to start process"),
                  "scenario4: empty CSV reported",
                  log.Length > 300 ? log.Substring(0, 300) + "..." : log);
        }

        // Р В Р’В Р В Р вЂ№Р В Р Р‹Р Р†Р вЂљР’В Р В Р’В Р вЂ™Р’ВµР В Р’В Р В РІР‚В¦Р В Р’В Р вЂ™Р’В°Р В Р Р‹Р В РІР‚С™Р В Р’В Р РЋРІР‚ВР В Р’В Р Р†РІР‚С›РІР‚вЂњ 5: Р В Р Р‹Р В РЎвЂњР В Р’В Р РЋРІР‚СњР В Р’В Р РЋРІР‚СћР В Р’В Р вЂ™Р’В±Р В Р’В Р РЋРІР‚СњР В Р’В Р РЋРІР‚В Р В Р’В Р В РІР‚В  Р В Р’В Р РЋРІР‚ВР В Р’В Р РЋР’ВР В Р’В Р вЂ™Р’ВµР В Р’В Р В РІР‚В¦Р В Р’В Р РЋРІР‚В Р В Р Р‹Р Р†Р вЂљРЎвЂєР В Р’В Р вЂ™Р’В°Р В Р’В Р Р†РІР‚С›РІР‚вЂњР В Р’В Р вЂ™Р’В»Р В Р’В Р вЂ™Р’В°
        {
            string root = PrepareFakeInstall(modules);
            string plan = Path.Combine(root, "Р В Р’В Р РЋРІР‚вЂќР В Р’В Р вЂ™Р’В»Р В Р’В Р вЂ™Р’В°Р В Р’В Р В РІР‚В¦{1}.dxf");
            string cams = Path.Combine(root, "Р В Р’В Р РЋРІР‚СњР В Р’В Р вЂ™Р’В°Р В Р’В Р РЋР’ВР В Р’В Р вЂ™Р’ВµР В Р Р‹Р В РІР‚С™Р В Р Р‹Р Р†Р вЂљРІвЂћвЂ“ (1).csv");
            WritePlan(plan);
            WriteCameras(cams, "VN-1,1000,1000,45,DS-2CD1143G2-I,2.8,3,20,4");
            FakeAutoCad.Reset();
            FakeAutoCad.QueueFile(plan);
            FakeAutoCad.QueueFile(cams);
            FakeAutoCad.QueueInteger(30);
            FakeAutoCad.QueueKeyword("Millimeters");
            FakeAutoCad.QueueString("A-WALL");
            new CctvCommands().Analyze();
            string log = Joined();
            Check(!log.Contains("Selected file does not exist"),
                  "scenario5: braces in paths did not break Pick",
                  log.Length > 300 ? log.Substring(0, 300) + "..." : log);
        }

        // Р В Р’В Р В Р вЂ№Р В Р Р‹Р Р†Р вЂљР’В Р В Р’В Р вЂ™Р’ВµР В Р’В Р В РІР‚В¦Р В Р’В Р вЂ™Р’В°Р В Р Р‹Р В РІР‚С™Р В Р’В Р РЋРІР‚ВР В Р’В Р Р†РІР‚С›РІР‚вЂњ 3 (unit): TimeoutSeconds() Р В Р Р‹Р Р†Р вЂљР Р‹Р В Р’В Р вЂ™Р’ВµР В Р Р‹Р В РІР‚С™Р В Р’В Р вЂ™Р’ВµР В Р’В Р вЂ™Р’В· Р В Р Р‹Р В РІР‚С™Р В Р’В Р вЂ™Р’ВµР В Р Р‹Р Р†Р вЂљРЎвЂєР В Р’В Р вЂ™Р’В»Р В Р’В Р вЂ™Р’ВµР В Р’В Р РЋРІР‚СњР В Р Р‹Р В РЎвЂњР В Р’В Р РЋРІР‚ВР В Р Р‹Р В РІР‚в„–
        {
            var t = typeof(CctvCommands);
            var m = t.GetMethod("TimeoutSeconds",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
            Environment.SetEnvironmentVariable("NSS_CCTV_TIMEOUT_SECONDS", "30");
            Check((int)m.Invoke(null, null)! == 30, "scenario3a: timeout=30");
            Environment.SetEnvironmentVariable("NSS_CCTV_TIMEOUT_SECONDS", "5");
            Check((int)m.Invoke(null, null)! == 120, "scenario3b: 5 -> 120 (below min)");
            Environment.SetEnvironmentVariable("NSS_CCTV_TIMEOUT_SECONDS", "7200");
            Check((int)m.Invoke(null, null)! == 120, "scenario3c: 7200 -> 120 (above max)");
            Environment.SetEnvironmentVariable("NSS_CCTV_TIMEOUT_SECONDS", "abc");
            Check((int)m.Invoke(null, null)! == 120, "scenario3d: abc -> 120");
            Environment.SetEnvironmentVariable("NSS_CCTV_TIMEOUT_SECONDS", "");
            Check((int)m.Invoke(null, null)! == 120, "scenario3e: empty -> 120");
        }

        foreach (var line in _log) Console.WriteLine(line);
        Console.WriteLine(_failed == 0 ? "ALL PASSED" : $"{_failed} FAILED");
        Environment.Exit(_failed == 0 ? 0 : 1);
    }
}