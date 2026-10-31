using System;
using System.Collections.Generic;
using Autodesk.AutoCAD.DatabaseServices;

namespace AGPT.Cad
{
    /// <summary>Owns generated album entities; the caller owns and commits the transaction.</summary>
    public static class AlbumOutput
    {
        private const string ApplicationName = "AGPT_ALBUM_OUTPUT";

        public static void Replace(BlockTableRecord ms, Transaction tr, string system, Action render)
        {
            ValidateSystem(system);
            if (ms == null) throw new ArgumentNullException(nameof(ms));
            if (tr == null) throw new ArgumentNullException(nameof(tr));
            if (render == null) throw new ArgumentNullException(nameof(render));
            if (ms.Database == null) throw new ArgumentException("Target must belong to a database.", nameof(ms));
            var blocks = (BlockTable)tr.GetObject(ms.Database.BlockTableId, OpenMode.ForRead);
            if (ms.ObjectId != blocks[BlockTableRecord.ModelSpace])
                throw new ArgumentException("Album output must be generated in ModelSpace.", nameof(ms));

            // Read all ownership markers before changing anything. Never infer ownership from layers.
            var existing = new HashSet<ObjectId>();
            var previous = new List<ObjectId>();
            foreach (ObjectId id in ms)
            {
                existing.Add(id);
                if (tr.GetObject(id, OpenMode.ForRead) is Entity entity && IsOwned(entity, system))
                    previous.Add(id);
            }

            EnsureApplication(ms.Database, tr);
            foreach (ObjectId id in previous)
                ((Entity)tr.GetObject(id, OpenMode.ForWrite)).Erase();

            // Do not catch render/tagging failures: caller disposal must roll back the whole replacement.
            render();
            foreach (ObjectId id in ms)
            {
                if (existing.Contains(id)) continue;
                if (tr.GetObject(id, OpenMode.ForWrite) is Entity entity) Mark(entity, system);
            }
        }

        /// <summary>Exclude even malformed ownership markers from source-data collection.</summary>
        public static bool IsGenerated(Entity entity)
        {
            if (entity == null) return false;
            using var data = entity.GetXDataForApplication(ApplicationName);
            return data != null;
        }

        /// <summary>Only an exact, valid marker authorizes replacement of an entity.</summary>
        public static bool IsOwned(Entity entity, string system)
        {
            ValidateSystem(system);
            if (entity == null) return false;
            using var data = entity.GetXDataForApplication(ApplicationName);
            if (data == null) return false;
            var values = data.AsArray();
            return values.Length == 2
                && values[0].TypeCode == (int)DxfCode.ExtendedDataRegAppName
                && values[0].Value is string app && app == ApplicationName
                && values[1].TypeCode == (int)DxfCode.ExtendedDataAsciiString
                && values[1].Value is string owner && owner == "SYSTEM=" + system;
        }

        private static void ValidateSystem(string system)
        {
            if (system != "AGPT" && system != "APPT")
                throw new ArgumentException("Expected AGPT or APPT system.", nameof(system));
        }

        private static void EnsureApplication(Database db, Transaction tr)
        {
            var table = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (table.Has(ApplicationName)) return;
            table.UpgradeOpen();
            var application = new RegAppTableRecord { Name = ApplicationName };
            table.Add(application);
            tr.AddNewlyCreatedDBObject(application, true);
        }

        private static void Mark(Entity entity, string system)
        {
            // Supplying this application's segment replaces only that segment; AutoCAD preserves
            // all other registered applications' XData on the entity.
            using var data = new ResultBuffer(
                new TypedValue((int)DxfCode.ExtendedDataRegAppName, ApplicationName),
                new TypedValue((int)DxfCode.ExtendedDataAsciiString, "SYSTEM=" + system));
            entity.XData = data;
        }
    }
}
