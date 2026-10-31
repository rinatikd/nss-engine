// =============================================================================
// APPT AutoCAD Plugin — расчёт + генерация чертежей модульного порошкового ПТ
// Нормы: СП РК 2.02-102-2022, СН РК 2.02-11-2002, СТ РК 1302
// Формула: N = (Vp / Vн) · k1 · k2 · k3 · k4
// .NET 8 / AutoCAD 2018–2026
// =============================================================================

using System;
using AGPT.Shared;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.Runtime;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Colors;
using AGPT.Drawings; // FrameBlock (общая рамка/штамп MMX_ШТАМП)

[assembly: CommandClass(typeof(APPT.Drawings.ApptDrawingCommands))]

namespace APPT.Drawings
{
    // =========================================================================
    // Слои
    // =========================================================================
    public static class DL
    {
        public const string App = "APPT";
        public const string Frame = "APPT-FRAME";
        public const string Text = "APPT-TEXT";
        public const string Table = "APPT-TABLE";
        public const string Scheme = "APPT-SCHEME";
        public const string Eq = "APPT-EQ";
        public const string Mark = "APPT-MARK";
        public const string Zone = "APPT-ZONE";
        public const string Cable = "APPT-CABLE";

        public const double A3W = 420.0, A3H = 297.0;
        public const double Margin = 5.0;
        public const double BindLeft = 20.0;
    }

    // =========================================================================
    // XData
    // =========================================================================
    public static class XD
    {
        public static void EnsureApp(Database db, Transaction tr)
        {
            var rat = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (rat.Has(DL.App)) return;
            rat.UpgradeOpen();
            var r = new RegAppTableRecord { Name = DL.App };
            rat.Add(r); tr.AddNewlyCreatedDBObject(r, true);
        }

        public static void Set(Entity e, params (string k, string v)[] pairs)
        {
            var list = new List<TypedValue> { new TypedValue((int)DxfCode.ExtendedDataRegAppName, DL.App) };
            foreach (var (k, v) in pairs)
                list.Add(new TypedValue((int)DxfCode.ExtendedDataAsciiString, k + "=" + v));
            using (var buffer = new ResultBuffer(list.ToArray()))
                e.XData = buffer;
        }

        public static string Get(Entity e, string key)
        {
            using var rb = e.GetXDataForApplication(DL.App);
            if (rb == null) return null;
            string p = key + "=";
            foreach (TypedValue tv in rb)
                if (tv.TypeCode == (int)DxfCode.ExtendedDataAsciiString)
                {
                    var s = tv.Value.ToString();
                    if (s.StartsWith(p, StringComparison.Ordinal)) return s.Substring(p.Length);
                }
            return null;
        }

        public static double GetD(Entity e, string key, double def = 0)
        {
            var s = Get(e, key);
            if (string.IsNullOrEmpty(s)) return def;
            return NumericData.ParseOrDefault(s, def);
        }
    }

    public static class Layers
    {
        public static void Ensure(Database db, Transaction tr, string name, short color)
        {
            var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            if (lt.Has(name)) return;
            lt.UpgradeOpen();
            var ltr = new LayerTableRecord
            {
                Name = name,
                Color = Color.FromColorIndex(ColorMethod.ByAci, color)
            };
            lt.Add(ltr); tr.AddNewlyCreatedDBObject(ltr, true);
        }

        public static void EnsureAll(Database db, Transaction tr)
        {
            Ensure(db, tr, DL.Frame, 7);
            Ensure(db, tr, DL.Text, 7);
            Ensure(db, tr, DL.Table, 7);
            Ensure(db, tr, DL.Scheme, 3);
            Ensure(db, tr, DL.Eq, 1);
            Ensure(db, tr, DL.Mark, 7);
            Ensure(db, tr, DL.Zone, 8);
            Ensure(db, tr, DL.Cable, 5);
        }
    }

    // =========================================================================
    // Примитивы
    // =========================================================================
    public static class Draw
    {
        public static ObjectId Line(BlockTableRecord btr, Transaction tr,
            double x0, double y0, double x1, double y1, string layer, short color = 7)
        {
            var pl = new Polyline(2);
            pl.AddVertexAt(0, new Point2d(x0, y0), 0, 0, 0);
            pl.AddVertexAt(1, new Point2d(x1, y1), 0, 0, 0);
            pl.Layer = layer;
            if (color != 7) pl.Color = Color.FromColorIndex(ColorMethod.ByAci, color);
            btr.AppendEntity(pl); tr.AddNewlyCreatedDBObject(pl, true);
            return pl.ObjectId;
        }

        public static ObjectId Rect(BlockTableRecord btr, Transaction tr,
            double x0, double y0, double x1, double y1, string layer, short color = 7)
        {
            var pl = new Polyline(4);
            pl.AddVertexAt(0, new Point2d(x0, y0), 0, 0, 0);
            pl.AddVertexAt(1, new Point2d(x1, y0), 0, 0, 0);
            pl.AddVertexAt(2, new Point2d(x1, y1), 0, 0, 0);
            pl.AddVertexAt(3, new Point2d(x0, y1), 0, 0, 0);
            pl.Closed = true; pl.Layer = layer;
            if (color != 7) pl.Color = Color.FromColorIndex(ColorMethod.ByAci, color);
            btr.AppendEntity(pl); tr.AddNewlyCreatedDBObject(pl, true);
            return pl.ObjectId;
        }

