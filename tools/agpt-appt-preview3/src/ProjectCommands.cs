using System;
using System.Collections.Generic;
using System.Linq;
using AGPT.Shared;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;

[assembly: CommandClass(typeof(AGPT.ProjectCommands))]

namespace AGPT
{
    // These commands attach engineering data to real drawing objects. All prompts
    // complete before any database mutation; cancelling leaves the drawing intact.
    public class ProjectCommands
    {
        private static bool ReadText(Editor editor, string prompt, out string value, bool optional = false)
        {
            while (true)
            {
                var result = editor.GetString(new PromptStringOptions(prompt) { AllowSpaces = true });
                value = result.Status == PromptStatus.OK ? result.StringResult.Trim() : "";
                if (result.Status == PromptStatus.Cancel || result.Status == PromptStatus.Error) return false;
                if (result.Status != PromptStatus.OK && result.Status != PromptStatus.None) return false;
                if (optional || !string.IsNullOrWhiteSpace(value)) return true;
                editor.WriteMessage("\nОбязательное значение: введите данные или нажмите Esc для отмены.");
            }
        }

        private static bool ReadNumber(Editor editor, string prompt, Func<double, bool> valid, out double value)
        {
            value = 0;
            while (ReadText(editor, prompt, out string text))
            {
                try
                {
                    value = NumericData.ParseRequired(text);
                    if (valid(value)) return true;
                }
                catch (FormatException) { }
                editor.WriteMessage("\nНекорректное значение. Требуется конечное число в указанном диапазоне; Esc — отмена.");
            }
            return false;
        }

        private static Dictionary<string, string> Data(Entity entity, string app)
        {
            var data = new Dictionary<string, string>(StringComparer.Ordinal);
            using var buffer = entity.GetXDataForApplication(app);
            if (buffer != null)
                foreach (TypedValue item in buffer)
                    if (item.TypeCode == (int)DxfCode.ExtendedDataAsciiString)
                    {
                        string text = item.Value as string;
                        int separator = text?.IndexOf('=') ?? -1;
                        if (separator > 0) data[text.Substring(0, separator)] = text.Substring(separator + 1);
                    }
            return data;
        }

        private static string Value(Dictionary<string, string> data, string key) =>
            data.TryGetValue(key, out string value) ? value : "";

        internal static void RequireTaggable(Entity entity, string app, params string[] allowedKinds)
        {
            if (AGPT.Cad.AlbumOutput.IsGenerated(entity))
                throw new InvalidOperationException("Объект принадлежит сформированному альбому. Выберите исходный контур или устройство.");
            // Inspect every application's classification, including third-party tags.
            // Never turn an existing zone, pipe or device into a different object kind.
            using var buffer = entity.XData;
            string currentApp = "";
            var tags = new List<(string Application, string Key, string Value)>();
            if (buffer != null)
                foreach (TypedValue item in buffer)
                {
                    if (item.TypeCode == (int)DxfCode.ExtendedDataRegAppName)
                    { currentApp = item.Value.ToString(); continue; }
                    if (item.TypeCode != (int)DxfCode.ExtendedDataAsciiString) continue;
                    string text = item.Value as string;
                    int separator = text?.IndexOf('=') ?? -1;
                    if (separator <= 0) continue;
                    tags.Add((currentApp, text.Substring(0, separator), text.Substring(separator + 1)));
                }
            TaggingPolicy.RequireTaggable(app, entity.Layer, tags, allowedKinds);
        }

        private static void EnsureStorage(Database db, Transaction transaction, string app, string layer)
        {
            var apps = (RegAppTable)transaction.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (!apps.Has(app))
            {
                apps.UpgradeOpen();
                var record = new RegAppTableRecord { Name = app };
                apps.Add(record); transaction.AddNewlyCreatedDBObject(record, true);
            }
            var layers = (LayerTable)transaction.GetObject(db.LayerTableId, OpenMode.ForRead);
            if (!layers.Has(layer))
            {
                layers.UpgradeOpen();
                var record = new LayerTableRecord { Name = layer };
                layers.Add(record); transaction.AddNewlyCreatedDBObject(record, true);
            }
        }

        private static void SetData(Entity entity, string app, params (string key, string value)[] pairs)
        {
            var data = Data(entity, app);
            foreach (var pair in pairs) data[pair.key] = pair.value;
            var values = new List<TypedValue> { new TypedValue((int)DxfCode.ExtendedDataRegAppName, app) };
            values.AddRange(data.Select(pair => new TypedValue((int)DxfCode.ExtendedDataAsciiString, pair.Key + "=" + pair.Value)));
            using var buffer = new ResultBuffer(values.ToArray());
            entity.XData = buffer;
        }

