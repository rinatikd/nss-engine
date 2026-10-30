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
            foreach (var pair in pairs)
                if (pair.value == null) data.Remove(pair.key); else data[pair.key] = pair.value;
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
            Polyline boundary = null;
            bool isNew = false, registered = false;
            try
            {
                using var tr = db.TransactionManager.StartTransaction();
                boundary = AGPT.Cad.RoomBoundaryPicker.Pick(editor, tr, db, out isNew);
                if (boundary == null) return;
                if (!isNew)
                {
                    var blockTable = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    if (boundary.OwnerId != blockTable[BlockTableRecord.ModelSpace])
                        throw new InvalidOperationException("Выберите исходный контур в пространстве модели.");
                    RequireTaggable(boundary, "AGPT", "ZONE");
                }
                if (!boundary.Closed || boundary.NumberOfVertices < 3
                    || Math.Abs(boundary.Normal.X) > 1e-9 || Math.Abs(boundary.Normal.Y) > 1e-9)
                    throw new InvalidOperationException("Нужен замкнутый горизонтальный контур минимум из трёх углов.");
                if (isNew) RoomPolygon.Validate(Enumerable.Range(0, boundary.NumberOfVertices)
                    .Select(i => { var p = boundary.GetPoint3dAt(i); return new PlanVertex(p.X, p.Y, p.Z); }).ToArray());
                double area = boundary.Area;
                if (!double.IsFinite(area) || area <= 0) throw new InvalidOperationException("Некорректная площадь помещения.");
                var bounds = boundary.GeometricExtents;
                double? declared = db.Insunits switch {
                    UnitsValue.Millimeters => .001, UnitsValue.Centimeters => .01, UnitsValue.Meters => 1.0, _ => null
                };
                var suggestion = RoomUnitInference.Suggest(bounds.MaxPoint.X - bounds.MinPoint.X,
                    bounds.MaxPoint.Y - bounds.MinPoint.Y, declared, AGPT.Cad.RoomUnitEvidence.Read(db, tr, boundary));
                var existing = isNew ? new Dictionary<string, string>() : Data(boundary, "AGPT");
                var discovered = AGPT.Cad.RoomModelFacts.Read(db, tr, boundary, existing);
                var facts = discovered.Values;
                string Read(string key) => facts.TryGetValue(key, out string value) ? value : "";
                double? Number(string key) => NumericData.TryParseFinite(Read(key), out double value) ? value : null;
                double? modelHeight = Number("H");
                bool validHeight = modelHeight.HasValue && modelHeight.Value > 0 && double.IsFinite(modelHeight.Value);
                var heightOptions = new PromptDoubleOptions("\nВысота помещения, м: ") {
                    AllowNegative = false, AllowZero = false, AllowNone = validHeight, UseDefaultValue = validHeight
                };
                if (validHeight) heightOptions.DefaultValue = modelHeight.Value;
                var heightResult = editor.GetDouble(heightOptions);
                if (heightResult.Status != PromptStatus.OK && !(heightResult.Status == PromptStatus.None && validHeight)) return;
                double roomHeight = heightResult.Status == PromptStatus.OK ? heightResult.Value : modelHeight.Value;
                if (!double.IsFinite(roomHeight) || roomHeight <= 0)
                    throw new InvalidOperationException("Высота должна быть положительным конечным числом в метрах.");
                double? explicitTemperature = Number("TM");
                bool disputedTemperature = discovered.UnresolvedFields.Contains("TM")
                    || (!string.IsNullOrWhiteSpace(Read("TM")) && !explicitTemperature.HasValue)
                    || (Read("TM_UNRESOLVED") == "1" && !explicitTemperature.HasValue);
                double? temperature;
                try { temperature = RoomTemperaturePolicy.Resolve(explicitTemperature, disputedTemperature); }
                catch (ArgumentException ex) { temperature = null; discovered.Issues.Add("TM: " + ex.Message); }
                bool usedTemperatureDefault = !explicitTemperature.HasValue && temperature.HasValue && !disputedTemperature;
                string guid = Read("GUID");
                if (string.IsNullOrWhiteSpace(guid)) guid = Guid.NewGuid().ToString();
                string name = Read("ZONE_NAME");
                if (string.IsNullOrWhiteSpace(name)) name = "Помещение " + guid.Substring(0, Math.Min(8, guid.Length));
                string explicitAgent = Read("GOTV");
                bool disputedAgent = discovered.UnresolvedFields.Contains("GOTV")
                    || (Read("GOTV_UNRESOLVED") == "1" && string.IsNullOrWhiteSpace(explicitAgent));
                string gasAgent = RoomGasPolicy.Resolve(explicitAgent, disputedAgent);
                bool usedGasDefault = string.IsNullOrWhiteSpace(explicitAgent) && !string.IsNullOrWhiteSpace(gasAgent);
                var input = new GasZoneInput { Name = name, Gotv = gasAgent, Height = roomHeight,
                    OpeningsArea = Number("FH"), MinimumTemperature = temperature };
                if (input.Gotv == GasAgentCatalog.SupportedAgent)
                {
                    var profile = GasAgentCatalog.GetReferenceProfile(input.Gotv);
                    input.Concentration = profile.Concentration; input.Density = profile.VaporDensity;
                }
                var missing = input.DescribeModelIssues();
                bool unitVerified = suggestion.IsVerified && ((int)db.Insunits == 0 || declared.HasValue);
                if (!unitVerified) missing.Add("масштаб не подтверждён: " + suggestion.Reason);
                string missingSummary = string.Join("; ", missing.Select(issue => issue.Split(':')[0]));
                if (missingSummary.Length > 100) missingSummary = missingSummary.Substring(0, 100);
                double squareMetres = area * suggestion.MetresPerUnit * suggestion.MetresPerUnit;
                if (!double.IsFinite(squareMetres) || squareMetres <= 0) throw new InvalidOperationException("Площадь вне числового диапазона.");
                string volumeText = null;
                if (input.Height.HasValue && input.Height.Value > 0)
                    volumeText = NumericData.Format(PlanUnits.AreaVolume(area, input.Height.Value, suggestion.MetresPerUnit));
                EnsureStorage(db, tr, "AGPT", "AGPT-ZONE");
                if (isNew)
                {
                    var blockTable = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var model = (BlockTableRecord)tr.GetObject(blockTable[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    model.AppendEntity(boundary); tr.AddNewlyCreatedDBObject(boundary, true); registered = true;
                }
                else boundary.UpgradeOpen();
                boundary.Layer = "AGPT-ZONE";
                // Facts with unknown values are removed, not supplied as numeric defaults.
                SetData(boundary, "AGPT", ("KIND", "ZONE"), ("GUID", guid), ("ZONE_NAME", name),
                    ("GOTV", input.Gotv), ("GOTV_UNRESOLVED", string.IsNullOrWhiteSpace(input.Gotv) ? "1" : null),
                    ("H", input.Height.HasValue ? NumericData.Format(input.Height.Value) : null),
                    ("FH", input.OpeningsArea.HasValue ? NumericData.Format(input.OpeningsArea.Value) : null),
                    ("TM", input.MinimumTemperature.HasValue ? NumericData.Format(input.MinimumTemperature.Value) : null),
                    ("TM_UNRESOLVED", input.MinimumTemperature.HasValue ? null : "1"),
                    ("CN", input.Concentration.HasValue ? NumericData.Format(input.Concentration.Value) : null),
                    ("RHO0", input.Density.HasValue ? NumericData.Format(input.Density.Value) : null),
                    ("VP", volumeText), ("AREA_M2", NumericData.Format(squareMetres)),
                    ("ROOM_CAPTURE", "1"), ("ROOM_STATUS", missing.Count == 0 ? "READY" : "INCOMPLETE"),
                    ("MISSING_FIELDS", missing.Count == 0 ? null : missingSummary),
                    ("UNIT_VERIFIED", unitVerified ? "1" : "0"), ("UNIT_CONFIDENCE", suggestion.Confidence.ToString()),
                    ("PLAN_UNIT", db.Insunits.ToString()), ("METRES_PER_UNIT", NumericData.Format(suggestion.MetresPerUnit)),
                    ("K4", null), ("K4_INPUT_MODE", null), ("VTR", null),
                    ("GAS_PROFILE", input.Concentration.HasValue ? "HFC227EA-PROJECT-REFERENCE-1" : null),
                    ("GAS_PROFILE_SOURCE", input.Concentration.HasValue ? "ProjectReference" : null));
                foreach (string key in new[] { "ZONE_NAME", "H", "FH", "TM", "GOTV" })
                {
                    string source = Read(key + "__SOURCE");
                    if (key == "H") source = "ManualOverride";
                    if (key == "GOTV" && usedGasDefault) source = RoomGasPolicy.DefaultSource;
                    if (key == "TM" && usedTemperatureDefault) source = RoomTemperaturePolicy.DefaultSource;
                    if (key == "ZONE_NAME" && string.IsNullOrWhiteSpace(Read("ZONE_NAME"))) source = "GeneratedIdentifier";
                    if (source.Length > 180) source = source.Substring(0, 180);
                    SetData(boundary, "AGPT", (key + "__SOURCE", string.IsNullOrWhiteSpace(source) ? null : source));
                }
                tr.Commit();
                editor.WriteMessage("\n[AGPT_ZONE] " + name + ": предлагается " + suggestion.UnitName + "; " + suggestion.Reason);
                double widthMetres = (bounds.MaxPoint.X - bounds.MinPoint.X) * suggestion.MetresPerUnit;
                double depthMetres = (bounds.MaxPoint.Y - bounds.MinPoint.Y) * suggestion.MetresPerUnit;
                string Compact(double value) => value.ToString("G6", System.Globalization.CultureInfo.InvariantCulture);
                editor.WriteMessage("\nКоэффициент: " + Compact(suggestion.MetresPerUnit) + " м/ед. чертежа. Габариты XY: "
                    + Compact(widthMetres) + " × " + Compact(depthMetres) + " м (ограничивающий прямоугольник).");
                if (usedGasDefault) editor.WriteMessage("\nГОТВ: HFC-227ea — настройка по умолчанию пользователя.");
                if (usedTemperatureDefault) editor.WriteMessage("\nМинимальная температура: 18 °C — настройка по умолчанию пользователя. Изменение: AGPT_TEMPERATURE.");
                editor.WriteMessage("\nПлощадь при принятом масштабе: " + NumericData.Format(squareMetres) + " м². "
                    + (missing.Count == 0 ? "Исходные данные получены из модели." : "Контур сохранён; расчётные исходные данные пока неполны."));
                foreach (string issue in discovered.Issues.Concat(missing)) editor.WriteMessage("\n[Данные модели] " + issue);
            }
            catch (System.Exception ex) { editor.WriteMessage("\n[AGPT_ZONE] " + ex.Message); }
            finally { if (isNew && !registered) boundary?.Dispose(); }
        }

        [CommandMethod("AGPT_TEMPERATURE")]
        public void ChangeRoomTemperature()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var editor = doc.Editor; var db = doc.Database;
            var selection = editor.GetEntity("\nВыберите контур помещения для изменения температуры: ");
            if (selection.Status != PromptStatus.OK) return;
            try
            {
                using var tr = db.TransactionManager.StartTransaction();
                if (tr.GetObject(selection.ObjectId, OpenMode.ForRead) is not Polyline boundary
                    || Stage3.XD.Get(boundary, "KIND") != "ZONE")
                    throw new InvalidOperationException("Выберите размеченный контур AGPT_ZONE.");
                RequireTaggable(boundary, "AGPT", "ZONE");
                var data = Data(boundary, "AGPT");
                double current = NumericData.TryParseFinite(Value(data, "TM"), out double known)
                    && known >= GasZoneInput.MinimumTemperatureC ? known : RoomTemperaturePolicy.DefaultC;
                var options = new PromptDoubleOptions("\nМинимальная температура помещения, °C: ") {
                    AllowNegative = true, AllowZero = true, UseDefaultValue = true, DefaultValue = current
                };
                var result = editor.GetDouble(options);
                if (result.Status != PromptStatus.OK) return;
                double temperature = RoomTemperaturePolicy.Resolve(result.Value, false).Value;
                boundary.UpgradeOpen();
                SetData(boundary, "AGPT", ("TM", NumericData.Format(temperature)), ("TM_UNIT", "degC"),
                    ("TM__SOURCE", "ManualOverride"), ("TM_UNRESOLVED", null));
                if (Value(data, "ROOM_CAPTURE") == "1")
                {
                    double? Number(string key) => NumericData.TryParseFinite(Value(data, key), out double value) ? value : null;
                    var updated = new GasZoneInput { Name = Value(data, "ZONE_NAME"), Gotv = Value(data, "GOTV"),
                        Height = Number("H"), OpeningsArea = Number("FH"), MinimumTemperature = temperature,
                        Concentration = Number("CN"), Density = Number("RHO0") };
                    var issues = updated.DescribeModelIssues();
                    if (Value(data, "UNIT_VERIFIED") != "1") issues.Add("масштаб не подтверждён");
                    string summary = string.Join("; ", issues.Select(issue => issue.Split(':')[0]));
                    if (summary.Length > 100) summary = summary.Substring(0, 100);
                    SetData(boundary, "AGPT", ("ROOM_STATUS", issues.Count == 0 ? "READY" : "INCOMPLETE"),
                        ("MISSING_FIELDS", issues.Count == 0 ? null : summary));
                }
                tr.Commit();
                editor.WriteMessage("\n[AGPT_TEMPERATURE] Сохранено " + NumericData.Format(temperature)
                    + " °C. Явная правка не будет сброшена автоматическим захватом.");
            }
            catch (System.Exception ex) { editor.WriteMessage("\n[AGPT_TEMPERATURE] " + ex.Message); }
        }

        [CommandMethod("AGPT_ZONE_EDIT")]
        public void ZoneEdit()
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
                var originalFacts = Data(polyline, "AGPT");
                using var form = new AGPT.Cad.GasZoneForm(area * scale * scale, originalFacts);
                if (Application.ShowModalDialog(form) != System.Windows.Forms.DialogResult.OK) return;
                var input = form.Input;
                string name = input.Name, gotv = input.Gotv;
                double h = input.Height.Value, fh = input.OpeningsArea.Value, tm = input.MinimumTemperature.Value;
                double cn = input.Concentration.Value, rho = input.Density.Value;
                double volume = PlanUnits.AreaVolume(area, h, scale);
                string guid = Value(Data(polyline, "AGPT"), "GUID");
                if (string.IsNullOrWhiteSpace(guid)) guid = Guid.NewGuid().ToString();
                EnsureStorage(db, transaction, "AGPT", "AGPT-ZONE");
                polyline.UpgradeOpen(); polyline.Layer = "AGPT-ZONE";
                SetData(polyline, "AGPT", ("KIND", "ZONE"), ("GUID", guid), ("ZONE_NAME", name), ("GOTV", gotv), ("GOTV_UNRESOLVED", null),
                    ("VP", NumericData.Format(volume)), ("H", NumericData.Format(h)), ("FH", NumericData.Format(fh)),
                    ("TM", NumericData.Format(tm)), ("TM_UNRESOLVED", null), ("CN", NumericData.Format(cn)), ("RHO0", NumericData.Format(rho)),
                    ("K4", null), ("K4_INPUT_MODE", null), ("VTR", null),
                    ("ROOM_STATUS", "READY"), ("MISSING_FIELDS", null), ("UNIT_VERIFIED", "1"),
                    ("GAS_PROFILE", "HFC227EA-PROJECT-REFERENCE-1"), ("GAS_PROFILE_SOURCE", "ProjectReference"),
                    ("PLAN_UNIT", db.Insunits.ToString()), ("METRES_PER_UNIT", NumericData.Format(scale)),
                    ("VP_UNIT", "m3"), ("H_UNIT", "m"), ("FH_UNIT", "m2"), ("TM_UNIT", "degC"),
                    ("CN_UNIT", "%"), ("RHO0_UNIT", "kg/m3"), ("K4_UNIT", null), ("VTR_UNIT", null));
                var editedFacts = Data(polyline, "AGPT");
                foreach (string key in new[] { "ZONE_NAME", "H", "FH", "TM", "GOTV" })
                {
                    string before = Value(originalFacts, key), after = Value(editedFacts, key);
                    bool equivalent = before == after || (NumericData.TryParseFinite(before, out double a)
                        && NumericData.TryParseFinite(after, out double b) && a == b);
                    if (!equivalent) SetData(polyline, "AGPT", (key + "__SOURCE", "ManualOverride"));
                }
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
