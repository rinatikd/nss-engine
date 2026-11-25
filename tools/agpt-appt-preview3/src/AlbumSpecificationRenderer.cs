using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using AGPT.Shared;
using AGPT.Drawings;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace AGPT.Cad
{
    /// <summary>Specification presentation inspired by the supplied project albums.
    /// Blank catalogue fields stay blank; this renderer makes no conformity claim.</summary>
    public static class AlbumSpecificationRenderer
    {
        public const int RowsPerPage = 20;
        const double FontSize = 2.2;
        const double LinePitch = 3.1;
        static readonly double[] Widths = { 12, 110, 55, 28, 36, 17, 20, 25, 84 };
        static readonly string[] Headers = { "Поз.", "Наименование и техническая характеристика",
            "Тип, марка, обозначение документа", "Код продукции", "Поставщик",
            "Ед. изм.", "Кол.", "Масса 1 ед., кг", "Примечание" };

        // Pagination and rendering share exactly the same wrapped fragments. A very long
        // source row continues on subsequent lines/pages without dropping source text.
        public static int PageCount(ProjectData pd) => BuildPages(pd).Count;

        static List<List<SpecificationFragment>> BuildPages(ProjectData pd)
        {
            if (pd == null) throw new ArgumentNullException(nameof(pd));
            return SpecificationPageLayout.Plan(pd.Spec.Select(row => new[] {
                row.Pos.ToString(CultureInfo.InvariantCulture), row.Name, row.Mark, "", "", row.Unit,
                row.Qty.ToString("0.###", CultureInfo.InvariantCulture), "", row.Note }), Widths,
                rowsPerPage: RowsPerPage, fontSize: FontSize, linePitch: LinePitch);
        }

        public static void Render(BlockTableRecord target, Transaction tr, ProjectData pd, int page, Point3d origin)
        {
            if (target == null || tr == null) throw new ArgumentNullException();
            var pages = BuildPages(pd);
            if (page < 0 || page >= pages.Count) throw new ArgumentOutOfRangeException(nameof(page));
            ObjectId style = Draw.EnsureTextStyle(target.Database, tr);
            double left = origin.X + DL.BindLeft + 2;
            double top = origin.Y + 279;
            double width = Widths.Sum();
            void Line(double x0, double y0, double x1, double y1) => Draw.Line(target, tr, x0, y0, x1, y1, DL.Table);
            void Text(string value, double x, double y, double size = FontSize)
            {
                var entity = new DBText { Position = new Point3d(x, y, origin.Z), Height = size,
                    TextString = (value ?? "").TrimEnd('\r', '\n').Replace('\t', ' '),
                    Layer = DL.Text, TextStyleId = style, WidthFactor = .85 };
                target.AppendEntity(entity);
                tr.AddNewlyCreatedDBObject(entity, true);
            }
            void CellLines(string[] lines, double x, double y, double size = FontSize)
            {
                for (int i = 0; i < lines.Length; i++) Text(lines[i], x + 1.5, y - 3.2 - i * LinePitch, size);
            }
            Text("СПЕЦИФИКАЦИЯ ОБОРУДОВАНИЯ, ИЗДЕЛИЙ И МАТЕРИАЛОВ", left, origin.Y + 285, 3);
            Text("По данным модели DWG • раздел " + (page + 1) + " / " + pages.Count,
                left + 260, origin.Y + 285, 2.2);
            const double headerHeight = 16;
            const double numbersHeight = 5;
            const double sectionHeight = 7;
            double bodyTop = top - headerHeight - numbersHeight - sectionHeight;
            double bottom = bodyTop - pages[page].Sum(f => f.Height);
            if (pd.Spec.Count == 0) bottom = bodyTop - 8;
            double x = left;
            Line(left, top, left + width, top);
            for (int i = 0; i < Widths.Length; i++)
            {
                Line(x, top, x, bottom);
                CellLines(SpecificationPageLayout.Wrap(Headers[i], Widths[i] - 3, 2), x, top - .5, 2);
                Text((i + 1).ToString(CultureInfo.InvariantCulture), x + Widths[i] / 2 - .7,
                    top - headerHeight - 3.4, 1.8);
                x += Widths[i];
            }
            Line(x, top, x, bottom);
            Line(left, top - headerHeight, x, top - headerHeight);
            Line(left, top - headerHeight - numbersHeight, x, top - headerHeight - numbersHeight);
            Text("Оборудование и материалы, учтённые в модели", left + Widths[0] + 2, bodyTop + 2.2, 2.4);
            Line(left, bodyTop, x, bodyTop);
            double y = bodyTop;
            foreach (var fragment in pages[page])
            {
                double cellX = left;
                for (int i = 0; i < Widths.Length; i++)
                {
                    CellLines(fragment.Cells[i], cellX, y);
                    cellX += Widths[i];
                }
                if (fragment.IsContinuation && fragment.Cells[0].Length == 0)
                    CellLines(new[] { pd.Spec[fragment.SourceIndex].Pos.ToString(CultureInfo.InvariantCulture), "пр." }, left, y);
                y -= fragment.Height;
                Line(left, y, left + width, y);
            }
            if (pd.Spec.Count == 0)
            {
                Line(left, bottom, left + width, bottom);
                double noticeY = bottom - 10;
                Text("В модели не размещено оборудование и не учтены трассы для спецификации.", left + 2, noticeY, 2.8);
                Text("Количества появляются из размещённых устройств, труб и кабелей. Образцовые количества не подставляются.",
                    left + 2, noticeY - 7, 2.4);
                if (pd.Zones.Count > 0)
                {
                    Text("Расчётная потребность в модулях (не размещение)", left + 2, noticeY - 22, 2.8);
                    Text("Зон: " + pd.Zones.Count + "; рабочих модулей: " + pd.Zones.Sum(z => (long)z.ModuleCountWork)
                        + "; резервных: " + pd.Zones.Sum(z => (long)z.ModuleCountRes) + ".", left + 2, noticeY - 29, 2.5);
                    Text("Прототипный расчёт. Потребность по зонам приведена отдельно; в спецификацию размещения не включена.",
                        left + 2, noticeY - 36, 2.3);
                }
            }
            Text("Код продукции, поставщик и масса не заданы в модели и оставлены пустыми. Количества — по фактическим данным DWG.",
                left, origin.Y + 75, 1.8);
        }
    }
}