        [CommandMethod("AGPT_ZONE")]
        public void Zone()
        {
            var document = Application.DocumentManager.MdiActiveDocument;
            if (document == null) return;
            var db = document.Database; var editor = document.Editor;
            if (!Stage3.DrawingUnits.TryGetMetresPerUnit(db, out double scale))
            { editor.WriteMessage("\n" + Stage3.DrawingUnits.UnsupportedMessage); return; }
            var options = new PromptEntityOptions("\nВыберите существующую замкнутую горизонтальную полилинию зоны: ");
            options.SetRejectMessage("\nТребуется 2D Polyline.");
            options.AddAllowedClass(typeof(Polyline), true);
            var selection = editor.GetEntity(options);
            if (selection.Status != PromptStatus.OK) return;
            try
            {
                using var transaction = db.TransactionManager.StartTransaction();
                var polyline = (Polyline)transaction.GetObject(selection.ObjectId, OpenMode.ForRead);
                RequireTaggable(polyline, "AGPT", "ZONE");
                if (!polyline.Closed || polyline.NumberOfVertices < 3
                    || Math.Abs(polyline.Normal.X) > 1e-9 || Math.Abs(polyline.Normal.Y) > 1e-9
                    || Math.Abs(Math.Abs(polyline.Normal.Z) - 1) > 1e-9 || !double.IsFinite(polyline.Elevation))
                    throw new InvalidOperationException("Требуется замкнутый горизонтальный контур минимум из трёх вершин.");
                for (int i = 0; i < polyline.NumberOfVertices; i++)
                {
                    var point = polyline.GetPoint3dAt(i);
                    if (!double.IsFinite(point.X) || !double.IsFinite(point.Y) || !double.IsFinite(point.Z)
                        || !double.IsFinite(polyline.GetBulgeAt(i)))
                        throw new InvalidOperationException("Контур содержит некорректные координаты.");
                }
                double area = polyline.Area;
                if (!double.IsFinite(area) || area <= 0) throw new InvalidOperationException("Площадь контура должна быть положительной.");
                using var form = new AGPT.Cad.GasZoneForm(area * scale * scale, Data(polyline, "AGPT"));
                if (Application.ShowModalDialog(form) != System.Windows.Forms.DialogResult.OK) return;
                var input = form.Input;
                string name = input.Name, gotv = input.Gotv;
                double h = input.Height.Value, fh = input.OpeningsArea.Value, tm = input.MinimumTemperature.Value;
                double cn = input.Concentration.Value, rho = input.Density.Value;
                double k4 = input.K4.Value, vtr = input.PipeVolume.Value;
                double volume = PlanUnits.AreaVolume(area, h, scale);
                string guid = Value(Data(polyline, "AGPT"), "GUID");
                if (string.IsNullOrWhiteSpace(guid)) guid = Guid.NewGuid().ToString();
                EnsureStorage(db, transaction, "AGPT", "AGPT-ZONE");
                polyline.UpgradeOpen(); polyline.Layer = "AGPT-ZONE";
                SetData(polyline, "AGPT", ("KIND", "ZONE"), ("GUID", guid), ("ZONE_NAME", name), ("GOTV", gotv),
                    ("VP", NumericData.Format(volume)), ("H", NumericData.Format(h)), ("FH", NumericData.Format(fh)),
                    ("TM", NumericData.Format(tm)), ("CN", NumericData.Format(cn)), ("RHO0", NumericData.Format(rho)),
                    ("K4", NumericData.Format(k4)), ("VTR", NumericData.Format(vtr)),
                    ("PLAN_UNIT", db.Insunits.ToString()), ("METRES_PER_UNIT", NumericData.Format(scale)),
                    ("VP_UNIT", "m3"), ("H_UNIT", "m"), ("FH_UNIT", "m2"), ("TM_UNIT", "degC"),
                    ("CN_UNIT", "%"), ("RHO0_UNIT", "kg/m3"), ("K4_UNIT", "1"), ("VTR_UNIT", "m3"));
                transaction.Commit();
                editor.WriteMessage("\n[AGPT_ZONE] " + name + ": Vp=" + NumericData.Format(volume) + " м³; GUID=" + guid);
            }
            catch (System.Exception ex) { editor.WriteMessage("\n[AGPT_ZONE] " + ex.Message); }
        }

        [CommandMethod("AGPT_CABLE")]
        public void GasCable() => Cable("AGPT");

        [CommandMethod("APPT_CABLE")]
        public void PowderCable() => Cable("APPT");

