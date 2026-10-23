using System;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

public sealed class RuntimeValidationV041
{
#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_VALIDATE_V041", CommandFlags.Modal)]
#endif
    public void Validate()
    {
        ObservabilityV036.Run("NSS_VALIDATE_V041", () =>
        {
            var doc = Application.DocumentManager.MdiActiveDocument
                ?? throw new InvalidOperationException("No active drawing");
            var db = doc.Database;
            int lines = 0, polylines = 0, blocks = 0, other = 0, failed = 0;
            using (var tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var model = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                foreach (ObjectId id in model)
                {
                    try
                    {
                        var obj = tr.GetObject(id, OpenMode.ForRead);
                        if (obj is Line) lines++;
                        else if (obj is Polyline) polylines++;
                        else if (obj is BlockReference) blocks++;
                        else other++;
                    }
                    catch (System.Exception) { failed++; }
                }
            }
            var report = new {
                schema_version = "0.41", timestamp_utc = DateTimeOffset.UtcNow.ToString("O"),
                drawing_name = Path.GetFileName(db.Filename), insunits = db.Insunits.ToString(),
                counts = new { lines, polylines, blocks, other, failed },
                warnings = db.Insunits == UnitsValue.Undefined ? new [] { "INSUNITS_UNDEFINED" } : Array.Empty<string>(),
                drawing_id = db.FingerprintGuid.ToString(),
                coordinate_system = "unverified",
                inventory_complete = failed == 0,
                runtime_log = RuntimeLogV035.LogPath,
                note = "Read-only inventory; not a proof of engineering compliance"
            };
            string folder = Environment.GetEnvironmentVariable("NSS_REPORT_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "NSS_Engine");
            Directory.CreateDirectory(folder);
            string target = Path.Combine(folder, "runtime_validation_v041.json");
            string temp = target + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temp, target, true);
            doc.Editor.WriteMessage("\nNSS v0.41 report: " + target);
        });
    }
}
