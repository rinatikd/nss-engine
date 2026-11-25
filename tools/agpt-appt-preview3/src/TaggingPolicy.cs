using System;
using System.Collections.Generic;
using System.Linq;

namespace AGPT.Shared
{
    // Shared classification rules; the CAD adapter reads all applications' XData.
    public static class TaggingPolicy
    {
        public static void RequireTaggable(string app, string layer,
            IEnumerable<(string Application, string Key, string Value)> tags, params string[] allowedKinds)
        {
            bool gasPipeUpdate = app == "AGPT" && allowedKinds.Contains("PIPE");
            foreach (var tag in tags)
            {
                if (tag.Application == "AGPT_ALBUM_OUTPUT")
                    throw new InvalidOperationException("Объект принадлежит сформированному альбому; его нельзя использовать как исходные данные.");
                string key = tag.Key;
                bool classification = key == "KIND" || key == "ZONE_NAME" || key == "SEG_TYPE" || key == "CABLE_MARK";
                if (!classification) continue;
                if (tag.Application != app)
                    throw new InvalidOperationException("Объект уже размечен другим приложением: " + tag.Application + ". Выберите отдельный объект.");
                bool compatible = key == "KIND" ? allowedKinds.Contains(tag.Value) && (tag.Value != "PIPE" || gasPipeUpdate)
                    : key == "ZONE_NAME" ? allowedKinds.Contains("ZONE")
                    : key == "CABLE_MARK" ? allowedKinds.Contains("CABLE") : gasPipeUpdate;
                if (!compatible)
                    throw new InvalidOperationException("Объект уже используется как зона, трубопровод, оборудование либо трасса другого типа.");
            }
            // Layer-only legacy objects retain their existing purpose.
            foreach (string prefix in new[] { "AGPT", "APPT" })
            {
                string normalizedLayer = layer.ToUpperInvariant();
                if (normalizedLayer == prefix + "-ZONE" && (prefix != app || !allowedKinds.Contains("ZONE"))
                    || normalizedLayer == prefix + "-PIPE" && (prefix != app || !gasPipeUpdate)
                    || normalizedLayer == prefix + "-CABLE" && (prefix != app || !allowedKinds.Contains("CABLE"))
                    || normalizedLayer == prefix + "-EQ" && (prefix != app || !allowedKinds.Any(k => k == "MODULE" || k == "EQUIPMENT")))
                    throw new InvalidOperationException("Назначение существующего слоя несовместимо с командой: " + layer);
            }
        }
    }
}
