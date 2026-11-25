using System;
using System.Collections.Generic;
using System.Linq;
using AGPT.Drawings;
using AGPT.Shared;
using Autodesk.AutoCAD.DatabaseServices;

namespace AGPT.Cad
{
    /// <summary>
    /// Functional zone structure from captured devices, in paper millimetres.
    /// Dashed branches express membership only: they never imply electrical wiring.
    /// </summary>
    public static class AlbumStructureRenderer
    {
        public const int ColumnsPerPage = 3;
        public const int DevicesPerColumn = 5;

        private sealed class Column
        {
            public string Name = "", Key = "", Detail = "";
            public List<PlanDevice> Devices = new();
            public int Part, Parts, Total;
        }

        public static int PageCount(ProjectData project) =>
            Math.Max(1, (Columns(project).Count + ColumnsPerPage - 1) / ColumnsPerPage);

        /// <summary>The caller draws the frame and supplies the remaining content rectangle.</summary>
        public static void Render(BlockTableRecord target, Transaction transaction, ProjectData project,
            int page, double x, double y, double width, double height)
        {
            if (target == null || transaction == null || project == null)
                throw new ArgumentNullException("Target, transaction and project are required.");
            if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(width)
                || !double.IsFinite(height) || width < 330 || height < 190)
                throw new ArgumentException("Structure requires a content rectangle of at least 330 × 190 mm.");
            var columns = Columns(project);
            int pages = Math.Max(1, (columns.Count + ColumnsPerPage - 1) / ColumnsPerPage);
            if (page < 0 || page >= pages) throw new ArgumentOutOfRangeException(nameof(page));

            double top = y + height;
            Text(target, transaction, x, top - 3, width, 3.0,
                "СТРУКТУРА ОБОРУДОВАНИЯ ПО ЗОНАМ");
            Text(target, transaction, x, top - 9, width, 2.4,
                "Источник: оборудование текущей модели (KIND, MARK, GUID, ZONE_GUID). Лист "
                + (page + 1) + "/" + pages + ".");

            double bottom = y + 25, cardTop = top - 15;
            double gap = 6, cardWidth = (width - 2 * gap) / ColumnsPerPage;
            var visible = columns.Skip(page * ColumnsPerPage).Take(ColumnsPerPage).ToList();
            if (visible.Count == 0)
            {
                Draw.Rect(target, transaction, x, bottom, x + width, cardTop, DL.Scheme);
                Text(target, transaction, x + 8, cardTop - 14, width - 16, 3,
                    "В модели нет размеченных зон и оборудования.");
                Text(target, transaction, x + 8, cardTop - 23, width - 16, 2.5,
                    "Добавьте реальные устройства и их принадлежность к зонам для построения структуры.");
            }
            for (int index = 0; index < visible.Count; index++)
                RenderColumn(target, transaction, visible[index], x + index * (cardWidth + gap),
                    bottom, cardWidth, cardTop - bottom);

            Draw.Line(target, transaction, x, y + 21, x + width, y + 21, DL.Scheme);
            Dash(target, transaction, x, y + 15, x + 17, y + 15);
            Text(target, transaction, x + 21, y + 14, width - 21, 2.4,
                "Принадлежность устройства зоне по ZONE_GUID; линия не является кабелем или цепью.");
            Text(target, transaction, x, y + 8, width, 2.3,
                "Каждый блок — одно записанное устройство. Марка и ID взяты из модели; длинные подписи сокращены многоточием.");
            Text(target, transaction, x, y + 2, width, 2.3,
                "Монтажные соединения, адреса и клеммы не заданы этой схемой. Проверить топологию по проекту.");
        }

        private static List<Column> Columns(ProjectData project)
        {
            if (project == null) throw new ArgumentNullException(nameof(project));
            var result = new List<Column>();
            var devices = project.Plan?.Devices ?? new List<PlanDevice>();
            var known = new HashSet<string>(StringComparer.Ordinal);
            void Add(string name, string key, string detail, IEnumerable<PlanDevice> source)
            {
                var list = source.ToList();
                int parts = Math.Max(1, (list.Count + DevicesPerColumn - 1) / DevicesPerColumn);
                for (int part = 0; part < parts; part++)
                    result.Add(new Column { Name = name, Key = key, Detail = detail,
                        Devices = list.Skip(part * DevicesPerColumn).Take(DevicesPerColumn).ToList(),
                        Part = part + 1, Parts = parts, Total = list.Count });
            }
            foreach (var zone in project.Plan?.Zones ?? new List<PlanZone>())
            {
                if (string.IsNullOrWhiteSpace(zone.Id) || !known.Add(zone.Id)) continue;
                Add(Nonempty(zone.Name, "Зона без имени"), zone.Id,
                    string.IsNullOrWhiteSpace(zone.Floor) ? "Зона из модели" : "Этаж: " + zone.Floor,
                    devices.Where(device => device.ZoneId == zone.Id));
            }
            foreach (var zone in project.Zones)
            {
                if (string.IsNullOrWhiteSpace(zone.Guid) || !known.Add(zone.Guid)) continue;
                Add(Nonempty(zone.Name, "Зона без имени"), zone.Guid, "Зона из расчётных данных",
                    devices.Where(device => device.ZoneId == zone.Guid));
            }
            foreach (var group in devices.Where(device => string.IsNullOrWhiteSpace(device.ZoneId)
                || !known.Contains(device.ZoneId)).GroupBy(device => device.ZoneId ?? ""))
                Add(string.IsNullOrWhiteSpace(group.Key) ? "Зона не назначена" : "Зона не найдена",
                    group.Key, "Проверить принадлежность устройств", group);
            return result;
        }

