using System;
using System.Collections.Generic;
using System.Globalization;
using AGPT.Shared;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;

[assembly: CommandClass(typeof(AGPT.RoomPresentationCommands))]

namespace AGPT
{
    /// <summary>Presentation of source rooms; engineering values remain on their contours.</summary>
    public class RoomPresentationCommands
    {
        private const string OwnerApp = "AGPT_ROOM_PRESENTATION";
        private const string GeneratedApp = "AGPT_ALBUM_OUTPUT";
        private const string LabelLayer = "AGPT-ROOM-LABEL";

        private static bool IsSource(Polyline boundary, ObjectId modelSpace) =>
            boundary != null && boundary.OwnerId == modelSpace && boundary.Closed
            && boundary.NumberOfVertices >= 3 && boundary.Layer == "AGPT-ZONE"
            && Stage3.XD.Get(boundary, "KIND") == "ZONE"
            && !Cad.AlbumOutput.IsGenerated(boundary);

        private static string Text(Entity entity, string key)
        {
            string value = Stage3.XD.Get(entity, key);
            return string.IsNullOrWhiteSpace(value) ? "не задано" : value;
        }

        private static string Number(Entity entity, string key, string unit)
        {
            string value = Stage3.XD.Get(entity, key);
            if (string.IsNullOrWhiteSpace(value)) return "не задано";
            return NumericData.TryParseFinite(value, out double number)
                ? number.ToString("G6", CultureInfo.InvariantCulture) + " " + unit
                : "некорректно";
        }

        [CommandMethod("AGPT_ZONE_LIST")]
        public void List()
        {
            var document = Application.DocumentManager.MdiActiveDocument;
            if (document == null) return;
            using var tr = document.Database.TransactionManager.StartTransaction();
            var table = (BlockTable)tr.GetObject(document.Database.BlockTableId, OpenMode.ForRead);
            ObjectId modelId = table[BlockTableRecord.ModelSpace];
            var model = (BlockTableRecord)tr.GetObject(modelId, OpenMode.ForRead);
            int count = 0;
            document.Editor.WriteMessage("\n--- Исходные зоны АГПТ ---");
            foreach (ObjectId id in model)
            {
                var boundary = tr.GetObject(id, OpenMode.ForRead) as Polyline;
                if (!IsSource(boundary, modelId)) continue;
                document.Editor.WriteMessage("\n" + (++count) + ". " + Text(boundary, "ZONE_NAME")
                    + " [" + boundary.Handle + "]: S=" + Number(boundary, "AREA_M2", "м²")
                    + "; H=" + Number(boundary, "H", "м") + "; Vp=" + Number(boundary, "VP", "м³")
                    + "; FH=" + Number(boundary, "FH", "м²") + "; Tм=" + Number(boundary, "TM", "°C")
                    + "; ГОТВ=" + Text(boundary, "GOTV") + "; статус=" + Text(boundary, "ROOM_STATUS"));
            }
            document.Editor.WriteMessage("\nВсего: " + count + ". Масса ГОТВ: актуальный расчёт — AGPT_CALC.");
        }

        [CommandMethod("AGPT_ZONE_LABEL")]
        public void Label()
        {
            var document = Application.DocumentManager.MdiActiveDocument;
            if (document == null) return;
            var options = new PromptEntityOptions("\nВыберите исходный контур помещения для обновления подписи: ");
            options.SetRejectMessage("\nТребуется полилиния исходной зоны АГПТ.");
            options.AddAllowedClass(typeof(Polyline), true);
            var selected = document.Editor.GetEntity(options);
            if (selected.Status != PromptStatus.OK) return;
            try
            {
                using var tr = document.Database.TransactionManager.StartTransaction();
                var boundary = tr.GetObject(selected.ObjectId, OpenMode.ForRead) as Polyline;
                UpdateLabel(document.Database, tr, boundary);
                tr.Commit();
                document.Editor.WriteMessage("\nПодпись помещения обновлена.");
            }
            catch (System.Exception ex)
            { document.Editor.WriteMessage("\n[AGPT_ZONE_LABEL] " + ex.Message); }
        }

