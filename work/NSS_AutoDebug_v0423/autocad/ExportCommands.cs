using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;
public sealed class ExportCommands
{
    private sealed record Point2(double X, double Y);
    private sealed record SegmentDto(string handle, Point2 a, Point2 b, string layer);
    private sealed record WellDto(string handle, Point2 point, string layer);
    private sealed record Snapshot(string schema_version, string drawing_units, List<SegmentDto> segments,
        List<WellDto> wells, List<SegmentDto> utilities, List<string> warnings);

#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_EXPORT_V022", CommandFlags.Modal)]
#endif
    public void ExportSnapshot()
    {
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc is null) return;
        var db = doc.Database;
        var ed = doc.Editor;
        var segments = new List<SegmentDto>();
        var utilities = new List<SegmentDto>();
        var wells = new List<WellDto>();
        var warnings = new List<string>();
        // Edit these predicates to match actual DWG layer conventions before production use.
        static bool IsNetwork(string layer) => layer.StartsWith("NSS", StringComparison.OrdinalIgnoreCase);
        static bool IsUtility(string layer) => layer.StartsWith("UTIL", StringComparison.OrdinalIgnoreCase);
        try
        {
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var ms = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                foreach (ObjectId id in ms)
                {
                    var entity = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (entity is null) continue;
                    if (entity is Polyline pl && (IsNetwork(pl.Layer) || IsUtility(pl.Layer)))
                    {
                        if (pl.Elevation != 0) warnings.Add($"{pl.Handle}: elevation not exported");
                        if (pl.HasBulges) { warnings.Add($"{pl.Handle}: arc bulges skipped; no false straight segments emitted"); continue; }
                        int n = pl.NumberOfVertices;
                        for (int i = 0; i < n - 1 + (pl.Closed ? 1 : 0); i++)
                        {
                            var a = pl.GetPoint2dAt(i);
                            var b = pl.GetPoint2dAt((i + 1) % n);
                            var dto = new SegmentDto($"{pl.Handle}:{i}", new(a.X, a.Y), new(b.X, b.Y), pl.Layer);
                            (IsNetwork(pl.Layer) ? segments : utilities).Add(dto);
                        }
                    }
                    else if (entity is BlockReference br && br.Name.StartsWith("NSS_KKS", StringComparison.OrdinalIgnoreCase))
                    {
                        wells.Add(new WellDto(br.Handle.ToString(), new(br.Position.X, br.Position.Y), br.Layer));
                    }
                }
                tr.Commit();
            }
            var path = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NSS_v022_snapshot.json");
            var data = new Snapshot("0.22", "raw_drawing_units", segments, wells, utilities, warnings);
            System.IO.File.WriteAllText(path, JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }));
            ed.WriteMessage($"\nNSS snapshot saved: {path}; segments={segments.Count}, utilities={utilities.Count}, wells={wells.Count}, warnings={warnings.Count}");
        }
        catch (System.Exception ex) { ed.WriteMessage($"\nNSS export failed: {ex.GetType().Name}: {ex.Message}"); }
    }
}