        public static ObjectId Text(BlockTableRecord btr, Transaction tr,
            double x, double y, double h, string s, string layer, short color = 7)
        {
            var t = new DBText
            {
                Position = new Point3d(x, y, 0),
                Height = h,
                TextString = s ?? "",
                Layer = layer
            };
            if (color != 7) t.Color = Color.FromColorIndex(ColorMethod.ByAci, color);
            btr.AppendEntity(t); tr.AddNewlyCreatedDBObject(t, true);
            return t.ObjectId;
        }

        public static ObjectId MText(BlockTableRecord btr, Transaction tr,
            double x, double y, double w, double h, string s, string layer)
        {
            var mt = new MText
            {
                Location = new Point3d(x, y, 0),
                TextHeight = h,
                Width = w,
                Contents = s ?? "",
                Layer = layer,
                Attachment = AttachmentPoint.TopLeft
            };
            btr.AppendEntity(mt); tr.AddNewlyCreatedDBObject(mt, true);
            return mt.ObjectId;
        }

        /// <summary>Таблица AcDbTable (как в АГПТ). Возвращает высоту области.</summary>
        public static double Table(BlockTableRecord btr, Transaction tr,
            double x, double y, double[] colW, double rowH,
            string[] headers, List<string[]> rows, string layer)
        {
            int cols = colW.Length;
            int nData = rows != null ? rows.Count : 0;
            int nRows = 1 + nData;
            double height = nRows * rowH;
            try
            {
                var table = new Table();
                table.SetDatabaseDefaults(btr.Database);
                table.TableStyle = btr.Database.Tablestyle;
                table.Position = new Point3d(x, y, 0);
                table.SetSize(nRows, cols);
                table.Layer = layer;
                for (int c = 0; c < cols; c++)
                    table.SetColumnWidth(c, colW[c]);
                for (int r = 0; r < nRows; r++)
                    table.SetRowHeight(r, rowH);
                for (int c = 0; c < cols; c++)
                {
                    var cell = table.Cells[0, c];
                    cell.TextString = headers != null && c < headers.Length ? (headers[c] ?? "") : "";
                    cell.TextHeight = Math.Min(2.2, rowH * 0.45);
                    cell.Alignment = CellAlignment.MiddleCenter;
                }
                for (int r = 0; r < nData; r++)
                {
                    for (int c = 0; c < cols; c++)
                    {
                        string val = (rows[r] != null && c < rows[r].Length) ? (rows[r][c] ?? "") : "";
                        var cell = table.Cells[r + 1, c];
                        cell.TextString = val;
                        cell.TextHeight = Math.Min(2.0, rowH * 0.4);
                        cell.Alignment = CellAlignment.MiddleLeft;
                    }
                }
                table.GenerateLayout();
                btr.AppendEntity(table);
                tr.AddNewlyCreatedDBObject(table, true);
                return height;
            }
            catch { }

            double totalW = colW.Sum();
            for (int r = 0; r <= nRows; r++)
                Line(btr, tr, x, y - r * rowH, x + totalW, y - r * rowH, layer);
            double xx = x;
            for (int c = 0; c <= cols; c++)
            {
                Line(btr, tr, xx, y, xx, y - nRows * rowH, layer);
                if (c < cols) xx += colW[c];
            }
            xx = x;
            for (int c = 0; c < cols; c++)
            {
                Text(btr, tr, xx + 1, y - rowH + 1.2, 2.0, headers[c], layer);
                xx += colW[c];
            }
            for (int r = 0; r < nData; r++)
            {
                xx = x;
                for (int c = 0; c < cols && c < rows[r].Length; c++)
                {
                    Text(btr, tr, xx + 1, y - (r + 2) * rowH + 1.2, 1.9, rows[r][c], layer);
                    xx += colW[c];
                }
            }
            return height;
        }

