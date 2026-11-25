using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace AGPT.Shared
{
    /// <summary>User supplied drawing requisites. No sample project or personal data.</summary>
    public sealed class ProjectMetadata
    {
        public const int MaxPayloadBytes = 32768;
        public const int MaxFieldCharacters = 2048;
        public string Cipher { get; set; } = "";
        public string ObjectName { get; set; } = "";
        public string ObjectShort { get; set; } = "";
        public string Stage { get; set; } = "";
        public string CityYear { get; set; } = "";
        public string Company { get; set; } = "";
        public string CompanyGsl { get; set; } = "";
        public string GenDesigner { get; set; } = "";
        public string VolumeTitle { get; set; } = "";
        public string VolumeNo { get; set; } = "";
        public string Gip { get; set; } = "";
        public string Checked { get; set; } = "";
        public string Drawn { get; set; } = "";
        public string NormCtrl { get; set; } = "";

        private static readonly string[] Fields = { nameof(Cipher), nameof(ObjectName), nameof(ObjectShort),
            nameof(Stage), nameof(CityYear), nameof(Company), nameof(CompanyGsl), nameof(GenDesigner),
            nameof(VolumeTitle), nameof(VolumeNo), nameof(Gip), nameof(Checked), nameof(Drawn), nameof(NormCtrl) };
        private static readonly string[] Labels = { "Шифр проекта", "Наименование объекта", "Краткое наименование объекта",
            "Стадия", "Город и год", "Проектная организация", "Реквизиты организации", "Генеральный проектировщик",
            "Наименование тома", "Номер тома", "Главный инженер проекта", "Проверил", "Разработал", "Нормоконтроль" };
        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, MaxDepth = 4 };

        public IReadOnlyList<string> Validate(bool requireProjectFields = false)
        {
            var errors = new List<string>();
            if (requireProjectFields)
            {
                if (string.IsNullOrWhiteSpace(Cipher)) errors.Add("Заполните шифр проекта.");
                if (string.IsNullOrWhiteSpace(ObjectName)) errors.Add("Заполните наименование объекта.");
                if (string.IsNullOrWhiteSpace(Company)) errors.Add("Заполните проектную организацию.");
            }
            foreach (string name in Fields)
            {
                string label = Labels[Array.IndexOf(Fields, name)];
                string value = (string)typeof(ProjectMetadata).GetProperty(name).GetValue(this);
                if (value == null) { errors.Add("Реквизит не может быть null: " + label); continue; }
                if (value.Length > MaxFieldCharacters) errors.Add("Реквизит превышает 2048 символов: " + label);
                for (int i = 0; i < value.Length; i++)
                {
                    char c = value[i];
                    if (char.IsControl(c) && c != '\r' && c != '\n')
                    { errors.Add("В реквизите есть управляющий символ: " + label); break; }
                    if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                    { i++; continue; }
                    if (char.IsSurrogate(c)) { errors.Add("Некорректный Unicode в реквизите: " + label); break; }
                }
            }
            return errors;
        }

        public byte[] Serialize()
        {
            var errors = Validate();
            if (errors.Count != 0) throw new InvalidDataException(string.Join("\n", errors));
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(this, Options);
            if (bytes.Length > MaxPayloadBytes) throw new InvalidDataException("Реквизиты превышают 32 КиБ.");
            return bytes;
        }

        public static ProjectMetadata Deserialize(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0 || bytes.Length > MaxPayloadBytes)
                throw new InvalidDataException("Неверный размер реквизитов проекта.");
            try
            {
                // Reject invalid UTF-8 rather than replacing it with another character.
                string json = new UTF8Encoding(false, true).GetString(bytes);
                using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                    throw new InvalidDataException("Реквизиты должны быть объектом JSON.");
                var metadata = new ProjectMetadata();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var field in document.RootElement.EnumerateObject())
                {
                    if (Array.IndexOf(Fields, field.Name) < 0 || !seen.Add(field.Name)
                        || field.Value.ValueKind != JsonValueKind.String)
                        throw new InvalidDataException("Неизвестный, повторный или неверный реквизит.");
                    typeof(ProjectMetadata).GetProperty(field.Name).SetValue(metadata, field.Value.GetString());
                }
                var errors = metadata.Validate();
                if (errors.Count != 0) throw new InvalidDataException(string.Join("\n", errors));
                return metadata;
            }
            catch (System.Exception ex) when (ex is JsonException || ex is DecoderFallbackException || ex is InvalidOperationException)
            { throw new InvalidDataException("Повреждены реквизиты проекта.", ex); }
        }
    }
}
