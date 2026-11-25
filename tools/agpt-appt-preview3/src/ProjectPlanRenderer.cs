using System;
using System.Linq;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace AGPT.Cad
{
    public static class ProjectPlanRenderer
    {
        // This is a prototype plan projection. Native CAD and engineering validation remain required.
        public static PlanRenderSummary Render(BlockTableRecord target, Transaction tr, PlanModel model,
            double originX, double originY, double paperWidth, double paperHeight,
            string systemPrefix, bool showPipes, bool showCables)
        {
            if (target == null || tr == null || model == null) throw new ArgumentNullException();
            if (!double.IsFinite(originX) || !double.IsFinite(originY) || !double.IsFinite(paperWidth) || !double.IsFinite(paperHeight)
                || paperWidth < 100 || paperHeight < 50) throw new ArgumentException("Content rectangle is too small or invalid.");
            if (!double.IsFinite(originX + paperWidth) || !double.IsFinite(originY + paperHeight))
                throw new ArgumentException("Content rectangle overflow.");
            if (systemPrefix != "AGPT" && systemPrefix != "APPT")
                throw new ArgumentException("Expected AGPT or APPT system prefix.", nameof(systemPrefix));
            string generatedLayer = systemPrefix + "-ALBUM-PLAN";
            var layerTable = (LayerTable)tr.GetObject(target.Database.LayerTableId, OpenMode.ForRead);
            ObjectId generatedLayerId;
            if (layerTable.Has(generatedLayer)) generatedLayerId = layerTable[generatedLayer];
            else
            {
                layerTable.UpgradeOpen();
                var layer = new LayerTableRecord { Name = generatedLayer };
                generatedLayerId = layerTable.Add(layer);
                tr.AddNewlyCreatedDBObject(layer, true);
            }
            var summary = new PlanRenderSummary();
            summary.Issues.AddRange(model.Issues);
            void Add(Entity e) { e.LayerId = generatedLayerId; target.AppendEntity(e); tr.AddNewlyCreatedDBObject(e, true); }
            void Text(string text, double x, double y, double maxWidth, double size = 2.2)
            {
                // Keep text inside the supplied paper rectangle even for long source names.
                int count = Math.Max(1, (int)Math.Floor(maxWidth / size));
                string clean = (text ?? "").Replace('\r', ' ').Replace('\n', ' ');
                if (clean.Length > count) clean = clean.Substring(0, Math.Max(0, count - 1)) + "…";
                Add(new DBText { TextString = clean, Position = new Point3d(x, y, 0), Height = size, WidthFactor = .65 });
            }
            Text(systemPrefix + " — ПРОТОТИП. План по геометрии DWG", originX + 3, originY + paperHeight - 5, paperWidth - 6, 2.5);
            Text("УГО прототипные; требуется проверка в САПР и инженером", originX + 3, originY + 3, paperWidth - 6, 2);
            Bounds2D? bounds;
            try { bounds = model.GetBounds(showPipes, showCables); }
            catch (ArgumentException ex)
            {
                summary.Issues.Add(ex.Message);
                Text("План не выведен: некорректная геометрия", originX + 3, originY + paperHeight / 2, paperWidth - 6);
                return summary;
            }
            if (!bounds.HasValue)
            {
                summary.Issues.Add("Нет фактической геометрии для вывода плана.");
                Text("Нет фактической геометрии DWG для плана", originX + 3, originY + paperHeight / 2, paperWidth - 6);
                return summary;
            }
            PlanViewport view;
            try { view = PlanViewport.ChooseScaleA3(bounds.Value, model.MetresPerUnit, originX + 8, originY + 12, paperWidth - 16, paperHeight - 28); }
            catch (ArgumentException ex)
            {
                summary.Issues.Add(ex.Message);
                Text("План не выведен: проверьте единицы и размер листа", originX + 3, originY + paperHeight / 2, paperWidth - 6);
                return summary;
            }
            summary.ScaleDenominator = view.ScaleDenominator;
            Text("М 1:" + view.ScaleDenominator.ToString("0", System.Globalization.CultureInfo.InvariantCulture), originX + paperWidth - 35, originY + paperHeight - 10, 32);
            void Path(System.Collections.Generic.List<PlanVertex> vertices, bool closed, short color)
            {
                var p = new Polyline(vertices.Count) { Closed = closed, ColorIndex = color };
                for (int i = 0; i < vertices.Count; i++)
                {
                    var v = view.Project(vertices[i]);
                    p.AddVertexAt(i, new Point2d(v.X, v.Y), v.Bulge, 0, 0);
                }
                Add(p);
            }
            void Label(string text, PlanVertex source)
            {
                var p = view.Project(source);
                Text(text, Math.Clamp(p.X + 2, originX + 3, originX + paperWidth - 73),
                    Math.Clamp(p.Y + 2, originY + 8, originY + paperHeight - 14), 70, 2);
            }
            foreach (var zone in model.Zones)
            {
                if (zone.Boundary.Count < 3) continue;
                Path(zone.Boundary, true, 8);
                var b = zone.Bounds ?? Bounds2D.FromVertices(zone.Boundary);
                Label(zone.Name + (zone.Floor.Length > 0 ? " / эт. " + zone.Floor : "")
                    + (zone.Elevation.HasValue ? " / отм. " + NumericData.Format(zone.Elevation.Value) : ""), new(b.MinX + b.Width / 2, b.MinY + b.Height / 2));
                summary.ZoneCount++;
            }
            foreach (var route in model.Routes.Where(r => r.Vertices.Count >= 2 && (r.Kind == "PIPE" ? showPipes : r.Kind == "CABLE" && showCables)))
            {
                Path(route.Vertices, route.Closed, route.Kind == "PIPE" ? (short)5 : (short)3);
                string annotation = route.Kind == "PIPE" ? "Труба" : "Кабель";
                if (route.Dy.HasValue) annotation += " Ду" + NumericData.Format(route.Dy.Value);
                if (!string.IsNullOrWhiteSpace(route.Mark)) annotation += " " + route.Mark;
                if (route.LengthMetres.HasValue) annotation += " L=" + route.LengthMetres.Value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + " м";
                if (route.From.Length > 0 || route.To.Length > 0) annotation += " " + route.From + " → " + route.To;
                Label(annotation, route.Vertices[route.Vertices.Count / 2]);
                summary.RouteCount++;
            }
            foreach (var device in model.Devices)
            {
                var p = view.Project(device.Position);
                // Paper-size prototype symbols identify actual source equipment positions.
                if (device.Kind == "NOZZLE")
                {
                    var triangle = new Polyline(3) { Closed = true, ColorIndex = 1 };
                    triangle.AddVertexAt(0, new Point2d(p.X, p.Y + 1.5), 0, 0, 0);
                    triangle.AddVertexAt(1, new Point2d(p.X - 1.3, p.Y - 1), 0, 0, 0);
                    triangle.AddVertexAt(2, new Point2d(p.X + 1.3, p.Y - 1), 0, 0, 0);
                    Add(triangle);
                }
                else
                {
                    Add(new Circle(new Point3d(p.X, p.Y, 0), Vector3d.ZAxis, 1.5) { ColorIndex = 1 });
                    if (device.Kind == "MODULE") Add(new Line(new Point3d(p.X - 1, p.Y, 0), new Point3d(p.X + 1, p.Y, 0)) { ColorIndex = 1 });
                }
                Label(device.Kind + (device.Mark.Length > 0 ? " " + device.Mark : " [" + device.Id + "]"), device.Position);
                summary.DeviceCount++;
            }
            summary.Issues.Add("Прототип: условные обозначения и читаемость подписей требуют проверки; архитектурная подоснова не синтезируется.");
            return summary;
        }
    }
}