        /// <summary>
        /// Рамка + штамп: тот же блок AGPT_Frame_A3_v2 / MMX_ШТАМП, что и у АГПТ.
        /// </summary>
        public static void SheetFrame(BlockTableRecord btr, Transaction tr,
            double ox, double oy, double w, double h, ProjectData pd,
            string sheetTitle, string sheetNo, string sheetsTotal)
        {
            double left = ox + DL.BindLeft;
            double bottom = oy + DL.Margin;
            double right = ox + w - DL.Margin;
            double top = oy + h - DL.Margin;

            bool usedBlock = false;
            try
            {
                if (btr.Database != null)
                    usedBlock = FrameBlock.TryInsert(btr, tr, btr.Database, ox, oy);
            }
            catch { usedBlock = false; }

            if (usedBlock)
            {
                string titleShort = sheetTitle ?? "";
                if (titleShort.Length > 40) titleShort = titleShort.Substring(0, 38) + "…";
                string objShort = pd != null ? (pd.ObjectName ?? "") : "";
                if (objShort.Length > 55) objShort = objShort.Substring(0, 52) + "…";
                Text(btr, tr, right - 183, bottom + 45, 2.4, titleShort, DL.Text);
                Text(btr, tr, right - 183, bottom + 30, 1.6, objShort, DL.Text);
                Text(btr, tr, right - 183, bottom + 17, 2.2, pd != null ? (pd.Cipher ?? "") : "", DL.Text);
                Text(btr, tr, right - 163, bottom + 4, 2.2, pd != null ? (pd.Stage ?? "РП") : "РП", DL.Text);
                Text(btr, tr, right - 117, bottom + 4, 2.2, sheetNo ?? "", DL.Text);
                Text(btr, tr, right - 70, bottom + 4, 2.2, sheetsTotal ?? "", DL.Text);
                return;
            }

            // Fallback — программная рамка (если блок не загрузился)
            Rect(btr, tr, ox, oy, ox + w, oy + h, DL.Frame);
            Rect(btr, tr, left, bottom, right, top, DL.Frame);
            double sw = 185, sh = 55;
            double sx = right - sw, sy = bottom;
            Rect(btr, tr, sx, sy, sx + sw, sy + sh, DL.Frame);
            Line(btr, tr, sx, sy + 15, sx + sw, sy + 15, DL.Frame);
            Line(btr, tr, sx, sy + 25, sx + sw, sy + 25, DL.Frame);
            Line(btr, tr, sx, sy + 40, sx + sw, sy + 40, DL.Frame);
            Text(btr, tr, sx + 2, sy + 45, 2.5, sheetTitle ?? "", DL.Text);
            Text(btr, tr, sx + 2, sy + 17, 2.0, pd != null ? (pd.Cipher ?? "") : "", DL.Text);
            Text(btr, tr, sx + 68, sy + 4, 2.2, sheetNo ?? "", DL.Text);
            Text(btr, tr, sx + 130, sy + 4, 2.2, sheetsTotal ?? "", DL.Text);
        }

    }

    // =========================================================================
    // Модель данных АППТ
    // =========================================================================
    public class ProjectData
    {
        public string Cipher = "";
        public string ObjectName = "";
        public string ObjectShort = "";
        public string Stage = "РП";
        public string CityYear = "";
        public string Company = "";
        public string CompanyGsl = "";
        public string GenDesigner = "";
        public string VolumeTitle = "Автоматическое порошковое пожаротушение";
        public string VolumeNo = "";
        public string Gip = "";
        public string Checked = "";
        public string Drawn = "";
        public string NormCtrl = "";
        public bool HasProjectSettings { get; set; }
        public PlanModel Plan = new PlanModel();
        public int SheetCount;
        public List<ZoneCalc> Zones = new List<ZoneCalc>();
        public List<SpecRow> Spec = new List<SpecRow>();
        public List<CableRow> Cables = new List<CableRow>();
    }

    /// <summary>Зона порошкового ПТ (модульная установка).</summary>
    public class ZoneCalc
    {
        public string Name = "";
        /// <summary>Расчётный объём защищаемого помещения, м³</summary>
        public double Vp;
        /// <summary>Объём, защищаемый одним модулем, м³ (Тунгус-4 = 70)</summary>
        public double Vn;
        /// <summary>k1 — неравномерность распыления</summary>
        public double K1 = 1.0;
        /// <summary>k2 — запас на затенённость</summary>
        public double K2 = 1.0;
        /// <summary>k3 — изменение огнетушащей эффективности</summary>
        public double K3 = 1.0;
        /// <summary>k4 — степень негерметичности</summary>
        public double K4 = 1.2;
        /// <summary>Тип модуля</summary>
        public string ModuleMark = "";
        /// <summary>N — число рабочих модулей (после расчёта)</summary>
        public int NWork;
        /// <summary>Резерв 100%</summary>
        public int NRes;
        /// <summary>N сырое до округления вверх</summary>
        public double NRaw;
    }

    public class SpecRow
    {
        public int Pos;
        public string Name, Mark, Unit, Note;
        public double Qty;
    }

    public class CableRow
    {
        public string From, To, Mark;
        public double Length;
    }

    // =========================================================================
    // Расчёт АППТ: N = (Vp / Vн) · k1 · k2 · k3 · k4
    // Расчётная потребность не является ведомостью размещённых устройств.
    // =========================================================================
    public static class Calc
    {
        public static void Modules(ZoneCalc z)
        {
            if (new[] { z.Vp, z.Vn, z.K1, z.K2, z.K3, z.K4 }.Any(v => !double.IsFinite(v) || v <= 0))
                throw new InvalidOperationException("Зона «" + z.Name + "»: нужны положительные конечные VP, VN и K1–K4.");
            z.NRaw = (z.Vp / z.Vn) * z.K1 * z.K2 * z.K3 * z.K4;
            if (!double.IsFinite(z.NRaw) || z.NRaw > int.MaxValue / 2.0)
                throw new InvalidOperationException("Зона «" + z.Name + "»: расчётное количество модулей выходит за допустимый диапазон.");
            z.NWork = Math.Max(1, (int)Math.Ceiling(z.NRaw - 1e-9));
            z.NRes = z.NWork; // 100% резерв по эталону
        }
    }

