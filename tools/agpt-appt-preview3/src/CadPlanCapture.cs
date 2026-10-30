using System;
using System.Collections.Generic;
using System.Linq;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace AGPT.Cad
{
    public static class PlanModelCapture
    {
        public static PlanModel Read(Database db, Transaction tr, string applicationName, string zoneLayer)
        {
            if (db == null || tr == null || string.IsNullOrWhiteSpace(applicationName)) throw new ArgumentException("Database, transaction and application are required.");
            var model = new PlanModel();
            switch (db.Insunits)
            {
                case UnitsValue.Millimeters: model.MetresPerUnit = .001; break;
                case UnitsValue.Centimeters: model.MetresPerUnit = .01; break;
                case UnitsValue.Meters: model.MetresPerUnit = 1; break;
                default: model.Issues.Add("INSUNITS: единицы неизвестны; план не может быть выведен в масштабе."); break;
            }
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var source = (BlockTableRecord)tr.GetObject(table[BlockTableRecord.ModelSpace], OpenMode.ForRead);
            foreach (ObjectId objectId in source)
            {
                var entity = tr.GetObject(objectId, OpenMode.ForRead) as Entity;
                if (entity == null || AGPT.Cad.AlbumOutput.IsGenerated(entity)) continue;
                string handle = entity.Handle.ToString();
                try
                {
                    var data = ReadData(entity, applicationName);
                    if (data.Count == 0)
                    {
                        if (string.Equals(entity.Layer, zoneLayer, StringComparison.OrdinalIgnoreCase))
                            model.Issues.Add($"Объект зоны [{handle}]: нет XData приложения {applicationName}; граница не включена.");
                        continue;
                    }
                    string Get(string key) => data.TryGetValue(key, out var value) ? value : "";
                    string id = string.IsNullOrWhiteSpace(Get("GUID")) ? handle : Get("GUID");
                    string kind = Get("KIND"), name = Get("ZONE_NAME");
                    bool zoneCandidate = kind == "ZONE" || string.Equals(entity.Layer, zoneLayer, StringComparison.OrdinalIgnoreCase);
                    if (zoneCandidate)
                    {
                        if (!ZoneIdentity.IsZone(kind, entity.Layer, zoneLayer, name, Get("VP")))
                            throw new FormatException("Неполные или неверные данные зоны (слой, KIND, ZONE_NAME, VP).");
                        var zone = new PlanZone { Id = id, Name = name, Floor = Get("FLOOR"), Elevation = Number(data, "ELEVATION") };
                        if (entity is Polyline polygon && polygon.Closed && polygon.NumberOfVertices >= 3)
                        {
                            if (!double.IsFinite(polygon.Area) || polygon.Area <= 0) throw new FormatException("Зона имеет нулевую или некорректную площадь.");
                            zone.Boundary = Vertices(entity, tr);
                            zone.Bounds = Extents(entity);
                        }
                        else model.Issues.Add($"Зона {name} [{id}]: нет замкнутой физической границы Polyline; геометрия не создана.");
                        model.Zones.Add(zone);
                        continue;
                    }
                    bool pipe = kind == "PIPE" || !string.IsNullOrWhiteSpace(Get("SEG_TYPE"));
                    if (pipe || kind == "CABLE")
                    {
                        var vertices = Vertices(entity, tr);
                        if (vertices.Count < 2) throw new FormatException("Трасса должна иметь LINE/Polyline/Polyline3d геометрию.");
                        double? dy = Number(data, "DY"), storedLength = Number(data, "L");
                        if (dy.HasValue && dy <= 0 || storedLength.HasValue && storedLength <= 0) throw new FormatException("DY/L должны быть положительными.");
                        double? length = null;
                        if (entity is Curve curve && model.MetresPerUnit > 0)
                        {
                            double native = Math.Abs(curve.GetDistanceAtParameter(curve.EndParam) - curve.GetDistanceAtParameter(curve.StartParam));
                            if (!double.IsFinite(native) || native <= 0) throw new FormatException("Некорректная фактическая длина трассы.");
                            length = native * model.MetresPerUnit;
                        }
                        if (storedLength.HasValue && Get("L_UNIT") != "m") model.Issues.Add($"Трасса [{id}]: единица L не указана как m; использована фактическая длина геометрии.");
                        if (storedLength.HasValue && length.HasValue && Get("L_UNIT") == "m" && Math.Abs(storedLength.Value - length.Value) > Math.Max(.001, length.Value * .001))
                            model.Issues.Add($"Трасса [{id}]: L в XData отличается от геометрии; использована фактическая длина.");
                        model.Routes.Add(new PlanRoute { Id = id, Kind = pipe ? "PIPE" : "CABLE", Mark = pipe ? Get("MARK") : Get("CABLE_MARK"),
                            From = Get("FROM"), To = Get("TO"), Dy = dy, LengthMetres = length, Vertices = vertices, Bounds = Extents(entity),
                            Closed = entity is Polyline p && p.Closed || entity is Polyline3d p3 && p3.Closed });
                        continue;
                    }
                    if (!string.IsNullOrWhiteSpace(kind))
                    {
                        if (!new[] { "MODULE", "NOZZLE", "KSID", "MPT", "UDP", "TABLO", "IP", "OPOP", "RVD", "SDU", "ZPU_EM" }.Contains(kind, StringComparer.Ordinal))
                            model.Issues.Add($"Объект [{id}]: неизвестный KIND={kind}; только прототипное обозначение с исходным именем.");
                        var bounds = Extents(entity);
                        var actualExtents = entity.GeometricExtents;
                        Point3d position = entity is BlockReference block ? block.Position : new Point3d(bounds.MinX + bounds.Width / 2, bounds.MinY + bounds.Height / 2,
                            actualExtents.MinPoint.Z + (actualExtents.MaxPoint.Z - actualExtents.MinPoint.Z) / 2);
                        var vertex = new PlanVertex(position.X, position.Y, position.Z);
                        if (!vertex.IsFinite) throw new FormatException("Некорректная позиция оборудования.");
                        model.Devices.Add(new PlanDevice { Id = id, Kind = kind, Mark = Get("MARK"), ZoneId = Get("ZONE_GUID"), Position = vertex });
                    }
                    else model.Issues.Add($"Объект [{id}]: отсутствует KIND/SEG_TYPE; назначение неизвестно.");
                }
                catch (System.Exception ex) { model.Issues.Add($"Объект [{handle}] пропущен: {ex.Message}"); }
            }
            if (model.Zones.Count == 0) model.Issues.Add("В DWG отсутствуют размеченные зоны; ручные расчётные зоны не определяют геометрию.");
            foreach (var device in model.Devices.Where(d => d.ZoneId.Length > 0 && !model.Zones.Any(z => z.Id == d.ZoneId)))
                model.Issues.Add($"Оборудование [{device.Id}]: зона {device.ZoneId} отсутствует.");
            return model;
        }
        private static Dictionary<string, string> ReadData(Entity entity, string app)
        {
            var data = new Dictionary<string, string>(StringComparer.Ordinal);
            using var buffer = entity.GetXDataForApplication(app);
            if (buffer == null) return data;
            foreach (TypedValue value in buffer)
            {
                if (value.TypeCode != (int)DxfCode.ExtendedDataAsciiString || value.Value is not string text) continue;
                int separator = text.IndexOf('=');
                if (separator <= 0) continue;
                string key = text.Substring(0, separator);
                if (!data.TryAdd(key, text.Substring(separator + 1))) throw new FormatException("Повторяющийся ключ XData: " + key);
            }
            return data;
        }
        private static double? Number(Dictionary<string, string> data, string key)
        {
            if (!data.TryGetValue(key, out string text) || string.IsNullOrWhiteSpace(text)) return null;
            if (!NumericData.TryParseFinite(text, out var number)) throw new FormatException("Некорректное числовое XData: " + key);
            return number;
        }
        private static Bounds2D Extents(Entity entity)
        {
            var e = entity.GeometricExtents;
            var bounds = new Bounds2D(e.MinPoint.X, e.MinPoint.Y, e.MaxPoint.X, e.MaxPoint.Y);
            if (!bounds.IsValid) throw new FormatException("Некорректные геометрические границы.");
            return bounds;
        }
        private static List<PlanVertex> Vertices(Entity entity, Transaction tr)
        {
            var result = new List<PlanVertex>();
            void Add(Point3d p, double bulge = 0)
            {
                var v = new PlanVertex(p.X, p.Y, p.Z, bulge);
                if (!v.IsFinite) throw new FormatException("Нечисловые координаты или bulge.");
                result.Add(v);
            }
            if (entity is Line line) { Add(line.StartPoint); Add(line.EndPoint); }
            else if (entity is Polyline polyline)
            {
                if (Math.Abs(Math.Abs(polyline.Normal.Z) - 1) > 1e-9) throw new FormatException("Наклонная плоскость Polyline не поддерживается для плана.");
                for (int i = 0; i < polyline.NumberOfVertices; i++) Add(polyline.GetPoint3dAt(i), polyline.GetBulgeAt(i) * (polyline.Normal.Z < 0 ? -1 : 1));
            }
            else if (entity is Polyline3d polyline3d)
            {
                if (polyline3d.PolyType != Poly3dType.SimplePoly) throw new FormatException("Сглаженная Polyline3d требует преобразования в физическую ломаную.");
                foreach (ObjectId vertexId in polyline3d) Add(((PolylineVertex3d)tr.GetObject(vertexId, OpenMode.ForRead)).Position);
            }
            return result;
        }
    }
}