        /// <summary>Call after source XData is saved and before committing its transaction.</summary>
        public static void UpdateLabel(Database db, Transaction tr, Polyline boundary)
        {
            ObjectId modelId = RequireSource(db, tr, boundary, out string canonicalGuid);
            if (!TryLabelScale(db, boundary, out double scale))
                throw new InvalidOperationException("Масштаб этого контура не подтверждён или отличается от единиц чертежа. Повторите AGPT_ZONE.");
            var bounds = boundary.GeometricExtents;
            var location = new Point3d((bounds.MinPoint.X + bounds.MaxPoint.X) / 2,
                (bounds.MinPoint.Y + bounds.MaxPoint.Y) / 2, bounds.MinPoint.Z);
            string handle = boundary.Handle.ToString();
            string[] ownership = { "OWNER=ROOM_PRESENTATION_V1", "ZONE_GUID=" + canonicalGuid, "SOURCE_HANDLE=" + handle };
            var model = (BlockTableRecord)tr.GetObject(modelId, OpenMode.ForRead);
            var previous = new List<ObjectId>();
            foreach (ObjectId id in model)
                if (tr.GetObject(id, OpenMode.ForRead) is MText text && HasExactOwnership(text, ownership))
                    previous.Add(id);

            EnsureApp(db, tr, OwnerApp);
            EnsureApp(db, tr, GeneratedApp);
            Stage3.XD.EnsureApp(db, tr);
            var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            if (!layers.Has(LabelLayer))
            {
                layers.UpgradeOpen();
                var layer = new LayerTableRecord { Name = LabelLayer };
                layers.Add(layer); tr.AddNewlyCreatedDBObject(layer, true);
            }
            // Escape drawing text so names cannot inject MText formatting or paragraphs.
            string Escape(string text) => text.Replace("\\", "\\\\").Replace("{", "\\{")
                .Replace("}", "\\}").Replace("\r", " ").Replace("\n", " ");
            var label = new MText();
            label.SetDatabaseDefaults(db);
            label.Layer = LabelLayer;
            label.Location = location;
            label.Attachment = AttachmentPoint.MiddleCenter;
            label.TextHeight = 0.0025 / scale;
            label.Contents = Escape(Text(boundary, "ZONE_NAME")) + "\\P"
                + "S=" + Number(boundary, "AREA_M2", "м²") + "; H=" + Number(boundary, "H", "м")
                + "\\PVp=" + Number(boundary, "VP", "м³")
                + "\\PГОТВ: " + Escape(Text(boundary, "GOTV"))
                + "; Tм=" + Number(boundary, "TM", "°C")
                + "\\PСтатус: " + Escape(Text(boundary, "ROOM_STATUS"));
            model.UpgradeOpen();
            model.AppendEntity(label); tr.AddNewlyCreatedDBObject(label, true);
            SetMarker(label, OwnerApp, ownership);
            // The common generated marker excludes labels from every existing collector.
            // This is intentionally not SYSTEM=AGPT: album replacement must not own room labels.
            SetMarker(label, GeneratedApp, new[] { "OWNER=ROOM_PRESENTATION_V1" });
            Stage3.XD.Set(label, ("KIND", "ROOM_LABEL"), ("ZONE_GUID", canonicalGuid), ("SOURCE_HANDLE", handle));
            foreach (ObjectId id in previous)
                ((MText)tr.GetObject(id, OpenMode.ForWrite)).Erase();
        }

        /// <summary>Refresh presentation after source edits; invalid units remove stale labels.</summary>
        public static bool RefreshLabel(Database db, Transaction tr, Polyline boundary)
        {
            RequireSource(db, tr, boundary, out _);
            // Decide eligibility before creating or erasing anything. Database failures are
            // deliberately propagated so the caller can roll back its whole transaction.
            if (!TryLabelScale(db, boundary, out _))
            {
                RemoveLabel(db, tr, boundary);
                return false;
            }
            UpdateLabel(db, tr, boundary);
            return true;
        }