    // =========================================================================
    // Генераторы листов
    // =========================================================================
    public static class SheetGen
    {
        public static double Pitch => Math.Max(450, FrameBlock.FrameWidth + 30.0);

        public static Point3d Origin(int i) => new Point3d(i * Pitch, 0, 0);

        public static void TitleSheet(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            double left = o.X + DL.BindLeft;
            double bottom = o.Y + DL.Margin;
            double right = o.X + DL.A3W - DL.Margin;
            double top = o.Y + DL.A3H - DL.Margin;
            Draw.Rect(ms, tr, o.X, o.Y, o.X + DL.A3W, o.Y + DL.A3H, DL.Frame);
            Draw.Rect(ms, tr, left, bottom, right, top, DL.Frame);

            Draw.Text(ms, tr, o.X + 30, top - 20, 3.5, "Республика Казахстан", DL.Text);
            Draw.Text(ms, tr, o.X + 30, top - 35, 2.2,
                "Генеральный проектировщик: " + (pd.GenDesigner ?? ""), DL.Text);
            Draw.Text(ms, tr, o.X + 30, top - 42, 2.2,
                "Проектировщик: " + (pd.Company ?? "") + " " + (pd.CompanyGsl ?? ""), DL.Text);

            string orderNo = pd.Cipher ?? "";
            if (!string.IsNullOrEmpty(pd.Cipher))
            {
                var parts = pd.Cipher.Split('-');
                if (parts.Length >= 2) orderNo = parts[0] + "-" + parts[1];
            }
            Draw.Text(ms, tr, o.X + 30, top - 49, 2.2, "Заказ: " + orderNo, DL.Text);

            Draw.MText(ms, tr, o.X + 60, o.Y + 200, 300, 3.2,
                "«" + (pd.ObjectName ?? "") + "»", DL.Text);
            Draw.Text(ms, tr, o.X + 140, o.Y + 155, 5, "РАБОЧИЙ ПРОЕКТ", DL.Text);
            Draw.Text(ms, tr, o.X + 150, o.Y + 140, 4, pd.Cipher ?? "", DL.Text);
            Draw.Text(ms, tr, o.X + 170, o.Y + 125, 3.5, pd.VolumeNo ?? "Том 4", DL.Text);
            Draw.Text(ms, tr, o.X + 90, o.Y + 110, 3.5,
                pd.VolumeTitle ?? "Автоматическое порошковое пожаротушение", DL.Text);
            Draw.Text(ms, tr, o.X + 155, o.Y + 40, 3, pd.CityYear ?? "", DL.Text);
            Draw.Text(ms, tr, right - 40, bottom + 5, 1.8, "Формат А3", DL.Text);
        }

