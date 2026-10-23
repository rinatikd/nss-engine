using System;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

// Wrap each command body with Run to ensure a matching terminal event.
public static class ObservabilityV036
{
    public static void Run(string command, Action action)
    {
        string id = Guid.NewGuid().ToString("N");
        try { RuntimeLogV035.Write("command_start", command, id); }
        catch (System.Exception) { /* logging must not block engineering work */ }
        try
        {
            action();
            try { RuntimeLogV035.Write("command_end", command, id); }
            catch (System.Exception) { }
        }
        catch (System.Exception ex)
        {
            try { RuntimeLogV035.Write("exception", command, id, ex); }
            catch (System.Exception) { }
            var doc = Application.DocumentManager.MdiActiveDocument;
            doc?.Editor.WriteMessage("\nNSS error in " + command + ": " + ex.Message);
            throw;
        }
    }
}

public sealed class ObservabilityCommandsV036
{
#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_DIAG_V036", CommandFlags.Modal)]
#endif
    public void Diagnose()
    {
        ObservabilityV036.Run("NSS_DIAG_V036", () =>
        {
            var doc = Application.DocumentManager.MdiActiveDocument
                ?? throw new InvalidOperationException("No active document");
            var db = doc.Database;
            var report = new {
                schema_version = "0.36", timestamp_utc = DateTimeOffset.UtcNow.ToString("O"),
                drawing_name = Path.GetFileName(db.Filename), units = db.Insunits.ToString(),
                log_path = RuntimeLogV035.LogPath
            };
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "NSS_Engine");
            Directory.CreateDirectory(dir);
            var output = Path.Combine(dir, "diagnostics_v036.json");
            var tmp = output + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, output, true);
            doc.Editor.WriteMessage("\nNSS diagnostics: " + output);
        });
    }
}
