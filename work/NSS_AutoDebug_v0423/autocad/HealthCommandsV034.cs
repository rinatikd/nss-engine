using System;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

public sealed class HealthCommandsV034
{
#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_HEALTH_V034", CommandFlags.Modal)]
#endif
    public void Health()
    {
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var db = doc.Database;
        var ed = doc.Editor;
        try
        {
            int lines = 0, polylines = 0, blocks = 0, other = 0;
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var model = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                foreach (ObjectId id in model)
                {
                    if (tr.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
                    switch (entity)
                    {
                        case Line: lines++; break;
                        case Polyline: polylines++; break;
                        case BlockReference: blocks++; break;
                        default: other++; break;
                    }
                }
            }
            var report = new {
                schema_version = "0.34", kind = "autocad_health",
                drawing = Path.GetFileName(db.Filename),
                insunits = db.Insunits.ToString(),
                note = "INSUNITS does not verify coordinate system or engineering units",
                counts = new { lines, polylines, blocks, other },
                timestamp_utc = DateTimeOffset.UtcNow.ToString("O")
            };
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "NSS_Engine");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, "NSS_health_v034.json");
            var temp = path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temp, path, true);
            ed.WriteMessage($"\nNSS health: LINE={lines}, LWPOLYLINE={polylines}, BLOCK={blocks}, OTHER={other}. Report: {path}");
        }
        catch (System.Exception ex)
        {
            ed.WriteMessage($"\nNSS health failed: {ex.GetType().Name}: {ex.Message}");
        }
    }
}