        private static void Cable(string app)
        {
            var document = Application.DocumentManager.MdiActiveDocument;
            if (document == null) return;
            var db = document.Database; var editor = document.Editor;
            if (!Stage3.DrawingUnits.TryGetMetresPerUnit(db, out double scale))
            { editor.WriteMessage("\n" + Stage3.DrawingUnits.UnsupportedMessage); return; }
            var options = new PromptEntityOptions("\nВыберите существующую линию/полилинию кабельной трассы: ");
            options.SetRejectMessage("\nНужна Line, Polyline или Polyline3d.");
            options.AddAllowedClass(typeof(Line), true); options.AddAllowedClass(typeof(Polyline), true);
            options.AddAllowedClass(typeof(Polyline3d), true);
            var selection = editor.GetEntity(options);
            if (selection.Status != PromptStatus.OK) return;
            try
            {
                using var transaction = db.TransactionManager.StartTransaction();
                var curve = (Curve)transaction.GetObject(selection.ObjectId, OpenMode.ForRead);
                RequireTaggable(curve, app, "CABLE");
                double length = PlanUnits.LengthInMetres(Math.Abs(curve.GetDistanceAtParameter(curve.EndParam)
                    - curve.GetDistanceAtParameter(curve.StartParam)), scale);
                if (!ReadText(editor, "\nНачало трассы (марка устройства): ", out string from)
                    || !ReadText(editor, "\nКонец трассы (марка устройства): ", out string to)
                    || !ReadText(editor, "\nМарка кабеля: ", out string mark)) return;
                string guid = Value(Data(curve, app), "GUID");
                if (string.IsNullOrWhiteSpace(guid)) guid = Guid.NewGuid().ToString();
                EnsureStorage(db, transaction, app, app + "-CABLE");
                curve.UpgradeOpen(); curve.Layer = app + "-CABLE";
                SetData(curve, app, ("KIND", "CABLE"), ("GUID", guid), ("FROM", from), ("TO", to),
                    ("CABLE_MARK", mark), ("L", NumericData.Format(length)), ("L_UNIT", "m"),
                    ("PLAN_UNIT", db.Insunits.ToString()), ("METRES_PER_UNIT", NumericData.Format(scale)));
                transaction.Commit();
                editor.WriteMessage("\n[" + app + "_CABLE] " + from + " → " + to + ": " + NumericData.Format(length) + " м; без неявного запаса.");
            }
            catch (System.Exception ex) { editor.WriteMessage("\n[" + app + "_CABLE] " + ex.Message); }
        }

        [CommandMethod("APPT_DEVICE")]
        public void PowderDevice()
        {
            var document = Application.DocumentManager.MdiActiveDocument;
            if (document == null) return;
            var db = document.Database; var editor = document.Editor;
            var options = new PromptEntityOptions("\nВыберите существующее вхождение блока оборудования АППТ: ");
            options.SetRejectMessage("\nТребуется BlockReference."); options.AddAllowedClass(typeof(BlockReference), true);
            var selection = editor.GetEntity(options);
            if (selection.Status != PromptStatus.OK) return;
            try
            {
                using var transaction = db.TransactionManager.StartTransaction();
                var block = (BlockReference)transaction.GetObject(selection.ObjectId, OpenMode.ForRead);
                RequireTaggable(block, "APPT", "MODULE", "EQUIPMENT");
                var kindOptions = new PromptKeywordOptions("\nФактический тип [MODULE/EQUIPMENT]: ") { AllowNone = false };
                kindOptions.Keywords.Add("MODULE"); kindOptions.Keywords.Add("EQUIPMENT");
                var kind = editor.GetKeywords(kindOptions);
                if (kind.Status != PromptStatus.OK) return;
                if (!ReadText(editor, "\nМарка оборудования: ", out string mark)
                    || !ReadText(editor, "\nНаименование оборудования: ", out string name)
                    || !ReadText(editor, "\nРоль (Enter — не задана): ", out string role, true)
                    || !ReadText(editor, "\nGUID зоны (Enter — без привязки): ", out string zone, true)) return;
                string guid = Value(Data(block, "APPT"), "GUID");
                if (string.IsNullOrWhiteSpace(guid)) guid = Guid.NewGuid().ToString();
                EnsureStorage(db, transaction, "APPT", "APPT-EQ");
                block.UpgradeOpen(); block.Layer = "APPT-EQ";
                SetData(block, "APPT", ("KIND", kind.StringResult), ("GUID", guid), ("MARK", mark),
                    ("NAME", name), ("ROLE", role), ("ZONE_GUID", zone));
                transaction.Commit();
                editor.WriteMessage("\n[APPT_DEVICE] " + kind.StringResult + ": " + mark + " — " + name);
            }
            catch (System.Exception ex) { editor.WriteMessage("\n[APPT_DEVICE] " + ex.Message); }
        }
    }
}
