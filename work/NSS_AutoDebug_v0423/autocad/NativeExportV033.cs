using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

// Read-only ModelSpace extraction. Segments are chord approximations where arc bulges exist.
public sealed class NativeExportV033
{
    private sealed record P(double x, double y);
    private sealed record Seg(string handle, P a, P b, string layer, string entity_type, bool approximated);
    private sealed record Well(string handle, P point, string layer, string block_name, Dictionary<string,string> attributes);
    private static P Pt(Point2d p) => new(p.X, p.Y);
    private static P Pt(Point3d p) => new(p.X, p.Y);
    private static bool Finite(double x) => !double.IsNaN(x) && !double.IsInfinity(x);
    private static bool Valid(P p) => Finite(p.x) && Finite(p.y);

#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_EXPORT_V033", CommandFlags.Modal)]
#endif
    public void Export()
    {
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var db = doc.Database;
        var ed = doc.Editor;
        var segments = new List<Seg>();
        var wells = new List<Well>();
        var warnings = new List<string>();
        const double maxChord = 1.0; // DRAWING UNITS, NOT METRES. User must verify.
        const int maxArcPieces = 4096;
        try
        {
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                foreach (ObjectId id in ms)
                {
                    try
                    {
                    if (tr.GetObject(id, OpenMode.ForRead) is not Entity e) continue;
                    string handle = e.Handle.ToString();
                    void Add(P a, P b, int index, string kind, bool approx = false)
                    {
                        if (!Valid(a) || !Valid(b)) { warnings.Add($"{handle}:{index} invalid coordinates"); return; }
                        if (a == b) { warnings.Add($"{handle}:{index} zero length"); return; }
                        segments.Add(new Seg($"{handle}:{index}", a, b, e.Layer, kind, approx));
                    }
                    if (e is Line line)
                    {
                        Add(Pt(line.StartPoint), Pt(line.EndPoint), 0, "LINE");
                        if (line.StartPoint.Z != line.EndPoint.Z || line.StartPoint.Z != 0)
                            warnings.Add($"{handle} LINE Z not exported; 2D only");
                    }
                    else if (e is Polyline pl)
                    {
                        if (pl.Elevation != 0 || pl.Normal != Vector3d.ZAxis)
                            warnings.Add($"{handle} elevation/OCS not exported; review geometry");
                        if (pl.Normal != Vector3d.ZAxis) { warnings.Add($"{handle} non-world XY polyline skipped"); continue; }
                        int count = pl.NumberOfVertices;
                        int edges = pl.Closed ? count : count - 1;
                        for (int i = 0; i < edges; i++)
                        {
                            int next = (i + 1) % count;
                            double bulge = pl.GetBulgeAt(i);
                            if (Math.Abs(bulge) < 1e-12)
                            {
                                Add(Pt(pl.GetPoint2dAt(i)), Pt(pl.GetPoint2dAt(next)), i, "LWPOLYLINE");
                                continue;
                            }
                            // Arc approximation via AutoCAD's exact curve parameterization.
                            // Segment parameter i..i+1 (closed last edge wraps to count).
                            try
                            {
                                double start = i;
                                double end = i + 1;
                                var p0 = pl.GetPointAtParameter(start);
                                var p1 = pl.GetPointAtParameter(end);
                                double length = pl.GetDistanceAtParameter(end) - pl.GetDistanceAtParameter(start);
                                if (!Finite(length) || length <= 0 || length / maxChord > maxArcPieces) { warnings.Add($"{handle}:{i} invalid or excessive arc length; skipped"); continue; }
                                int pieces = Math.Max(2, (int)Math.Ceiling(length / maxChord));
                                if (pieces > maxArcPieces) { warnings.Add($"{handle}:{i} arc exceeds tessellation cap; skipped"); continue; }
                                var previous = Pt(p0);
                                for (int j = 1; j <= pieces; j++)
                                {
                                    var current = Pt(pl.GetPointAtParameter(start + (end-start)*j/pieces));
                                    Add(previous, current, i*100000+j, "LWPOLYLINE_ARC_CHORD", true);
                                    previous = current;
                                }
                                warnings.Add($"{handle}:{i} arc approximated with {pieces} chords (max chord target {maxChord} drawing units)");
                            }
                            catch (System.Exception ex) { warnings.Add($"{handle}:{i} arc skipped: {ex.GetType().Name}"); }
                        }
                    }
                    else if (e is BlockReference br)
                    {
                        string name = br.Name;
                        var attrs = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
                        foreach (ObjectId aid in br.AttributeCollection)
                            if (tr.GetObject(aid, OpenMode.ForRead) is AttributeReference ar)
                                attrs[ar.Tag] = ar.TextString;
                        if (name.StartsWith("NSS_KKS", StringComparison.OrdinalIgnoreCase))
                            wells.Add(new Well(handle, Pt(br.Position), br.Layer, name, attrs));
                        else warnings.Add($"{handle} block {name} not classified; nested geometry not exported");
                    }
                    }
                    catch(System.Exception error) { warnings.Add($"{id.Handle}: object skipped: {error.GetType().Name}: {error.Message}"); }
                }
            }
            // Preserve all linework as unclassified until the layer mapping is reviewed.
            // v0.32 accepts both segments and utilities; do not silently infer either.
            var snapshot = new {
                schema_version = "0.33", drawing_units = "raw_drawing_units",
                source_drawing = Path.GetFileName(db.Filename), segments,
                utilities = Array.Empty<Seg>(), wells, warnings,
                metadata = new { coordinate_system = "unverified", units = "unverified", declared_insunits = db.Insunits.ToString(), drawing_id = db.FingerprintGuid.ToString(), arc_chord_target = maxChord, geometry_dimension = "XY_projection_Z_not_preserved", replacement_command = "NSS_EXPORT_V042" }
            };
            string folder = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            string output = Path.Combine(folder, "NSS_v033_snapshot.json");
            File.WriteAllText(output, JsonSerializer.Serialize(snapshot, new JsonSerializerOptions { WriteIndented = true }));
            ed.WriteMessage($"\nNSS v0.33 exported {segments.Count} segments, {wells.Count} wells to {output}; warnings={warnings.Count}");
        }
        catch (System.Exception ex) { ed.WriteMessage($"\nNSS v0.33 export error: {ex.GetType().Name}: {ex.Message}"); }
    }
}