        private static bool TryLabelScale(Database db, Polyline boundary, out double scale)
        {
            scale = 0;
            if (Stage3.XD.Get(boundary, "UNIT_VERIFIED") != "1"
                || !NumericData.TryParseFinite(Stage3.XD.Get(boundary, "METRES_PER_UNIT"), out scale)
                || scale <= 0)
                return false;
            // An explicit drawing unit is authoritative. Unitless drawings use this room's
            // verified capture, never another room's or a global inferred scale.
            double? declared = db.Insunits switch {
                UnitsValue.Millimeters => .001, UnitsValue.Centimeters => .01,
                UnitsValue.Meters => 1.0, _ => null
            };
            return ((int)db.Insunits == 0 || declared.HasValue)
                && (!declared.HasValue || Math.Abs(scale - declared.Value) <= declared.Value * 1e-9);
        }

        /// <summary>Remove only this source's owned labels when its captured data becomes invalid.</summary>
        public static void RemoveLabel(Database db, Transaction tr, Polyline boundary)
        {
            ObjectId modelId = RequireSource(db, tr, boundary, out string canonicalGuid);
            string[] ownership = { "OWNER=ROOM_PRESENTATION_V1", "ZONE_GUID=" + canonicalGuid,
                "SOURCE_HANDLE=" + boundary.Handle.ToString() };
            var model = (BlockTableRecord)tr.GetObject(modelId, OpenMode.ForRead);
            var previous = new List<ObjectId>();
            foreach (ObjectId id in model)
                if (tr.GetObject(id, OpenMode.ForRead) is MText text && HasExactOwnership(text, ownership))
                    previous.Add(id);
            foreach (ObjectId id in previous)
                ((MText)tr.GetObject(id, OpenMode.ForWrite)).Erase();
        }

        private static ObjectId RequireSource(Database db, Transaction tr, Polyline boundary, out string canonicalGuid)
        {
            if (db == null) throw new ArgumentNullException(nameof(db));
            if (tr == null) throw new ArgumentNullException(nameof(tr));
            var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            ObjectId modelId = table[BlockTableRecord.ModelSpace];
            if (!IsSource(boundary, modelId) || boundary.Database != db)
                throw new InvalidOperationException("Нужен исходный замкнутый контур AGPT-ZONE с KIND=ZONE в модели.");
            if (!Guid.TryParse(Stage3.XD.Get(boundary, "GUID"), out var parsed) || parsed == Guid.Empty)
                throw new InvalidOperationException("У зоны отсутствует действительный GUID. Повторите AGPT_ZONE.");
            canonicalGuid = parsed.ToString("D");
            return modelId;
        }

        private static bool HasExactOwnership(Entity entity, string[] expected)
        {
            using var buffer = entity.GetXDataForApplication(OwnerApp);
            if (buffer == null) return false;
            var values = buffer.AsArray();
            if (values.Length != expected.Length + 1
                || values[0].TypeCode != (int)DxfCode.ExtendedDataRegAppName
                || !Equals(values[0].Value, OwnerApp)) return false;
            for (int i = 0; i < expected.Length; i++)
                if (values[i + 1].TypeCode != (int)DxfCode.ExtendedDataAsciiString
                    || !Equals(values[i + 1].Value, expected[i])) return false;
            return true;
        }

        private static void EnsureApp(Database db, Transaction tr, string name)
        {
            var apps = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (apps.Has(name)) return;
            apps.UpgradeOpen();
            var app = new RegAppTableRecord { Name = name };
            apps.Add(app); tr.AddNewlyCreatedDBObject(app, true);
        }

        private static void SetMarker(Entity entity, string app, string[] strings)
        {
            var values = new List<TypedValue> { new TypedValue((int)DxfCode.ExtendedDataRegAppName, app) };
            foreach (string value in strings) values.Add(new TypedValue((int)DxfCode.ExtendedDataAsciiString, value));
            using var buffer = new ResultBuffer(values.ToArray());
            entity.XData = buffer;
        }
    }
}