        private static void RenderColumn(BlockTableRecord target, Transaction tr, Column column,
            double x, double y, double width, double height)
        {
            double top = y + height;
            Draw.Rect(target, tr, x, y, x + width, top, DL.Scheme);
            Text(target, tr, x + 3, top - 5, width - 6, 2.8, column.Name);
            Text(target, tr, x + 3, top - 10.5, width - 6, 2.2, column.Detail);
            Text(target, tr, x + 3, top - 15.5, width - 6, 2.1,
                "ID зоны: " + Nonempty(column.Key, "не задан"));
            Text(target, tr, x + 3, top - 21, width - 6, 2.2,
                "Устройств: " + column.Total + (column.Parts > 1 ? "; часть " + column.Part + "/" + column.Parts : ""));
            Draw.Line(target, tr, x, top - 25, x + width, top - 25, DL.Scheme);
            if (column.Devices.Count == 0)
            {
                Text(target, tr, x + 5, top - 37, width - 10, 2.6, "Оборудование не записано.");
                Text(target, tr, x + 5, top - 45, width - 10, 2.3, "Состав и связи требуют задания.");
                return;
            }
            // A vertical zone-membership spine follows the reference drawing's branching structure.
            // Do not draw any common panel, bus, or controller that is absent from the captured model.
            double step = (height - 30) / DevicesPerColumn;
            double boxHeight = Math.Min(23, step - 4), spine = x + 6;
            double firstCenter = top - 29 - boxHeight / 2;
            double lastCenter = firstCenter - (column.Devices.Count - 1) * step;
            Dash(target, tr, spine, top - 25, spine, lastCenter);
            for (int i = 0; i < column.Devices.Count; i++)
            {
                var device = column.Devices[i];
                double center = firstCenter - i * step, boxLeft = x + 12, boxTop = center + boxHeight / 2;
                Dash(target, tr, spine, center, boxLeft, center);
                Draw.Rect(target, tr, boxLeft, center - boxHeight / 2, x + width - 3, boxTop, DL.Scheme);
                double textWidth = width - 21;
                Text(target, tr, boxLeft + 2, boxTop - 5, textWidth, 2.5, Kind(device.Kind));
                Text(target, tr, boxLeft + 2, boxTop - 11, textWidth, 2.4,
                    "Марка: " + Nonempty(device.Mark, "не задана"));
                Text(target, tr, boxLeft + 2, boxTop - 17, textWidth, 2.1,
                    "ID: " + Nonempty(device.Id, "не задан"));
            }
        }

        private static string Kind(string kind) => kind switch
        {
            "MODULE" => "Модуль пожаротушения [MODULE]",
            "NOZZLE" => "Насадок [NOZZLE]",
            "KSID" => "Клапан сброса давления [KSID]",
            "MPT" => "Прибор управления [MPT]",
            "UDP" => "Устройство пуска [UDP]",
            "TABLO" => "Световое табло [TABLO]",
            "IP" => "Извещатель [IP]",
            "OPOP" => "Оповещатель [OPOP]",
            "RVD" => "Рукав высокого давления [RVD]",
            "SDU" => "Сигнализатор давления [SDU]",
            "ZPU_EM" => "Привод ЗПУ [ZPU_EM]",
            _ => "KIND: " + Nonempty(kind, "не задан")
        };

        private static string Nonempty(string value, string fallback) =>
            string.IsNullOrWhiteSpace(value) ? fallback : value;

        private static void Text(BlockTableRecord target, Transaction tr, double x, double y,
            double width, double height, string content)
        {
            string text = (content ?? "").Replace('\r', ' ').Replace('\n', ' ');
            // Conservative Cyrillic width budget; keep the text height legible on A3.
            int maximum = Math.Max(3, (int)Math.Floor(width / (height * .68 * .8)));
            if (text.Length > maximum) text = text.Substring(0, maximum - 1) + "…";
            var id = Draw.Text(target, tr, x, y, height, text, DL.Text);
            if (tr.GetObject(id, OpenMode.ForWrite) is DBText entity)
                entity.WidthFactor = Math.Min(1, width / Math.Max(height, text.Length * height * .68));
        }

        private static void Dash(BlockTableRecord target, Transaction tr, double x0, double y0,
            double x1, double y1)
        {
            double length = Math.Sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
            if (length < .001) return;
            for (double offset = 0; offset < length; offset += 3)
            {
                double end = Math.Min(length, offset + 1.7);
                Draw.Line(target, tr, x0 + (x1 - x0) * offset / length,
                    y0 + (y1 - y0) * offset / length, x0 + (x1 - x0) * end / length,
                    y0 + (y1 - y0) * end / length, DL.Scheme);
            }
        }
    }
}