        private const int CalcPageSize = 4;
        private const int TablePageSize = 24;
        private static int Pages(int count, int size) => Pagination.Partition(count, size, includeEmpty: true).Count();
        private static List<T> Page<T>(List<T> source, int capacity, int page)
        {
            var slice = Pagination.Partition(source.Count, capacity, includeEmpty: true).ElementAt(page);
            return source.Skip(slice.Start).Take(slice.Count).ToList();
        }
        private static int ContentPages(ProjectData pd) => 1 + Pages(pd.Zones.Count, CalcPageSize)
            + Pages(pd.Cables.Count, TablePageSize) + Pages(pd.Spec.Count, TablePageSize) + PlanPages(pd);
        private static int GeneralPages(ProjectData pd)
        {
            int pages = 1;
            while (Pages(ContentPages(pd) + pages, TablePageSize) > pages) pages++;
            return pages;
        }
        private static int Total(ProjectData pd) => ContentPages(pd) + GeneralPages(pd);
        private static int PlanPages(ProjectData pd) => 1;
        private static void Frame(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx, string title)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd, title,
                (idx + 1).ToString(), (pd.SheetCount > 0 ? pd.SheetCount : Total(pd)).ToString());
        }
        private static List<string[]> Registry(ProjectData pd)
        {
            var rows = new List<string[]> { new[] { "1", "Титульный лист", "" } };
            void Add(string title, int count) { for (int i = 0; i < count; i++) rows.Add(new[] { (rows.Count + 1).ToString(), title, count > 1 ? (i + 1) + "/" + count : "" }); }
            Add("Общие данные", GeneralPages(pd));
            Add("Ведомость соединений", Pages(pd.Cables.Count, TablePageSize));
            Add("Расчёт порошкового пожаротушения", Pages(pd.Zones.Count, CalcPageSize));
            Add("План оборудования и кабелей", PlanPages(pd));
            Add("Спецификация", Pages(pd.Spec.Count, TablePageSize));
            return rows;
        }
        public static void GeneralData(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            // Реестр также переносится на дополнительные листы, когда комплект велик.
            var rows = Registry(pd);
            for (int page = 0; page < Pages(rows.Count, TablePageSize); page++)
            {
                var o = Origin(idx + page);
                Frame(ms, tr, pd, idx + page, "Общие данные. Ведомость листов");
                Draw.Table(ms, tr, o.X + 25, o.Y + 275, new[] { 15.0, 140.0, 25.0 }, 6,
                    new[] { "Лист", "Наименование", "Прим." }, Page(rows, TablePageSize, page), DL.Table);
                Draw.MText(ms, tr, o.X + 220, o.Y + 275, 180, 2.3,
                    "Расчёт: N = (Vp/Vн)·k1·k2·k3·k4 с округлением вверх. Резерв 100%.\\P" +
                    "VN и коэффициенты принимаются по документации выбранного модуля и исходным данным проекта. " +
                    "Нормативная применимость и алгоритм запуска требуют проверки проектировщиком.\\P" +
                    "Планы воспроизводят только геометрию и размещённое оборудование исходной модели. " +
                    "Спецификация сформирована по XData фактически размещённых элементов; расчётная потребность не заменяет размещение.", DL.Text);
            }
        }
        public static void StructuralScheme(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            for (int page = 0; page < Pages(pd.Cables.Count, TablePageSize); page++)
            {
                var o = Origin(idx + page);
                Frame(ms, tr, pd, idx + page, "Ведомость соединений оборудования АППТ");
                var rows = Page(pd.Cables, TablePageSize, page)
                    .Select(c => new[] { c.From, c.To, c.Mark, c.Length.ToString("F2") }).ToList();
                Draw.Table(ms, tr, o.X + 25, o.Y + 275, new[] { 75.0, 75.0, 130.0, 35.0 }, 7,
                    new[] { "Откуда", "Куда", "Марка кабеля", "Длина, м" }, rows, DL.Table);
                if (rows.Count == 0) Draw.Text(ms, tr, o.X + 25, o.Y + 250, 2.5,
                    "Нет кабельных трасс с XData: KIND=CABLE, FROM, TO, CABLE_MARK; задайте единицы DWG.", DL.Text);
            }
        }
        public static void CalcSheet(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            if (pd.Zones.Count == 0) throw new InvalidOperationException("Нет зон для расчёта. Создайте APPT_ZONE или задайте XData зон.");
            for (int page = 0; page < Pages(pd.Zones.Count, CalcPageSize); page++)
            {
                var o = Origin(idx + page);
                Frame(ms, tr, pd, idx + page, "Расчёт порошкового пожаротушения");
                var zones = Page(pd.Zones, CalcPageSize, page);
                for (int i = 0; i < zones.Count; i++)
                {
                    var z = zones[i]; Calc.Modules(z);
                    double x = o.X + 28 + (i % 2) * 185, y = o.Y + 275 - (i / 2) * 100;
                    Draw.Text(ms, tr, x, y, 2.4, (page * CalcPageSize + i + 1) + ". " + z.Name, DL.Text);
                    var rows = new List<string[]> {
                        new[] { "Vp, м³", z.Vp.ToString("F2") }, new[] { "Vн, м³", z.Vn.ToString("F2") },
                        new[] { "k1 / k2", z.K1.ToString("F2") + " / " + z.K2.ToString("F2") },
                        new[] { "k3 / k4", z.K3.ToString("F2") + " / " + z.K4.ToString("F2") },
                        new[] { "Модуль", z.ModuleMark }, new[] { "N до округления", z.NRaw.ToString("F3") },
                        new[] { "Рабочие / резерв", z.NWork + " / " + z.NRes }, new[] { "Всего, шт.", (z.NWork + z.NRes).ToString() } };
                    Draw.Table(ms, tr, x, y - 6, new[] { 60.0, 110.0 }, 7,
                        new[] { "Параметр", "Значение" }, rows, DL.Table);
                }
                Draw.Text(ms, tr, o.X + 28, o.Y + 68, 2, "N = (Vp/Vн)·k1·k2·k3·k4. Резерв 100%; проверить по заданию и паспорту модуля.", DL.Text);
            }
        }
        public static void PlanSheet(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            Frame(ms, tr, pd, idx, "План размещённого оборудования и кабелей АППТ");
            var o = Origin(idx);
            var summary = AGPT.Cad.ProjectPlanRenderer.Render(ms, tr, pd.Plan,
                o.X + 28, o.Y + 80, 370, 190, "APPT", showPipes: false, showCables: true);
            Draw.Text(ms, tr, o.X + 28, o.Y + 70, 2.1,
                "Масштаб 1:" + summary.ScaleDenominator.ToString("G") + "; зон " + summary.ZoneCount
                + "; устройств " + summary.DeviceCount + "; трасс " + summary.RouteCount, DL.Text);
        }
        public static void Specification(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            for (int page = 0; page < Pages(pd.Spec.Count, TablePageSize); page++)
            {
                var o = Origin(idx + page);
                Frame(ms, tr, pd, idx + page, "Спецификация оборудования, изделий и материалов");
                var rows = Page(pd.Spec, TablePageSize, page).Select(r => new[]
                    { r.Pos.ToString(), r.Name, r.Mark, r.Unit, r.Qty.ToString("G"), r.Note }).ToList();
                Draw.Table(ms, tr, o.X + 25, o.Y + 275, new[] { 12.0, 100.0, 95.0, 18.0, 25.0, 35.0 }, 7,
                    new[] { "Поз.", "Наименование", "Тип, марка", "Ед.", "Кол.", "Примечание" }, rows, DL.Table);
                if (rows.Count == 0) Draw.Text(ms, tr, o.X + 25, o.Y + 250, 2.3,
                    "Нет размещённых элементов с XData KIND=MODULE/EQUIPMENT/CABLE и MARK/CABLE_MARK.", DL.Text);
            }
        }
        public static void FullAlbum(BlockTableRecord ms, Transaction tr, ProjectData pd)
        {
            if (!pd.HasProjectSettings) throw new InvalidOperationException("Сначала задайте реквизиты командой APPT_PROJECT.");
            if (pd.Zones.Count == 0) throw new InvalidOperationException("Исходные данные отсутствуют: нужны зоны АППТ.");
            FrameBlock.ResetCache();
            try { FrameBlock.EnsureDefinition(ms.Database, tr); } catch { }
            pd.SheetCount = Total(pd);
            TitleSheet(ms, tr, pd, 0);
            GeneralData(ms, tr, pd, 1);
            int idx = 1 + GeneralPages(pd);
            StructuralScheme(ms, tr, pd, idx); idx += Pages(pd.Cables.Count, TablePageSize);
            CalcSheet(ms, tr, pd, idx); idx += Pages(pd.Zones.Count, CalcPageSize);
            PlanSheet(ms, tr, pd, idx); idx += PlanPages(pd);
            Specification(ms, tr, pd, idx);
            for (int i = 0; i < pd.SheetCount; i++)
            {
                var origin = Origin(i);
                Draw.Text(ms, tr, origin.X + 25, origin.Y + DL.A3H - 7, 1.8, "ПРОТОТИП — НЕ ДЛЯ ВЫПУСКА", DL.Text);
            }
        }
    }

    // =========================================================================
    // Сбор зон из модели
    // =========================================================================
    public static class Collect
    {
        private static double RequireDouble(Entity entity, string key)
        {
            try { return NumericData.ParseRequired(XD.Get(entity, key)); }
            catch (FormatException ex)
            {
                throw new InvalidOperationException("Зона " + entity.Handle + ": поле " + key
                    + " отсутствует или не является конечным числом.", ex);
            }
        }

        public static ProjectData FromModel(Database db, Transaction tr)
        {
            var pd = new ProjectData();
            pd.HasProjectSettings = AGPT.Cad.ProjectSettingsStore.TryRead(db, tr, "APPT", out var saved);
            if (pd.HasProjectSettings)
            {
                pd.Cipher = saved.Cipher;
                pd.ObjectName = saved.ObjectName;
                pd.ObjectShort = saved.ObjectShort;
                pd.Stage = saved.Stage;
                pd.CityYear = saved.CityYear;
                pd.Company = saved.Company;
                pd.CompanyGsl = saved.CompanyGsl;
                pd.GenDesigner = saved.GenDesigner;
                pd.VolumeTitle = saved.VolumeTitle;
                pd.VolumeNo = saved.VolumeNo;
                pd.Gip = saved.Gip;
                pd.Checked = saved.Checked;
                pd.Drawn = saved.Drawn;
                pd.NormCtrl = saved.NormCtrl;
                if (string.IsNullOrWhiteSpace(pd.ObjectShort)) pd.ObjectShort = pd.ObjectName;
            }
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForRead);

            foreach (ObjectId id in ms)
            {
                var ent = tr.GetObject(id, OpenMode.ForRead) as Entity;
                if (ent == null || AGPT.Cad.AlbumOutput.IsGenerated(ent)) continue;
                string kind = XD.Get(ent, "KIND");
                string zoneName = XD.Get(ent, "ZONE_NAME");
                string volumeText = XD.Get(ent, "VP");
                bool isZone = ZoneIdentity.IsZone(kind, ent.Layer, DL.Zone, zoneName, volumeText);
                bool zoneCandidate = string.Equals(ent.Layer, DL.Zone, StringComparison.OrdinalIgnoreCase)
                    && (string.IsNullOrWhiteSpace(kind) || string.Equals(kind, "ZONE", StringComparison.Ordinal));
                if (zoneCandidate && !isZone)
                    throw new InvalidOperationException("Некорректные данные зоны " + ent.Handle
                        + ": нужны непустое ZONE_NAME и положительный конечный VP в м³.");
                if (kind == "MODULE" || kind == "EQUIPMENT")
                {
                    string mark = XD.Get(ent, "MARK");
                    if (string.IsNullOrWhiteSpace(mark)) throw new InvalidOperationException("Элемент " + ent.Handle + ": отсутствует MARK.");
                    if (ent is not BlockReference) throw new InvalidOperationException("Элемент " + ent.Handle + ": оборудование должно быть размещённым BlockReference.");
                    pd.Spec.Add(new SpecRow { Name = XD.Get(ent, "NAME") ?? "Оборудование",
                        Mark = mark, Unit = "шт.", Qty = 1, Note = XD.Get(ent, "ROLE") ?? XD.Get(ent, "NOTE") ?? "" });
                }
                if (isZone)
                {
                    var z = new ZoneCalc
                    {
                        Name = XD.Get(ent, "ZONE_NAME") ?? "Зона",
                        Vp = RequireDouble(ent, "VP"),
                        Vn = RequireDouble(ent, "VN"),
                        K1 = RequireDouble(ent, "K1"),
                        K2 = RequireDouble(ent, "K2"),
                        K3 = RequireDouble(ent, "K3"),
                        K4 = RequireDouble(ent, "K4"),
                        ModuleMark = XD.Get(ent, "MODULE") ?? "марка не задана"
                    };
                    Calc.Modules(z);
                    pd.Zones.Add(z);
                }
            }

            pd.Plan = AGPT.Cad.PlanModelCapture.Read(db, tr, DL.App, DL.Zone);
            foreach (var route in pd.Plan.Routes.Where(r => r.Kind == "CABLE"))
            {
                if (string.IsNullOrWhiteSpace(route.Mark) || !route.LengthMetres.HasValue || route.LengthMetres <= 0)
                    throw new InvalidOperationException("Кабель " + route.Id + ": нужны CABLE_MARK, геометрия трассы и известные INSUNITS.");
                pd.Cables.Add(new CableRow { From = route.From, To = route.To, Mark = route.Mark, Length = route.LengthMetres.Value });
                pd.Spec.Add(new SpecRow { Name = "Кабель", Mark = route.Mark, Unit = "м", Qty = route.LengthMetres.Value,
                    Note = "Фактическая длина геометрии" });
            }
            pd.Spec = pd.Spec.GroupBy(r => new { r.Name, r.Mark, r.Unit, r.Note }).Select((g, i) => new SpecRow
            { Pos = i + 1, Name = g.Key.Name, Mark = g.Key.Mark, Unit = g.Key.Unit, Note = g.Key.Note, Qty = g.Sum(r => r.Qty) }).ToList();
            return pd;
        }
    }

    // =========================================================================
    // Команды АППТ
    // =========================================================================
    public class ApptDrawingCommands
    {
        [CommandMethod("APPT_ALBUM")]
        public void Album()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                if (!AGPT.Cad.ProjectSettingsCommands.EnsureConfigured(doc, "APPT")) return;
                using (var tr = db.TransactionManager.StartTransaction())
                {
                    XD.EnsureApp(db, tr);
                    Layers.EnsureAll(db, tr);
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    var pd = Collect.FromModel(db, tr);
                    foreach (string issue in pd.Plan.Issues) ed.WriteMessage("\n[APPT] " + issue);

                    if (!pd.HasProjectSettings)
                        throw new InvalidOperationException("Сначала задайте реквизиты командой APPT_PROJECT.");

                    if (pd.Zones.Count == 0)
                    {
                        ed.WriteMessage("\nЗоны не введены — альбом не построен.");
                        return;
                    }
                    if (string.IsNullOrWhiteSpace(pd.Cipher) || string.IsNullOrWhiteSpace(pd.ObjectName))
                        throw new InvalidOperationException("Для альбома нужны шифр и наименование объекта.");
                    AGPT.Cad.AlbumOutput.Replace(ms, tr, "APPT", () => SheetGen.FullAlbum(ms, tr, pd));
                    tr.Commit();
                    ed.WriteMessage("\n[APPT_ALBUM] Построено листов: " + pd.SheetCount);

                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[APPT_ALBUM] Ошибка: " + ex.Message);
            }
        }

        [CommandMethod("APPT_CALC")]
        public void CalcCmd()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var ed = doc.Editor;
            try
            {
                using (var tr = doc.Database.TransactionManager.StartTransaction())
                {
                    XD.EnsureApp(doc.Database, tr);
                    var pd = Collect.FromModel(doc.Database, tr);
                    foreach (string issue in pd.Plan.Issues) ed.WriteMessage("\n[APPT] " + issue);
                    if (pd.Zones.Count == 0) throw new InvalidOperationException("Нет зон: задайте контуры и исходные данные командой APPT_ZONE.");
                    foreach (var z in pd.Zones)
                    {
                        Calc.Modules(z);
                        ed.WriteMessage(
                            $"\n[{z.Name}] Vp={z.Vp:F1} м³  Vн={z.Vn:F0}  N={z.NRaw:F3} → {z.NWork}+{z.NRes} шт ({z.ModuleMark})");
                    }
                    tr.Commit();
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[APPT_CALC] Ошибка: " + ex.Message);
            }
        }

        [CommandMethod("APPT_ZONE")]
        public void ZoneCmd()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                var nameRes = ed.GetString("\nИмя зоны <Венткамера>: ");
                if (nameRes.Status != PromptStatus.OK && nameRes.Status != PromptStatus.None) return;
                string name = (nameRes.Status == PromptStatus.OK && !string.IsNullOrWhiteSpace(nameRes.StringResult))
                    ? nameRes.StringResult.Trim() : "Венткамера";

                var vpRes = ed.GetDouble(new PromptDoubleOptions("\nОбъём Vp, м³ <50>: ")
                {
                    DefaultValue = 50, UseDefaultValue = true, AllowNegative = false, AllowZero = false
                });
                if (vpRes.Status != PromptStatus.OK && vpRes.Status != PromptStatus.None) return;
                double vp = vpRes.Status == PromptStatus.OK ? vpRes.Value : 50;

                var vnRes = ed.GetDouble(new PromptDoubleOptions("\nVн одного модуля, м³ <70>: ")
                {
                    DefaultValue = 70, UseDefaultValue = true, AllowNegative = false, AllowZero = false
                });
                if (vnRes.Status != PromptStatus.OK && vnRes.Status != PromptStatus.None) return;
                double vn = vnRes.Status == PromptStatus.OK ? vnRes.Value : 70;

                var k4Res = ed.GetDouble(new PromptDoubleOptions("\nk4 (негерметичность) <1.2>: ")
                {
                    DefaultValue = 1.2, UseDefaultValue = true, AllowNegative = false, AllowZero = false
                });
                if (k4Res.Status != PromptStatus.OK && k4Res.Status != PromptStatus.None) return;
                double k4 = k4Res.Status == PromptStatus.OK ? k4Res.Value : 1.2;

                var moduleInput = ed.GetString(new PromptStringOptions("\nМарка выбранного модуля (по паспорту): ") { AllowSpaces = true });
                if (moduleInput.Status != PromptStatus.OK || string.IsNullOrWhiteSpace(moduleInput.StringResult)) return;
                double[] coefficients = new double[3];
                for (int i = 0; i < coefficients.Length; i++)
                {
                    var input = ed.GetDouble(new PromptDoubleOptions("\nk" + (i + 1) + " (по исходным данным) <1>: ")
                        { DefaultValue = 1, UseDefaultValue = true, AllowNegative = false, AllowZero = false });
                    if (input.Status != PromptStatus.OK && input.Status != PromptStatus.None) return;
                    coefficients[i] = input.Status == PromptStatus.OK ? input.Value : 1;
                }

                var boundaryOptions = new PromptEntityOptions("\nВыберите существующий замкнутый контур помещения: ");
                boundaryOptions.SetRejectMessage("\nНужна замкнутая полилиния.");
                boundaryOptions.AddAllowedClass(typeof(Polyline), true);
                var boundary = ed.GetEntity(boundaryOptions);
                if (boundary.Status != PromptStatus.OK) return;

                using (var tr = db.TransactionManager.StartTransaction())
                {
                    XD.EnsureApp(db, tr);
                    Layers.EnsureAll(db, tr);
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);

                    var pl = (Polyline)tr.GetObject(boundary.ObjectId, OpenMode.ForRead);
                    AGPT.ProjectCommands.RequireTaggable(pl, DL.App, "ZONE");
                    if (!pl.Closed || pl.NumberOfVertices < 3 || pl.Area <= 0)
                        throw new InvalidOperationException("Зона требует замкнутый контур с положительной площадью.");
                    pl.UpgradeOpen();
                    pl.Layer = DL.Zone;

                    var z = new ZoneCalc { Name = name, Vp = vp, Vn = vn, K1 = coefficients[0], K2 = coefficients[1], K3 = coefficients[2], K4 = k4, ModuleMark = moduleInput.StringResult.Trim() };
                    Calc.Modules(z);

                    XD.Set(pl,
                        ("KIND", "ZONE"), ("ZONE_NAME", name),
                        ("VP", NumericData.Format(vp)),
                        ("VN", NumericData.Format(vn)),
                        ("K1", NumericData.Format(z.K1)), ("K2", NumericData.Format(z.K2)), ("K3", NumericData.Format(z.K3)),
                        ("K4", NumericData.Format(k4)),
                        ("MODULE", z.ModuleMark),
                        ("N", z.NWork.ToString()));

                    tr.Commit();
                    ed.WriteMessage($"\n[APPT_ZONE] {name}: Vp={vp:F1} → N={z.NWork}+{z.NRes} шт");
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[APPT_ZONE] Ошибка: " + ex.Message);
            }
        }

        [CommandMethod("APPT_SHEET_OD")]
        public void SheetOd() => RunSheet((ms, tr, pd) => SheetGen.GeneralData(ms, tr, pd, 0));

        [CommandMethod("APPT_SHEET_CALC")]
        public void SheetCalc() => RunSheet((ms, tr, pd) => SheetGen.CalcSheet(ms, tr, pd, 0));

        [CommandMethod("APPT_SHEET_SPEC")]
        public void SheetSpec() => RunSheet((ms, tr, pd) => SheetGen.Specification(ms, tr, pd, 0));

        void RunSheet(Action<BlockTableRecord, Transaction, ProjectData> build)
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                using (var tr = db.TransactionManager.StartTransaction())
                {
                    XD.EnsureApp(db, tr);
                    Layers.EnsureAll(db, tr);
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);
                    var pd = Collect.FromModel(db, tr);
                    foreach (string issue in pd.Plan.Issues) ed.WriteMessage("\n[APPT] " + issue);
                    build(ms, tr, pd);
                    tr.Commit();
                    ed.WriteMessage("\n[APPT] Лист сформирован в модели.");
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[APPT] Ошибка: " + ex.Message);
            }
        }
    }
}
