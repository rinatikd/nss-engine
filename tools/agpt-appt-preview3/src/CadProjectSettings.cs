using System;
using System.Collections.Generic;
using System.IO;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;

namespace AGPT.Cad
{
    /// <summary>Only these two owned NOD records are accessed; caller owns the transaction.</summary>
    public static class ProjectSettingsStore
    {
        private static string Key(string system)
        {
            if (string.Equals(system, "AGPT", StringComparison.OrdinalIgnoreCase)) return "AGPT_PROJECT_METADATA";
            if (string.Equals(system, "APPT", StringComparison.OrdinalIgnoreCase)) return "APPT_PROJECT_METADATA";
            throw new ArgumentException("Поддерживаются только АГПТ и АППТ.", nameof(system));
        }

        public static bool TryRead(Database db, Transaction tr, string system, out ProjectMetadata metadata)
        {
            string key = Key(system);
            metadata = new ProjectMetadata();
            var dictionary = (DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId, OpenMode.ForRead);
            if (!dictionary.Contains(key)) return false;
            var record = tr.GetObject(dictionary.GetAt(key), OpenMode.ForRead) as Xrecord;
            if (record == null) throw new InvalidDataException("Ключ реквизитов занят объектом другого типа.");
            using var data = record.Data;
            if (data == null) throw new InvalidDataException("Запись реквизитов проекта пуста.");
            var bytes = new List<byte>();
            int chunks = 0;
            foreach (TypedValue value in data)
            {
                if (++chunks > ProjectMetadata.MaxPayloadBytes || value.TypeCode != (int)DxfCode.BinaryChunk
                    || !(value.Value is byte[] chunk) || chunk.Length == 0 || chunk.Length > 127
                    || bytes.Count + chunk.Length > ProjectMetadata.MaxPayloadBytes)
                    throw new InvalidDataException("Неверный формат или размер записи реквизитов проекта.");
                bytes.AddRange(chunk);
            }
            metadata = ProjectMetadata.Deserialize(bytes.ToArray());
            return true;
        }

        public static void Write(Database db, Transaction tr, string system, ProjectMetadata metadata)
        {
            string key = Key(system);
            if (metadata == null) throw new ArgumentNullException(nameof(metadata));
            var errors = metadata.Validate(requireProjectFields: true);
            if (errors.Count != 0) throw new InvalidDataException(string.Join("\n", errors));
            byte[] bytes = metadata.Serialize(); // Validate before touching the database.
            var chunks = new List<TypedValue>();
            for (int offset = 0; offset < bytes.Length; offset += 127)
            {
                var chunk = new byte[Math.Min(127, bytes.Length - offset)];
                Array.Copy(bytes, offset, chunk, 0, chunk.Length);
                chunks.Add(new TypedValue((int)DxfCode.BinaryChunk, chunk));
            }
            var dictionary = (DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId, OpenMode.ForRead);
            Xrecord record;
            if (dictionary.Contains(key))
            {
                record = tr.GetObject(dictionary.GetAt(key), OpenMode.ForWrite) as Xrecord;
                if (record == null) throw new InvalidDataException("Ключ реквизитов занят объектом другого типа.");
            }
            else
            {
                dictionary.UpgradeOpen();
                record = new Xrecord();
                dictionary.SetAt(key, record);
                tr.AddNewlyCreatedDBObject(record, true);
            }
            using var buffer = new ResultBuffer(chunks.ToArray());
            record.Data = buffer;
        }
    }
}
