using System;
using System.Collections.Generic;
using System.Linq;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;

namespace AGPT.Cad
{
    public static class RoomUnitEvidence
    {
        public static List<double> Read(Database db, Transaction tr, Polyline boundary)
        {
            var scales = new List<double>();
            var room = boundary.GeometricExtents;
            double margin = Math.Max(room.MaxPoint.X - room.MinPoint.X, room.MaxPoint.Y - room.MinPoint.Y) * .2;
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var model = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            foreach (ObjectId id in model)
            {
                if (tr.GetObject(id, OpenMode.ForRead) is not Dimension dimension
                    || (dimension is not AlignedDimension && dimension is not RotatedDimension)
                    || AlbumOutput.IsGenerated(dimension)) continue;
                try
                {
                    var extent = dimension.GeometricExtents;
                    if (extent.MaxPoint.X < room.MinPoint.X - margin || extent.MinPoint.X > room.MaxPoint.X + margin
                        || extent.MaxPoint.Y < room.MinPoint.Y - margin || extent.MinPoint.Y > room.MaxPoint.Y + margin) continue;
                    double elevationTolerance = 1e-8 * Math.Max(1, margin);
                    if (Math.Abs(extent.MinPoint.Z - room.MinPoint.Z) > elevationTolerance
                        || Math.Abs(extent.MaxPoint.Z - room.MinPoint.Z) > elevationTolerance) continue;
                    string text = dimension.DimensionText;
                    if (string.IsNullOrWhiteSpace(text))
                        text = ((DimStyleTableRecord)tr.GetObject(dimension.DimensionStyle, OpenMode.ForRead)).Dimpost;
                    if (RoomUnitInference.TryScaleFromDimensionLabel(text, dimension.Measurement, dimension.Dimlfac, out double scale))
                        scales.Add(scale);
                }
                catch (Autodesk.AutoCAD.Runtime.Exception) { /* Unreadable dimension supplies no evidence. */ }
            }
            return scales;
        }
    }

    // A verified per-zone interpretation supports unitless DXF without changing INSUNITS.
    public static class CapturedPlanUnits
    {
        public static bool TryRead(Database db, out double scale)
        {
            scale = 0;
            if ((int)db.Insunits != 0) return false;
            using var tr = db.TransactionManager.StartOpenCloseTransaction();
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var model = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            foreach (ObjectId id in model)
            {
                if (tr.GetObject(id, OpenMode.ForRead) is not Entity entity || AlbumOutput.IsGenerated(entity)
                    || !string.Equals(entity.Layer, "AGPT-ZONE", StringComparison.OrdinalIgnoreCase)
                    || AGPT.Stage3.XD.Get(entity, "ROOM_CAPTURE") != "1"
                    || AGPT.Stage3.XD.Get(entity, "UNIT_VERIFIED") != "1") continue;
                if (!NumericData.TryParseFinite(AGPT.Stage3.XD.Get(entity, "METRES_PER_UNIT"), out double value)
                    || (value != .001 && value != .01 && value != 1)) return false;
                // A unitless model needs live evidence, not circular trust in its own cache.
                if (entity is not Polyline boundary) return false;
                var live = RoomUnitEvidence.Read(db, tr, boundary).Distinct().ToArray();
                if (live.Length != 1 || live[0] != value) return false;
                if (scale != 0 && scale != value) { scale = 0; return false; }
                scale = value;
            }
            return scale != 0;
        }
    }
}
