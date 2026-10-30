using System;
using System.Collections.Generic;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using AcadApplication = Autodesk.AutoCAD.ApplicationServices.Application;

namespace AGPT.Cad
{
    public static class RoomBoundaryPicker
    {
        private const double PointTolerance = 1e-7;
        private const short AllObjectSnapModes = 16383;

        // Existing boundaries remain transaction-owned and open for read. A new boundary
        // is transient: the caller must dispose it or append/register it in its transaction.
        // The caller also validates ownership, tagging and the complete polygon geometry.
        public static Polyline Pick(Editor editor, Transaction tr, Database db, out bool isNew)
        {
            if (editor == null) throw new ArgumentNullException(nameof(editor));
            if (tr == null) throw new ArgumentNullException(nameof(tr));
            if (db == null) throw new ArgumentNullException(nameof(db));
            isNew = false;

            // Use WCS for the corner prompts and their rubber-band base points. Restore
            // the user's UCS for every exit, including cancellation and prompt exceptions.
            var points = new List<Point3d>();
            Matrix3d originalUcs = editor.CurrentUserCoordinateSystem;
            object originalOsMode = AcadApplication.GetSystemVariable("OSMODE");
            try
            {
                editor.CurrentUserCoordinateSystem = Matrix3d.Identity;
                AcadApplication.SetSystemVariable("OSMODE", AllObjectSnapModes);
                editor.WriteMessage("\nОбъектная привязка: все режимы включены на время выбора помещения.");
                while (true)
                {
                    var options = new PromptPointOptions(points.Count == 0
                        ? "\nЩёлкните первый угол помещения мышью или выберите "
                        : "\nСледующий угол помещения (Enter — замкнуть): ");
                    if (points.Count == 0) options.Keywords.Add("Contour", "Контур", "Контур");
                    options.AllowNone = true;
                    if (points.Count > 0)
                    {
                        options.UseBasePoint = true;
                        options.BasePoint = points[points.Count - 1];
                        options.UseDashedLine = true;
                    }
                    var result = editor.GetPoint(options);
                    if (result.Status == PromptStatus.Keyword && points.Count == 0)
                    {
                        var selection = new PromptEntityOptions("\nВыберите существующую замкнутую полилинию помещения: ");
                        selection.SetRejectMessage("\nТребуется полилиния контура.");
                        selection.AddAllowedClass(typeof(Polyline), true);
                        var selected = editor.GetEntity(selection);
                        if (selected.Status != PromptStatus.OK || selected.ObjectId.Database != db) return null;
                        return tr.GetObject(selected.ObjectId, OpenMode.ForRead) as Polyline;
                    }
                    if (result.Status == PromptStatus.None)
                    {
                        if (points.Count == 0) return null;
                        if (points.Count >= 3) break;
                        editor.WriteMessage("\nДля контура нужны как минимум три разных угла.");
                        continue;
                    }
                    if (result.Status != PromptStatus.OK) return null;

                    Point3d point = result.Value;
                    if (!double.IsFinite(point.X) || !double.IsFinite(point.Y) || !double.IsFinite(point.Z))
                    {
                        editor.WriteMessage("\nКоординаты угла должны быть конечными числами.");
                        continue;
                    }
                    if (points.Count > 0 && Math.Abs(point.Z - points[0].Z) > PointTolerance)
                    {
                        editor.WriteMessage("\nВсе углы должны находиться на одной горизонтальной отметке WCS.");
                        continue;
                    }
                    if (points.Count >= 3 && SamePoint(point, points[0])) break;
                    if (points.Exists(existing => SamePoint(existing, point)))
                    {
                        editor.WriteMessage("\nЭтот угол уже указан. Выберите другой угол.");
                        continue;
                    }
                    if (points.Count > 0) editor.DrawVector(points[points.Count - 1], point, 3, false);
                    points.Add(point);
                }
            }
            finally
            {
                try { AcadApplication.SetSystemVariable("OSMODE", originalOsMode); }
                finally
                {
                    editor.CurrentUserCoordinateSystem = originalUcs;
                    editor.Regen();
                }
            }

            // Allocate only after all prompts finish, so cancellation owns no DBObject.
            var boundary = new Polyline();
            try
            {
                boundary.Normal = Vector3d.ZAxis;
                boundary.Elevation = points[0].Z;
                for (int i = 0; i < points.Count; i++)
                    boundary.AddVertexAt(i, new Point2d(points[i].X, points[i].Y), 0, 0, 0);
                boundary.Closed = true;
                isNew = true;
                return boundary;
            }
            catch
            {
                boundary.Dispose();
                throw;
            }
        }

        private static bool SamePoint(Point3d a, Point3d b) =>
            Math.Abs(a.X - b.X) <= PointTolerance && Math.Abs(a.Y - b.Y) <= PointTolerance
            && Math.Abs(a.Z - b.Z) <= PointTolerance;
    }
}
