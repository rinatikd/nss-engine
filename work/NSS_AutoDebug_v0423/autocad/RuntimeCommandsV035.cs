using System;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

public static class RuntimeLogV035
{
    private static readonly object Sync = new();
    public static string LogPath => Path.Combine(Environment.GetEnvironmentVariable("NSS_REPORT_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "NSS_Engine"), "runtime_v035.jsonl");
    public static void Write(string kind, string command, string runId, System.Exception? error = null)
    {
        var record = new { schema_version = "0.35", timestamp_utc = DateTimeOffset.UtcNow.ToString("O"),
            @event = kind, command, run_id = runId, exception_type = error?.GetType().FullName,
            message = error?.Message, stack_trace = error?.StackTrace, exception_detail = error?.ToString(),
            process_id = Environment.ProcessId, assembly_version = typeof(RuntimeLogV035).Assembly.GetName().Version?.ToString(),
            autocad_error_status = (error as Autodesk.AutoCAD.Runtime.Exception)?.ErrorStatus.ToString() };
        lock (Sync)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, JsonSerializer.Serialize(record) + Environment.NewLine);
        }
    }
}

public sealed class RuntimeCommandsV035
{
#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_SELFTEST_V035", CommandFlags.Modal)]
#endif
    public void SelfTest()
    {
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        string runId = Guid.NewGuid().ToString("N");
        try
        {
            RuntimeLogV035.Write("command_start", "NSS_SELFTEST_V035", runId);
            var db = doc.Database;
            var filename = db.Filename;
            var units = db.Insunits.ToString();
            doc.Editor.WriteMessage($"\nNSS v0.35: drawing={Path.GetFileName(filename)}, INSUNITS={units}, log={RuntimeLogV035.LogPath}");
            RuntimeLogV035.Write("command_end", "NSS_SELFTEST_V035", runId);
        }
        catch (System.Exception ex)
        {
            try { RuntimeLogV035.Write("exception", "NSS_SELFTEST_V035", runId, ex); } catch (IOException) { }
            doc.Editor.WriteMessage($"\nNSS selftest error: {ex.Message}");
        }
    }
}
