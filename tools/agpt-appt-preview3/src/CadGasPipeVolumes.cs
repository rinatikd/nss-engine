using System;
using System.Collections.Generic;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;

namespace AGPT.Cad
{
    public sealed class PipeVolumeSummary
    {
        public Dictionary<string, double> Volumes { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, int> Counts { get; } = new(StringComparer.Ordinal);
    }

    // Read current source geometry, never cached L or a nominal diameter as a bore.
    public static class CadGasPipeVolumes
    {
        internal static bool IsSourcePipe(Entity entity) =>
            !AlbumOutput.IsGenerated(entity) &&
            (!string.IsNullOrWhiteSpace(AGPT.Stage3.XD.Get(entity, "SEG_TYPE"))
                || string.Equals(entity.Layer, "AGPT-PIPE", StringComparison.OrdinalIgnoreCase));

        internal static Dictionary<string, ObjectId> ReadZones(Database db, Transaction tr)
        {
            var zones = new Dictionary<string, ObjectId>(StringComparer.Ordinal);
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var source = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            foreach (ObjectId id in source)
            {
                if (tr.GetObject(id, OpenMode.ForRead) is not Entity entity || AlbumOutput.IsGenerated(entity)) continue;
                if (!string.Equals(entity.Layer, "AGPT-ZONE", StringComparison.OrdinalIgnoreCase)) continue;
                string kind = AGPT.Stage3.XD.Get(entity, "KIND");
                if (!string.IsNullOrWhiteSpace(kind) && kind != "ZONE") continue;
                string guid = AGPT.Stage3.XD.Get(entity, "GUID");
                if (entity is not Polyline boundary || !boundary.Closed || boundary.NumberOfVertices < 3)
                    throw new InvalidOperationException("Зона " + entity.Handle + ": нужен замкнутый исходный контур. Повторите AGPT_ZONE.");
                if (string.IsNullOrWhiteSpace(AGPT.Stage3.XD.Get(entity, "ZONE_NAME"))
                    || !double.IsFinite(boundary.Area) || boundary.Area <= 0)
                    throw new InvalidOperationException("Зона " + entity.Handle + ": нужны имя и положительная конечная площадь исходного контура. Повторите AGPT_ZONE.");
                if (string.IsNullOrWhiteSpace(guid) || !zones.TryAdd(guid, id))
                    throw new InvalidOperationException("Зона " + entity.Handle + ": GUID отсутствует либо повторяется. Исправьте исходные зоны через AGPT_ZONE.");
            }
            return zones;
        }

        internal static double ReadPositive(Entity entity, string key)
        {
            if (!NumericData.TryParseFinite(AGPT.Stage3.XD.Get(entity, key), out double value) || value <= 0)
                throw PipeError(entity, "нужно положительное конечное " + key);
            return value;
        }

        internal static InvalidOperationException PipeError(Entity entity, string detail) =>
            new("Трубопровод " + entity.Handle + ": " + detail + ". Уточните свойства через AGPT_PIPE_DATA.");

        internal static double ActualLength(Database db, Entity entity, double scale)
        {
            if (entity is not Curve curve) throw PipeError(entity, "нужна исходная линия или полилиния");
            if (!string.Equals(AGPT.Stage3.XD.Get(entity, "PLAN_UNIT"), db.Insunits.ToString(), StringComparison.Ordinal))
                throw PipeError(entity, "единицы геометрии отсутствуют либо изменились; проверьте размеры");
            double nativeLength = Math.Abs(curve.GetDistanceAtParameter(curve.EndParam)
                - curve.GetDistanceAtParameter(curve.StartParam));
            if (!double.IsFinite(nativeLength) || nativeLength <= 0)
                throw PipeError(entity, "фактическая длина должна быть положительной и конечной");
            double length = PlanUnits.LengthInMetres(nativeLength, scale);
            if (!double.IsFinite(length) || length <= 0) throw PipeError(entity, "фактическая длина должна быть положительной и конечной");
            return length;
        }

        public static PipeVolumeSummary Read(Database db, Transaction tr)
        {
            if (db == null || tr == null) throw new ArgumentNullException(db == null ? nameof(db) : nameof(tr));
            var zones = ReadZones(db, tr);
            var result = new PipeVolumeSummary();
            foreach (string guid in zones.Keys) { result.Volumes.Add(guid, 0); result.Counts.Add(guid, 0); }
            if (!AGPT.Stage3.DrawingUnits.TryGetMetresPerUnit(db, out double scale))
                throw new InvalidOperationException(AGPT.Stage3.DrawingUnits.UnsupportedMessage);
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var source = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            foreach (ObjectId id in source)
            {
                if (tr.GetObject(id, OpenMode.ForRead) is not Entity entity || !IsSourcePipe(entity)) continue;
                if (string.IsNullOrWhiteSpace(AGPT.Stage3.XD.Get(entity, "SEG_TYPE"))
                    || string.IsNullOrWhiteSpace(AGPT.Stage3.XD.Get(entity, "SEG_ID")))
                    throw PipeError(entity, "отсутствуют исходные метаданные участка SEG_ID/SEG_TYPE");
                string zone = AGPT.Stage3.XD.Get(entity, "ZONE_GUID");
                if (string.IsNullOrWhiteSpace(zone) || !zones.ContainsKey(zone))
                    throw PipeError(entity, "ZONE_GUID не соответствует существующей исходной зоне");
                double nominal = ReadPositive(entity, "DY");
                double bore = ReadPositive(entity, "INNER_D_MM");
                if (ReadPositive(entity, "INNER_D_FOR_DY") != nominal)
                    throw PipeError(entity, "Ду изменился; подтвердите внутренний диаметр для нового типоразмера");
                double length = ActualLength(db, entity, scale);
                double volume = PipeVolumeCalculator.Compute(length, bore);
                double total = result.Volumes[zone] + volume;
                if (!double.IsFinite(total)) throw PipeError(entity, "суммарный внутренний объём не является конечным");
                result.Volumes[zone] = total;
                result.Counts[zone]++;
            }
            return result;
        }
    }
}
