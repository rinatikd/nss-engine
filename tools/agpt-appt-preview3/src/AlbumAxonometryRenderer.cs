using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace AGPT.Cad
{
    /// <summary>Paper-space geometry from captured source coordinates; never assigns installation heights.</summary>
    public static class AlbumAxonometryRenderer
    {
        public const int RoutesPerPage = 16;
        public static int PageCount(PlanModel model)
        {
            if (model == null) throw new ArgumentNullException(nameof(model));
            return Math.Max(1, (model.Routes.Count(r => r.Kind == "PIPE") + RoutesPerPage - 1) / RoutesPerPage);
        }

        public static PlanRenderSummary Render(BlockTableRecord target, Transaction tr, PlanModel model,
            double originX, double originY, double width, double height, string system, int pageIndex = 0)
        {
            if (target == null || tr == null || model == null) throw new ArgumentNullException();
            if (system != "AGPT" && system != "APPT") throw new ArgumentException("Expected AGPT or APPT.", nameof(system));
            if (!double.IsFinite(originX) || !double.IsFinite(originY) || !double.IsFinite(width)
                || !double.IsFinite(height) || width < 180 || height < 170
                || !double.IsFinite(originX + width) || !double.IsFinite(originY + height))
                throw new ArgumentException("A finite content rectangle of at least 180 by 170 is required.");
            if (pageIndex < 0 || pageIndex >= PageCount(model)) throw new ArgumentOutOfRangeException(nameof(pageIndex));
            var summary = new PlanRenderSummary();
            summary.Issues.AddRange(model.Issues);
            var layers = (LayerTable)tr.GetObject(target.Database.LayerTableId, OpenMode.ForRead);
            string layerName = system + "-ALBUM-AXO";
            ObjectId layerId;
            if (layers.Has(layerName)) layerId = layers[layerName];
            else
            {
                layers.UpgradeOpen();
                var layer = new LayerTableRecord { Name = layerName };
                layerId = layers.Add(layer);
                tr.AddNewlyCreatedDBObject(layer, true);
            }
            void Add(Entity entity)
            {
                entity.LayerId = layerId;
                target.AppendEntity(entity);
                tr.AddNewlyCreatedDBObject(entity, true);
            }
            // Conservative character widths keep long source values inside the content rectangle.
            void Text(string value, double x, double y, double available, double size = 2.1, short color = 7)
            {
                string clean = (value ?? "").Replace('\r', ' ').Replace('\n', ' ');
                int limit = Math.Max(1, (int)(available / size));
                if (clean.Length > limit) clean = clean.Substring(0, Math.Max(0, limit - 1)) + "…";
                Add(new DBText { TextString = clean, Position = new Point3d(x, y, 0), Height = size,
                    WidthFactor = .65, ColorIndex = color });
            }
            void Notice(string text)
            {
                Text("НЕТ ДАННЫХ ДЛЯ АКСОНОМЕТРИИ", originX + 4, originY + height * .6, width - 8, 3.1, 1);
                Text(text, originX + 4, originY + height * .6 - 8, width - 8, 2.4, 1);
                Text("Разметьте фактические трубы LINE / Polyline / Polyline3d с KIND=PIPE.",
                    originX + 4, originY + height * .6 - 16, width - 8);
                summary.Issues.Add(text);
            }
            Text("Трубопроводы — аксонометрическая проекция геометрии DWG", originX + 3, originY + height - 5, width - 6, 2.5);
            var pipes = model.Routes.Where(r => r.Kind == "PIPE").ToList();
            if (pipes.Count == 0) { Notice("В исходной модели отсутствуют размеченные трубопроводы."); return summary; }

            var paths = new Dictionary<PlanRoute, List<PlanVertex>>();
            foreach (var route in pipes)
            {
                try { paths.Add(route, AxonometricProjection.Sample(route)); }
                catch (ArgumentException ex) { summary.Issues.Add("Труба [" + route.Id + "]: " + ex.Message); }
            }
            if (paths.Count == 0) { Notice("Геометрия труб отсутствует или некорректна; проверьте исходный DWG."); return summary; }
            var devices = model.Devices.Where(d => d.Position.IsFinite
                && (d.Kind == "MODULE" || d.Kind == "NOZZLE" || d.Kind == "RVD"
                    || d.Kind == "ZPU_EM" || d.Kind == "SDU")).ToList();
            var sourcePoints = paths.Values.SelectMany(p => p).ToList();
            // Evaluate pipe heights separately: device elevations cannot establish pipe installation heights.
            bool planar = AxonometricProjection.IsPlanar(sourcePoints);
            string heightNote = planar
                ? "Проекция плоской сети; высотные отметки не заданы"
                : "Проекция по XYZ исходных труб; высоты не назначаются автоматически";
            Text(heightNote, originX + 3, originY + height - 12, width - 6, 2.1, planar ? (short)1 : (short)7);
            if (planar) summary.Issues.Add(heightNote);
            sourcePoints.AddRange(devices.Select(d => d.Position));
            double keyWidth = Math.Min(116, width * .4), drawingWidth = width - keyWidth - 14;
            AxonometricProjection projection;
            try
            {
                projection = AxonometricProjection.Fit(sourcePoints, originX + 5, originY + 15,
                    drawingWidth, height - 39);
            }
            catch (ArgumentException)
            {
                Notice("Границы сети не позволяют построить проекцию.");
                return summary;
            }
            Point3d Project(PlanVertex p)
            {
                var v = projection.Project(p);
                return new Point3d(v.X, v.Y, 0);
            }
            var selected = pipes.Skip(pageIndex * RoutesPerPage).Take(RoutesPerPage).ToList();
            foreach (var pair in paths)
            {
                bool current = selected.Contains(pair.Key);
                var polyline = new Polyline(pair.Value.Count) { ColorIndex = current ? (short)5 : (short)8 };
                for (int i = 0; i < pair.Value.Count; i++)
                {
                    var p = Project(pair.Value[i]);
                    polyline.AddVertexAt(i, new Point2d(p.X, p.Y), 0, 0, 0);
                }
                Add(polyline);
                if (current) summary.RouteCount++;
            }
            double keyX = originX + width - keyWidth;
            Text("Участки / Ду / фактическая длина", keyX, originY + height - 21, keyWidth - 2, 2);
            for (int i = 0; i < selected.Count; i++)
            {
                var route = selected[i];
                int number = pageIndex * RoutesPerPage + i + 1;
                double y = originY + height - 29 - i * (height - 43) / RoutesPerPage;
                string name = string.IsNullOrWhiteSpace(route.Mark) ? route.Id : route.Mark + " [" + route.Id + "]";
                Text(number + ". " + name, keyX, y, keyWidth - 2, 1.9);
                string dn = route.Dy.HasValue && double.IsFinite(route.Dy.Value) && route.Dy.Value > 0
                    ? "Ду " + NumericData.Format(route.Dy.Value) : "Ду не задан";
                string length = route.LengthMetres.HasValue && double.IsFinite(route.LengthMetres.Value) && route.LengthMetres.Value > 0
                    ? "L=" + route.LengthMetres.Value.ToString("0.###", CultureInfo.InvariantCulture) + " м" : "L: нет единиц/данных";
                Text(dn + "; " + length + (paths.ContainsKey(route) ? "" : "; нет геометрии"), keyX, y - 3.1, keyWidth - 2, 1.8);
                if (!paths.TryGetValue(route, out var points)) continue;
                if (!planar)
                {
                    bool metres = double.IsFinite(model.MetresPerUnit) && model.MetresPerUnit > 0;
                    double units = metres ? model.MetresPerUnit : 1;
                    Text("Z " + NumericData.Format(points.Min(p => p.Z) * units) + " … "
                        + NumericData.Format(points.Max(p => p.Z) * units) + (metres ? " м (WCS)" : " ед. DWG (WCS)"),
                        keyX, y - 6.2, keyWidth - 2, 1.7);
                }
                var middle = Project(AxonometricProjection.Midpoint(points));
                Text(number.ToString(CultureInfo.InvariantCulture),
                    Math.Clamp(middle.X + 1, originX + 3, keyX - 7),
                    Math.Clamp(middle.Y + 1, originY + 12, originY + height - 20), 6, 2.1, 5);
            }
            foreach (var device in devices)
            {
                var p = Project(device.Position);
                if (device.Kind == "NOZZLE")
                {
                    var symbol = new Polyline(3) { Closed = true, ColorIndex = 1 };
                    symbol.AddVertexAt(0, new Point2d(p.X, p.Y - 1.5), 0, 0, 0);
                    symbol.AddVertexAt(1, new Point2d(p.X - 1.4, p.Y + 1.1), 0, 0, 0);
                    symbol.AddVertexAt(2, new Point2d(p.X + 1.4, p.Y + 1.1), 0, 0, 0);
                    Add(symbol);
                }
                else Add(new Circle(p, Vector3d.ZAxis, 1.5) { ColorIndex = 1 });
                string kind = device.Kind == "MODULE" ? "МГП" : device.Kind == "NOZZLE" ? "Насадок" : device.Kind;
                Text(kind + " " + (string.IsNullOrWhiteSpace(device.Mark) ? device.Id : device.Mark),
                    Math.Clamp(p.X + 2, originX + 3, keyX - 42),
                    Math.Clamp(p.Y - 3, originY + 11, originY + height - 20), 40, 1.8, 1);
                summary.DeviceCount++;
            }
            Text("Без масштаба. УГО оборудования условные; позиции взяты из DWG.", originX + 3, originY + 6, width - 6, 1.9);
            if (PageCount(model) > 1)
                Text("Подписи участков: страница " + (pageIndex + 1) + "/" + PageCount(model)
                    + "; серым — остальные трубы сети", originX + 3, originY + 1.5, width - 6, 1.8);
            return summary;
        }

    }
}
