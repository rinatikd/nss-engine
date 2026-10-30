// =============================================================================
// AGPT AutoCAD Plugin — расчёт + генерация чертежей В МОДЕЛИ
// Принцип: вся графика и текст (общие данные, расчёты, спецификация, КЖ,
// аксонометрия, структурная схема) собираются как ЧЕРТЕЖИ в Model/Layout,
// а не как внешние Word/Excel.
// Эталон оформления: РИН-ОК-НН1-Р-ГАПТ, ГОСТ Р 21.101, ГОСТ 21.110
// .NET Framework 4.8 / AutoCAD 2018–2025
// =============================================================================

using System;
using AGPT.Shared;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Autodesk.AutoCAD.Runtime;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Colors;

[assembly: CommandClass(typeof(AGPT.Drawings.AgptDrawingCommands))]

namespace AGPT.Drawings
{
    // =========================================================================
    // Константы слоёв чертежа альбома
    // =========================================================================
    public static class DL
    {
        public const string App = "AGPT";
        public const string Frame = "AGPT-FRAME";   // рамка, штамп
        public const string Text = "AGPT-TEXT";     // текст общих данных / расчётов
        public const string Table = "AGPT-TABLE";   // таблицы
        public const string Scheme = "AGPT-SCHEME"; // структурная / электрическая
        public const string Axo = "AGPT-AXO";
        public const string Eq = "AGPT-EQ";
        public const string Pipe = "AGPT-PIPE";
        public const string Mark = "AGPT-MARK";
        public const string Zone = "AGPT-ZONE";

        // Форматы листов (мм, модель в мм)
        public const double A3W = 420.0, A3H = 297.0;
        public const double A2W = 594.0, A2H = 420.0;
        public const double Margin = 5.0;      // поле слева для подшивки — 20 мм по ГОСТ, упрощённо 5+20
        public const double BindLeft = 20.0;
        /// <summary>Низ рабочей области (мм): штамп 55 + зазор. Контент не ниже oy+ContentBottom.</summary>
        public const double ContentBottom = 68.0;
        public const double ContentTop = 290.0;
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
            Ensure(db, tr, DL.Axo, 4);
            Ensure(db, tr, DL.Eq, 1);
            Ensure(db, tr, DL.Pipe, 5);
            Ensure(db, tr, DL.Mark, 7);
            Ensure(db, tr, DL.Zone, 8);
        }
    }

    // =========================================================================
    // Примитивы чертежа (линии, текст, рамка, штамп, таблица)
    // =========================================================================
    /// <summary>
    /// Вставка рамки/штампа из эталонного DWG (WBLOCK).
    /// Ищет: c:\Work\AGPT_Plugin\blocks\AGPT_Frame_A3.dwg и рядом с DLL.
    /// </summary>
    public static class FrameBlock
    {
        /// <summary>Имя блока рамки. Сначала ищем ММХ_Штамп (из эталона), иначе AGPT_Frame_A3_v2.</summary>
        public const string BlockNamePreferred = "ММХ_Штамп";
        public const string BlockName = "AGPT_Frame_A3_v2";
        static string _resolvedPath;

        public static void ResetCache()
        {
            FrameWidth = DL.A3W;
            FrameHeight = DL.A3H;
            InsertScale = 1.0;
            SheetGen.Pitch = 500.0;
        }

        public static string FindPath()
        {
            if (_resolvedPath != null && File.Exists(_resolvedPath)) return _resolvedPath;
            _resolvedPath = null;
            var candidates = new List<string>();
            try
            {
                string dll = Assembly.GetExecutingAssembly().Location;
                string dir = Path.GetDirectoryName(dll) ?? "";
                candidates.Add(Path.Combine(dir, "blocks", "ММХ_Штамп.dwg"));
                candidates.Add(Path.Combine(dir, "blocks", "MMH_Stamp.dwg"));
                candidates.Add(Path.Combine(dir, "blocks", "AGPT_Frame_A3.dwg"));
                candidates.Add(Path.Combine(dir, "blocks", "AGPT_Frame_A3.dxf"));
                candidates.Add(Path.Combine(dir, "..", "blocks", "AGPT_Frame_A3.dwg"));
                candidates.Add(Path.Combine(dir, "..", "blocks", "AGPT_Frame_A3.dxf"));
                candidates.Add(Path.Combine(dir, "..", "..", "blocks", "AGPT_Frame_A3.dwg"));
                candidates.Add(Path.Combine(dir, "..", "..", "blocks", "AGPT_Frame_A3.dxf"));
                candidates.Add(Path.Combine(dir, "AGPT_Frame_A3.dxf"));
                candidates.Add(Path.Combine(dir, "AGPT_Frame_A3.dwg"));
            }
            catch { }
            candidates.Add(@"c:\Work\AGPT_Plugin\blocks\MMX_ШТАМП.dwg");
            candidates.Add(@"C:\Work\AGPT_Plugin\blocks\MMX_ШТАМП.dwg");
            candidates.Add(@"c:\Work\AGPT_Plugin\blocks\ММХ_Штамп.dwg");
            candidates.Add(@"C:\Work\AGPT_Plugin\blocks\ММХ_Штамп.dwg");
            candidates.Add(@"c:\Work\AGPT_Plugin\blocks\MMH_Stamp.dwg");
            candidates.Add(@"c:\Work\AGPT_Plugin\blocks\AGPT_Frame_A3.dwg");
            candidates.Add(@"C:\Work\AGPT_Plugin\blocks\AGPT_Frame_A3.dwg");
            candidates.Add(@"c:\Work\AGPT_Plugin\blocks\AGPT_Frame_A3.dxf");
            candidates.Add(@"C:\Work\AGPT_Plugin\blocks\AGPT_Frame_A3.dxf");
            foreach (var p in candidates)
            {
                try
                {
                    string full = Path.GetFullPath(p);
                    if (File.Exists(full))
                    {
                        _resolvedPath = full;
                        return full;
                    }
                }
                catch { }
            }
            return null;
        }

        /// <summary>
        /// Импорт DWG как блок: габарит нормализуется, min → (0,0).
        /// Работает даже при неверной базовой точке WBLOCK.
        /// </summary>
        public static ObjectId EnsureDefinition(Database db, Transaction tr)
        {
            // ObjectIds and measured size belong to this Database, never the previous DWG.
            ResetCache();
            ObjectId definitionId = ObjectId.Null;
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            // 0) Блок уже в чертеже (вставили эталон / WBLOCK / копирование)
            foreach (string nm in new[] { BlockNamePreferred, "ММХ_Штамп", "MMH_Stamp", BlockName })
            {
                if (bt.Has(nm))
                {
                    definitionId = bt[nm];
                    try
                    {
                        var btr0 = (BlockTableRecord)tr.GetObject(definitionId, OpenMode.ForRead);
                        // оценить ширину по объектам блока
                        Extents3d? be = null;
                        foreach (ObjectId cid in btr0)
                        {
                            var e = tr.GetObject(cid, OpenMode.ForRead) as Entity;
                            if (e == null) continue;
                            try
                            {
                                var ee = e.GeometricExtents;
                                if (be == null) be = ee;
                                else { var x = be.Value; x.AddExtents(ee); be = x; }
                            }
                            catch { }
                        }
                        if (be.HasValue)
                        {
                            SetMeasuredSize(
                                be.Value.MaxPoint.X - be.Value.MinPoint.X,
                                be.Value.MaxPoint.Y - be.Value.MinPoint.Y);
                        }
                    }
                    catch { }
                    return definitionId;
                }
            }

            // 1) Попытка загрузить DXF/DWG
            string path = FindPath();
            if (path != null)
            {
                try
                {
                    using (var src = new Database(false, true))
                    {
                        if (path.EndsWith(".dxf", StringComparison.OrdinalIgnoreCase))
                            src.DxfIn(path, null);
                        else
                            src.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, "");

                        var ids = new ObjectIdCollection();
                        Extents3d? ext = null;
                        using (var trSrc = src.TransactionManager.StartTransaction())
                        {
                            var btSrc = (BlockTable)trSrc.GetObject(src.BlockTableId, OpenMode.ForRead);
                            var msSrc = (BlockTableRecord)trSrc.GetObject(btSrc[BlockTableRecord.ModelSpace], OpenMode.ForRead);
                            foreach (ObjectId eid in msSrc)
                            {
                                var ent = trSrc.GetObject(eid, OpenMode.ForRead) as Entity;
                                if (ent == null) continue;
                                ids.Add(eid);
                                try
                                {
                                    var ee = ent.GeometricExtents;
                                    if (ext == null) ext = ee;
                                    else { var x = ext.Value; x.AddExtents(ee); ext = x; }
                                }
                                catch { }
                            }
                            trSrc.Commit();
                        }

                        if (ids.Count > 0)
                        {
                            bt.UpgradeOpen();
                            var newBtr = new BlockTableRecord { Name = BlockName };
                            ObjectId newBtrId = bt.Add(newBtr);
                            tr.AddNewlyCreatedDBObject(newBtr, true);
                            var map = new IdMapping();
                            src.WblockCloneObjects(ids, newBtrId, map, DuplicateRecordCloning.Replace, false);
                            if (ext.HasValue)
                            {
                                var min = ext.Value.MinPoint;
                                var disp = Matrix3d.Displacement(new Vector3d(-min.X, -min.Y, 0));
                                var btrWrite = (BlockTableRecord)tr.GetObject(newBtrId, OpenMode.ForWrite);
                                foreach (ObjectId cid in btrWrite)
                                {
                                    var e = tr.GetObject(cid, OpenMode.ForWrite) as Entity;
                                    if (e != null) e.TransformBy(disp);
                                }
                                SetMeasuredSize(
                                    ext.Value.MaxPoint.X - ext.Value.MinPoint.X,
                                    ext.Value.MaxPoint.Y - ext.Value.MinPoint.Y);
                            }
                            definitionId = newBtrId;
                            return definitionId;
                        }
                    }
                }
                catch
                {
                    // DXF/DWG не прочитался — ниже программный блок
                }
            }

            // 2) Программное определение блока рамки A3 + штамп (всегда работает)
            try
            {
                definitionId = BuildFrameBlockDef(db, tr, bt);
            }
            catch
            {
                definitionId = ObjectId.Null;
            }
            return definitionId;
        }

        /// <summary>Создать блок рамки A3+штамп геометрией (без внешнего файла).</summary>
        static ObjectId BuildFrameBlockDef(Database db, Transaction tr, BlockTable bt)
        {
            if (bt.Has(BlockName)) return bt[BlockName];
            bt.UpgradeOpen();
            var btr = new BlockTableRecord { Name = BlockName };
            ObjectId id = bt.Add(btr);
            tr.AddNewlyCreatedDBObject(btr, true);

            void AddLine(double x1, double y1, double x2, double y2)
            {
                var l = new Line(new Point3d(x1, y1, 0), new Point3d(x2, y2, 0)) { Layer = DL.Frame };
                btr.AppendEntity(l); tr.AddNewlyCreatedDBObject(l, true);
            }
            void AddRect(double x1, double y1, double x2, double y2)
            {
                AddLine(x1, y1, x2, y1); AddLine(x2, y1, x2, y2);
                AddLine(x2, y2, x1, y2); AddLine(x1, y2, x1, y1);
            }
            void AddText(double x, double y, double h, string s)
            {
                var t = new DBText
                {
                    Position = new Point3d(x, y, 0),
                    Height = h,
                    TextString = s ?? "",
                    Layer = DL.Text
                };
                btr.AppendEntity(t); tr.AddNewlyCreatedDBObject(t, true);
            }

            double W = DL.A3W, H = DL.A3H, M = DL.Margin, B = DL.BindLeft;
            AddRect(0, 0, W, H);
            AddRect(B, M, W - M, H - M);

            double sw = 185, sh = 55;
            double sx = W - M - sw, sy = M;
            AddRect(sx, sy, sx + sw, sy + sh);
            AddLine(sx, sy + 15, sx + sw, sy + 15);
            AddLine(sx, sy + 25, sx + sw, sy + 25);
            AddLine(sx, sy + 40, sx + sw, sy + 40);
            AddLine(sx + 55, sy, sx + 55, sy + 15);
            AddLine(sx + 95, sy, sx + 95, sy + 15);
            AddLine(sx + 130, sy, sx + 130, sy + 15);
            AddLine(sx + 115, sy + 25, sx + 115, sy + sh);
            AddText(sx + 2, sy + 45, 2.5, "Наименование");
            AddText(sx + 117, sy + 48, 1.5, "");
            AddText(sx + 117, sy + 41, 1.3, "");
            AddText(sx + 2, sy + 30, 1.5, "Объект");
            AddText(sx + 2, sy + 17, 2.0, "Шифр");
            AddText(sx + 2, sy + 4, 1.4, "Стадия");
            AddText(sx + 20, sy + 4, 2.0, "РП");
            AddText(sx + 57, sy + 4, 1.4, "Лист");
            AddText(sx + 97, sy + 4, 1.4, "Листов");

            double sigW = 120, sigH = 55;
            double sigX = sx - sigW, sigY = sy;
            AddRect(sigX, sigY, sigX + sigW, sigY + sigH);
            AddLine(sigX, sigY + 15, sigX + sigW, sigY + 15);
            foreach (double x in new[] { 18.0, 40, 58, 78, 100 })
                AddLine(sigX + x, sigY, sigX + x, sigY + 15);
            AddText(sigX + 1, sigY + 4, 1.3, "Изм.");
            AddText(sigX + 19, sigY + 4, 1.3, "Кол.");
            AddText(sigX + 41, sigY + 4, 1.3, "Лист");
            AddText(sigX + 59, sigY + 4, 1.3, "№док");
            AddText(sigX + 79, sigY + 4, 1.3, "Подп.");
            AddText(sigX + 101, sigY + 4, 1.3, "Дата");
            string[] roles = { "Н.контр.", "Выполнил", "Проверил", "ГИП" };
            string[] names = { "", "", "", "" };
            double rowH = (sigH - 15) / 4.0;
            for (int i = 0; i < 4; i++)
            {
                double y1 = sigY + 15 + i * rowH;
                if (i > 0) AddLine(sigX, y1, sigX + sigW, y1);
                AddText(sigX + 1, y1 + 2.5, 1.5, roles[i]);
                AddText(sigX + 32, y1 + 2.5, 1.5, names[i]);
                AddText(sigX + 100, y1 + 2.5, 1.3, "");
            }
            AddLine(sigX + 30, sigY + 15, sigX + 30, sigY + sigH);
            AddLine(sigX + 95, sigY + 15, sigX + 95, sigY + sigH);
            AddText(B + 2, M + 2, 1.4, "Инв. № подл.");
            AddText(B + 2, M + 12, 1.4, "Подп. и дата");
            AddText(B + 2, M + 22, 1.4, "Взам. инв. №");

            InsertScale = 1.0;
            FrameWidth = W;
            FrameHeight = H;
            SheetGen.Pitch = Math.Max(500.0, W + 40.0);
            return id;
        }

        /// <summary>Ширина рамки после нормализации (для шага листов).</summary>
        public static double FrameWidth = DL.A3W;
        public static double FrameHeight = DL.A3H;
        /// <summary>Масштаб вставки, если геометрия блока не в мм A3 (например 1:100).</summary>
        public static double InsertScale = 1.0;

        /// <summary>
        /// Нормализация габарита: A3 ≈ 420×297 мм.
        /// Если блок нарисован в «бумажных» единицах ×100 — масштабируем.
        /// </summary>
        public static void SetMeasuredSize(double w, double h)
        {
            if (!double.IsFinite(w) || !double.IsFinite(h) || w <= 0 || h <= 0)
                throw new InvalidOperationException("Недопустимые размеры рамки.");
            if (w < 1) w = DL.A3W;
            if (h < 1) h = DL.A3H;
            // Слишком большой (часто 42000 ≈ A3×100)
            if (w > 2000 || h > 1500)
            {
                InsertScale = DL.A3W / w;
                FrameWidth = DL.A3W;
                FrameHeight = h * InsertScale;
                SheetGen.Pitch = Math.Max(500.0, FrameWidth + 40.0);
                return;
            }
            // Слишком маленький
            if (w < 50)
            {
                InsertScale = DL.A3W / w;
                FrameWidth = DL.A3W;
                FrameHeight = h * InsertScale;
                SheetGen.Pitch = Math.Max(500.0, FrameWidth + 40.0);
                return;
            }
            InsertScale = 1.0;
            FrameWidth = w;
            FrameHeight = h;
            SheetGen.Pitch = Math.Max(500.0, w + 40.0);
        }

        /// <summary>
        /// Одна вставка BlockReference в (ox, oy). Определение блока — один раз.
        /// Шаг между листами = FrameWidth + 30 мм.
        /// </summary>
        public static BlockReference CreateReference(Transaction tr, ObjectId defId, Point3d origin)
        {
            var definition = (BlockTableRecord)tr.GetObject(defId, OpenMode.ForRead);
            Extents3d? bounds = null;
            foreach (ObjectId childId in definition)
            {
                var entity = tr.GetObject(childId, OpenMode.ForRead) as Entity;
                if (entity == null) continue;
                try
                {
                    var extent = entity.GeometricExtents;
                    if (bounds == null) bounds = extent;
                    else { var merged = bounds.Value; merged.AddExtents(extent); bounds = merged; }
                }
                catch { }
            }
            if (!bounds.HasValue)
                throw new InvalidOperationException("Нельзя измерить геометрию рамки.");
            SetMeasuredSize(bounds.Value.MaxPoint.X - bounds.Value.MinPoint.X,
                bounds.Value.MaxPoint.Y - bounds.Value.MinPoint.Y);
            double scale = InsertScale;
            var minimum = bounds.Value.MinPoint;
            var basePoint = definition.Origin;
            var insertion = new Point3d(origin.X - (minimum.X - basePoint.X) * scale,
                origin.Y - (minimum.Y - basePoint.Y) * scale, origin.Z);
            return new BlockReference(insertion, defId) { ScaleFactors = new Scale3d(scale, scale, 1) };
        }

        public static bool TryInsert(BlockTableRecord ms, Transaction tr, Database db,
            double ox, double oy)
        {
            try
            {
                ObjectId defId = EnsureDefinition(db, tr);
                if (defId == ObjectId.Null || defId.IsNull) return false;
                var reference = CreateReference(tr, defId, new Point3d(ox, oy, 0));
                try { reference.Layer = DL.Frame; } catch { }
                ms.AppendEntity(reference);
                tr.AddNewlyCreatedDBObject(reference, true);
                return true;
            }
            catch (System.Exception ex)
            {
                Application.DocumentManager.MdiActiveDocument?.Editor.WriteMessage(
                    "\n[AGPT_FRAME] Вставка блока не выполнена: " + ex.Message);
                return false;
            }
        }
    }

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

        /// <summary>Стиль текста AGPT: Arial (близок к эталону) или Standard.</summary>
        public static ObjectId EnsureTextStyle(Database db, Transaction tr)
        {
            var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
            if (tst.Has("AGPT"))
                return tst["AGPT"];
            tst.UpgradeOpen();
            var tsr = new TextStyleTableRecord
            {
                Name = "AGPT",
                FileName = "Arial.ttf",
                TextSize = 0, // annotative / set per entity
                XScale = 1.0
            };
            try
            {
                tst.Add(tsr);
                tr.AddNewlyCreatedDBObject(tsr, true);
            }
            catch
            {
                // fallback already Standard
                return db.Textstyle;
            }
            return tsr.ObjectId;
        }

        public static ObjectId Text(BlockTableRecord btr, Transaction tr,
            double x, double y, double h, string s, string layer,
            AttachmentPoint align = AttachmentPoint.BottomLeft, short color = 7)
        {
            var t = new DBText
            {
                Position = new Point3d(x, y, 0),
                Height = h,
                TextString = s ?? "",
                Layer = layer
            };
            try
            {
                var db = btr.Database;
                if (db != null)
                {
                    using (var t2 = db.TransactionManager.StartTransaction())
                    {
                        // style may already be in parent tr; set by name if exists
                        t2.Commit();
                    }
                    var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                    if (tst.Has("AGPT"))
                        t.TextStyleId = tst["AGPT"];
                }
            }
            catch { }
            if (color != 7) t.Color = Color.FromColorIndex(ColorMethod.ByAci, color);
            if (align != AttachmentPoint.BottomLeft)
            {
                t.HorizontalMode = TextHorizontalMode.TextLeft;
                t.VerticalMode = TextVerticalMode.TextBottom;
                if (align == AttachmentPoint.BottomCenter || align == AttachmentPoint.MiddleCenter)
                {
                    t.HorizontalMode = TextHorizontalMode.TextCenter;
                    t.AlignmentPoint = new Point3d(x, y, 0);
                }
            }
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
            try
            {
                var db = btr.Database;
                var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                if (tst.Has("AGPT"))
                    mt.TextStyleId = tst["AGPT"];
            }
            catch { }
            btr.AppendEntity(mt); tr.AddNewlyCreatedDBObject(mt, true);
            return mt.ObjectId;
        }

        public static ObjectId Circle(BlockTableRecord btr, Transaction tr,
            double cx, double cy, double r, string layer, short color = 7)
        {
            var c = new Circle(new Point3d(cx, cy, 0), Vector3d.ZAxis, r);
            c.Layer = layer;
            if (color != 7) c.Color = Color.FromColorIndex(ColorMethod.ByAci, color);
            btr.AppendEntity(c); tr.AddNewlyCreatedDBObject(c, true);
            return c.ObjectId;
        }

        /// <summary>Ось: кружок с буквой/цифрой + штриховая линия сетки.</summary>
        public static void AxisBubble(BlockTableRecord btr, Transaction tr,
            double cx, double cy, string mark, bool horizontalLine, double lineLen, string layer)
        {
            double r = 3.2;
            Circle(btr, tr, cx, cy, r, layer, 7);
            Text(btr, tr, cx - mark.Length * 0.9, cy - 1.2, 2.2, mark, layer);
            // ось — пунктир сегментами
            int n = Math.Max(4, (int)(lineLen / 4.0));
            double step = lineLen / n;
            for (int i = 0; i < n; i += 2)
            {
                double a = i * step, b = Math.Min((i + 1) * step, lineLen);
                if (horizontalLine)
                    Line(btr, tr, cx + a, cy, cx + b, cy, layer, 8);
                else
                    Line(btr, tr, cx, cy - a, cx, cy - b, layer, 8);
            }
        }

        /// <summary>Отметка уровня: стрелка + текст (например −2.500).</summary>
        public static void ElevationMark(BlockTableRecord btr, Transaction tr,
            double x, double y, string elev, string layer)
        {
            // горизонталь + треугольник
            Line(btr, tr, x, y, x + 12, y, layer, 1);
            Line(btr, tr, x, y, x + 3, y + 2, layer, 1);
            Line(btr, tr, x, y, x + 3, y - 2, layer, 1);
            Line(btr, tr, x + 3, y + 2, x + 3, y - 2, layer, 1);
            Text(btr, tr, x + 14, y - 1.2, 2.0, elev, layer, AttachmentPoint.BottomLeft, 1);
        }

        /// <summary>Размерная линия с подписью (мм).</summary>
        public static void DimLine(BlockTableRecord btr, Transaction tr,
            double x0, double y0, double x1, double y1, string label, string layer)
        {
            Line(btr, tr, x0, y0, x1, y1, layer, 7);
            // засечки
            double dx = x1 - x0, dy = y1 - y0;
            double len = Math.Sqrt(dx * dx + dy * dy);
            if (len < 1e-6) return;
            double px = -dy / len * 1.5, py = dx / len * 1.5;
            Line(btr, tr, x0 - px, y0 - py, x0 + px, y0 + py, layer, 7);
            Line(btr, tr, x1 - px, y1 - py, x1 + px, y1 + py, layer, 7);
            Text(btr, tr, (x0 + x1) / 2 - 4, (y0 + y1) / 2 + 1.5, 1.6, label, layer);
        }


        /// <summary>
        /// Рамка + основная надпись по образцу альбома «Детский сад АГПТ 09.02.26»
        /// (ТОО ТехноСтройПроект / РП / подписи ГИП-Проверил-Выполнил-Н.контр.).
        /// </summary>

        /// <summary>
        /// Блок основной надписи с атрибутами (автозамена полей).
        /// Имя блока: AGPT_STAMP. Атрибуты: TITLE, OBJECT, CIPHER, STAGE, SHEET, SHEETS, COMPANY, CITY, GSL, GIP, CHECKED, DRAWN, NCTRL.
        /// </summary>
        public static ObjectId EnsureStampBlock(Database db, Transaction tr)
        {
            const string name = "AGPT_STAMP";
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            if (bt.Has(name)) return bt[name];

            bt.UpgradeOpen();
            var btr = new BlockTableRecord { Name = name };
            ObjectId id = bt.Add(btr);
            tr.AddNewlyCreatedDBObject(btr, true);

            double sw = 185, sh = 55;
            // outer
            var pl = new Polyline(4);
            pl.AddVertexAt(0, new Point2d(0, 0), 0, 0, 0);
            pl.AddVertexAt(1, new Point2d(sw, 0), 0, 0, 0);
            pl.AddVertexAt(2, new Point2d(sw, sh), 0, 0, 0);
            pl.AddVertexAt(3, new Point2d(0, sh), 0, 0, 0);
            pl.Closed = true;
            pl.Layer = DL.Frame;
            btr.AppendEntity(pl); tr.AddNewlyCreatedDBObject(pl, true);

            void HL(double y) {
                var l = new Line(new Point3d(0, y, 0), new Point3d(sw, y, 0)) { Layer = DL.Frame };
                btr.AppendEntity(l); tr.AddNewlyCreatedDBObject(l, true);
            }
            void VL(double x, double y0, double y1) {
                var l = new Line(new Point3d(x, y0, 0), new Point3d(x, y1, 0)) { Layer = DL.Frame };
                btr.AppendEntity(l); tr.AddNewlyCreatedDBObject(l, true);
            }
            HL(15); HL(25); HL(40);
            VL(50, 0, 15); VL(90, 0, 15); VL(125, 0, 15);
            VL(110, 25, 55);

            // Attribute defs
            void Attr(string tag, string prompt, double ax, double ay, double h, string def)
            {
                var ad = new AttributeDefinition();
                ad.Position = new Point3d(ax, ay, 0);
                ad.Tag = tag;
                ad.Prompt = prompt;
                ad.TextString = def;
                ad.Height = h;
                ad.Layer = DL.Text;
                ad.HorizontalMode = TextHorizontalMode.TextLeft;
                ad.VerticalMode = TextVerticalMode.TextBottom;
                ad.AlignmentPoint = ad.Position;
                btr.AppendEntity(ad); tr.AddNewlyCreatedDBObject(ad, true);
            }
            Attr("TITLE", "Наименование листа", 2, 45, 2.5, "Лист");
            Attr("COMPANY", "Организация", 112, 48, 1.6, "");
            Attr("CITY", "Город", 112, 41, 1.4, "");
            Attr("GSL", "ГСЛ", 112, 28, 1.4, "");
            Attr("OBJECT", "Объект", 2, 30, 1.6, "Объект");
            Attr("CIPHER", "Шифр", 2, 17, 2.2, "XX-XX/X-АГПТ");
            Attr("STAGE", "Стадия", 22, 4, 2.2, "РП");
            Attr("SHEET", "Лист", 68, 4, 2.2, "1");
            Attr("SHEETS", "Листов", 130, 4, 2.2, "");

            // Signature block attached to left of stamp in same block? separate - keep in sheet frame
            return id;
        }

        public static void InsertStamp(BlockTableRecord ms, Transaction tr, Database db,
            double sx, double sy,
            string title, string obj, string cipher, string stage, string sheet, string sheets,
            string company, string city, string gsl)
        {
            try
            {
                ObjectId defId = EnsureStampBlock(db, tr);
                var br = new BlockReference(new Point3d(sx, sy, 0), defId);
                br.Layer = DL.Frame;
                ms.AppendEntity(br);
                tr.AddNewlyCreatedDBObject(br, true);

                var btr = (BlockTableRecord)tr.GetObject(defId, OpenMode.ForRead);
                if (!btr.HasAttributeDefinitions) return;
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    { "TITLE", title ?? "" },
                    { "OBJECT", obj ?? "" },
                    { "CIPHER", cipher ?? "" },
                    { "STAGE", stage ?? "РП" },
                    { "SHEET", sheet ?? "" },
                    { "SHEETS", sheets ?? "" },
                    { "COMPANY", company ?? "" },
                    { "CITY", city ?? "" },
                    { "GSL", gsl ?? "" },
                };
                foreach (ObjectId aid in btr)
                {
                    var ad = tr.GetObject(aid, OpenMode.ForRead) as AttributeDefinition;
                    if (ad == null || ad.Constant) continue;
                    var ar = new AttributeReference();
                    ar.SetAttributeFromBlock(ad, br.BlockTransform);
                    if (map.ContainsKey(ad.Tag)) ar.TextString = map[ad.Tag];
                    br.AttributeCollection.AppendAttribute(ar);
                    tr.AddNewlyCreatedDBObject(ar, true);
                }
            }
            catch { }
        }


        public static void SheetFrame(BlockTableRecord btr, Transaction tr,
            double ox, double oy, double w, double h,
            string cipher, string sheetTitle, string sheetNo, string sheetsTotal,
            string objectName, string stage = "РП",
            string company = "",
            string companyGsl = "",
            string cityYear = "",
            string gip = "", string checkedBy = "",
            string drawn = "", string normCtrl = "")
        {
            double left = ox + DL.BindLeft;
            double bottom = oy + DL.Margin;
            double right = ox + w - DL.Margin;
            double top = oy + h - DL.Margin;

            // Основной путь: блок AGPT_Frame_A3 (DXF/DWG) — рамка + штамп по ГОСТ
            bool usedBlock = false;
            try
            {
                var db = btr.Database;
                if (db != null)
                    usedBlock = FrameBlock.TryInsert(btr, tr, db, ox, oy);
            }
            catch { usedBlock = false; }

            if (usedBlock)
            {
                // Блок уже содержит рамку и основную надпись — только заполняем поля
                string titleShort = sheetTitle ?? "";
                if (titleShort.Length > 40) titleShort = titleShort.Substring(0, 38) + "…";
                string objShort = objectName ?? "";
                if (objShort.Length > 55) objShort = objShort.Substring(0, 52) + "…";
                // координаты относительно штампа справа снизу (как в AGPT_Frame_A3)
                Text(btr, tr, right - 183, bottom + 45, 2.4, titleShort, DL.Text);
                Text(btr, tr, right - 183, bottom + 30, 1.6, objShort, DL.Text);
                Text(btr, tr, right - 183, bottom + 17, 2.2, cipher ?? "", DL.Text);
                Text(btr, tr, right - 163, bottom + 4, 2.2, stage ?? "РП", DL.Text);
                Text(btr, tr, right - 117, bottom + 4, 2.2, sheetNo ?? "", DL.Text);
                Text(btr, tr, right - 70, bottom + 4, 2.2, sheetsTotal ?? "", DL.Text);
                Text(btr, tr, right - 68, bottom + 48, 1.4, company ?? "", DL.Text);
                Text(btr, tr, right - 68, bottom + 41, 1.3, cityYear ?? "", DL.Text);
                Text(btr, tr, right - 68, bottom + 28, 1.3, companyGsl ?? "", DL.Text);
                string[] signatureNames = { normCtrl, drawn, checkedBy, gip };
                for (int i = 0; i < signatureNames.Length; i++)
                    Text(btr, tr, right - 273, bottom + 17.5 + i * 10, 1.5,
                        signatureNames[i] ?? "", DL.Text);
                return;
            }

            // Fallback: программная рамка
            Rect(btr, tr, ox, oy, ox + w, oy + h, DL.Frame);
            Rect(btr, tr, left, bottom, right, top, DL.Frame);

            // ===== Основная надпись (ГОСТ) + атрибутный блок AGPT_STAMP =====
            double sw = 185, sh = 55;
            double sx = right - sw;
            double sy = bottom;

            // Атрибутный штамп (поля редактируются через ЕАТТ / диспетчер атрибутов)
            InsertStamp(btr, tr, btr.Database, sx, sy,
                sheetTitle, objectName, cipher, stage, sheetNo, sheetsTotal,
                company, cityYear, companyGsl);

            // Подписи «Стадия/Лист» как статичный текст (атрибуты в блоке AGPT_STAMP)
            Text(btr, tr, sx + 2, sy + 4, 1.5, "Стадия", DL.Text);
            Text(btr, tr, sx + 52, sy + 4, 1.5, "Лист", DL.Text);
            Text(btr, tr, sx + 92, sy + 4, 1.5, "Листов", DL.Text);

            // --- Блок подписей слева от штампа (форма изменений + ГИП…) ---
            double sigW = 105, sigH = 55;
            double sigX = sx - sigW - 1;
            double sigY = sy;
            Rect(btr, tr, sigX, sigY, sigX + sigW, sigY + sigH, DL.Frame);
            // Строка изменений
            Line(btr, tr, sigX, sigY + 12, sigX + sigW, sigY + 12, DL.Frame);
            Text(btr, tr, sigX + 1, sigY + 3, 1.4, "Изм.", DL.Text);
            Text(btr, tr, sigX + 18, sigY + 3, 1.4, "Кол.уч", DL.Text);
            Text(btr, tr, sigX + 42, sigY + 3, 1.4, "Лист", DL.Text);
            Text(btr, tr, sigX + 62, sigY + 3, 1.4, "№док.", DL.Text);
            Text(btr, tr, sigX + 85, sigY + 3, 1.4, "Подп.", DL.Text);
            Line(btr, tr, sigX + 16, sigY, sigX + 16, sigY + 12, DL.Frame);
            Line(btr, tr, sigX + 40, sigY, sigX + 40, sigY + 12, DL.Frame);
            Line(btr, tr, sigX + 58, sigY, sigX + 58, sigY + 12, DL.Frame);
            Line(btr, tr, sigX + 80, sigY, sigX + 80, sigY + 12, DL.Frame);

            // Подписи: 4 строки × (должность | ФИО | дата)
            double rowH = (sigH - 12) / 4.0;
            string[] roles = { "ГИП", "Проверил", "Выполнил", "Н.контр." };
            string[] names = { gip ?? "", checkedBy ?? "", drawn ?? "", normCtrl ?? "" };
            for (int i = 0; i < 4; i++)
            {
                double y1 = sigY + 12 + i * rowH;
                double y2 = y1 + rowH;
                if (i > 0) Line(btr, tr, sigX, y1, sigX + sigW, y1, DL.Frame);
                Text(btr, tr, sigX + 1, y1 + 2.5, 1.6, roles[3 - i], DL.Text);
                Text(btr, tr, sigX + 32, y1 + 2.5, 1.6, names[3 - i], DL.Text);
                Text(btr, tr, sigX + 85, y1 + 2.5, 1.4, "", DL.Text);
            }
            Line(btr, tr, sigX + 30, sigY + 12, sigX + 30, sigY + sigH, DL.Frame);
            Line(btr, tr, sigX + 82, sigY + 12, sigX + 82, sigY + sigH, DL.Frame);

            // Угловые надписи слева (инвентарные)
            Text(btr, tr, left + 2, bottom + 2, 1.5, "Инв. № подл.", DL.Text);
            Text(btr, tr, left + 2, bottom + 12, 1.5, "Подп. и дата", DL.Text);
            Text(btr, tr, left + 2, bottom + 22, 1.5, "Взам. инв. №", DL.Text);
        }

        /// <summary>Упрощённый вызов штампа из ProjectData.</summary>
        public static void SheetFrame(BlockTableRecord btr, Transaction tr,
            double ox, double oy, double w, double h,
            ProjectData pd, string sheetTitle, string sheetNo, string sheetsTotal)
        {
            SheetFrame(btr, tr, ox, oy, w, h,
                pd.Cipher, sheetTitle, sheetNo, sheetsTotal,
                pd.ObjectName, pd.Stage,
                pd.Company, pd.CompanyGsl, pd.CityYear,
                pd.Gip, pd.Checked, pd.Drawn, pd.NormCtrl);
        }

        /// <summary>
        /// Таблица AutoCAD (AcDbTable). (x,y) — левый верх.
        /// При ошибке API — fallback линиями.
        /// </summary>
        /// <summary>Таблица. Возвращает высоту занятой области (мм) для позиционирования следующих элементов.</summary>
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
                // Position = верхний левый угол таблицы
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
            catch
            {
                // fallback — линии
            }

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
                Text(btr, tr, xx + 1, y - rowH + 1.2, 2.2, headers[c], layer);
                xx += colW[c];
            }
            for (int r = 0; r < nData; r++)
            {
                xx = x;
                for (int c = 0; c < cols && c < rows[r].Length; c++)
                {
                    Text(btr, tr, xx + 1, y - (r + 2) * rowH + 1.2, 2.0, rows[r][c], layer);
                    xx += colW[c];
                }
            }
            return height;
        }

        // ----- УГО пожарной автоматики (упрощённо по ГОСТ/практике Рубеж) -----

        /// <summary>Извещатель дымовой — круг с крестом.</summary>
        public static void UgoIp(BlockTableRecord btr, Transaction tr, double cx, double cy, double r, string mark)
        {
            // Сначала блок из Садик.dwg / R-CAD (если загружен в чертёж)
            try
            {
                if (UgoLib.TryInsert(btr, tr, btr.Database, UgoLib.IpNames, cx, cy, 0))
                {
                    if (!string.IsNullOrEmpty(mark))
                        Text(btr, tr, cx + r + 0.8, cy - 0.5, Math.Max(1.2, r * 0.9), mark, DL.Mark);
                    return;
                }
            }
            catch { }
            try
            {
                var cir = new Circle(new Point3d(cx, cy, 0), Vector3d.ZAxis, r) { Layer = DL.Scheme };
                btr.AppendEntity(cir); tr.AddNewlyCreatedDBObject(cir, true);
            }
            catch
            {
                Rect(btr, tr, cx - r, cy - r, cx + r, cy + r, DL.Scheme, 3);
            }
            Line(btr, tr, cx - r * 0.7, cy, cx + r * 0.7, cy, DL.Scheme, 3);
            Line(btr, tr, cx, cy - r * 0.7, cx, cy + r * 0.7, DL.Scheme, 3);
            if (!string.IsNullOrEmpty(mark))
                Text(btr, tr, cx + r + 0.8, cy - 0.5, Math.Max(1.2, r * 0.9), mark, DL.Mark);
        }

        /// <summary>Модуль газовый — прямоугольник + баллон.</summary>
        public static void UgoModule(BlockTableRecord btr, Transaction tr, double x, double y, string mark)
        {
            try {
                if (UgoLib.TryInsert(btr, tr, btr.Database, UgoLib.ModuleNames, x + 4, y + 6, 0))
                {
                    if (!string.IsNullOrEmpty(mark))
                        Text(btr, tr, x, y + 16.5, 1.4, mark, DL.Mark);
                    return;
                }
            } catch { }

            // корпус
            Rect(btr, tr, x, y, x + 8, y + 12, DL.Eq, 1);
            // горловина
            Line(btr, tr, x + 2, y + 12, x + 2, y + 15, DL.Eq, 1);
            Line(btr, tr, x + 6, y + 12, x + 6, y + 15, DL.Eq, 1);
            Line(btr, tr, x + 2, y + 15, x + 6, y + 15, DL.Eq, 1);
            Text(btr, tr, x, y + 16.5, 1.4, mark ?? "МГП", DL.Mark);
        }

        /// <summary>Насадок — треугольник остриём вниз.</summary>
        public static void UgoNozzle(BlockTableRecord btr, Transaction tr, double cx, double cy, string mark)
        {
            try {
                if (UgoLib.TryInsert(btr, tr, btr.Database, UgoLib.NozzleNames, cx, cy, 0))
                {
                    if (!string.IsNullOrEmpty(mark))
                        Text(btr, tr, cx + 2.5, cy - 1, 1.3, mark, DL.Mark);
                    return;
                }
            } catch { }

            double s = 3.5;
            Line(btr, tr, cx, cy + s * 0.6, cx - s * 0.7, cy - s * 0.5, DL.Pipe, 1);
            Line(btr, tr, cx - s * 0.7, cy - s * 0.5, cx + s * 0.7, cy - s * 0.5, DL.Pipe, 1);
            Line(btr, tr, cx + s * 0.7, cy - s * 0.5, cx, cy + s * 0.6, DL.Pipe, 1);
            if (!string.IsNullOrEmpty(mark))
                Text(btr, tr, cx + 2.5, cy - 1, 1.3, mark, DL.Mark);
        }

        /// <summary>Световое табло (ОПОП) — прямоугольник с текстом.</summary>
        public static void UgoTablo(BlockTableRecord btr, Transaction tr, double x, double y, double w, double h, string text)
        {
            try {
                if (UgoLib.TryInsert(btr, tr, btr.Database, UgoLib.TabloNames, x + w/2, y + h/2, 0))
                {
                    if (!string.IsNullOrEmpty(text))
                        Text(btr, tr, x + 0.5, y - 2.5, 1.3, text, DL.Mark);
                    return;
                }
            } catch { }

            Rect(btr, tr, x, y, x + w, y + h, DL.Scheme, 3);
            // заливка-имитация: диагональ
            Line(btr, tr, x, y, x + w, y + h, DL.Scheme, 3);
            Text(btr, tr, x + 0.8, y + h * 0.25, Math.Min(1.5, h * 0.45), text ?? "", DL.Mark);
        }

        /// <summary>УДП — ромб.</summary>
        public static void UgoUdp(BlockTableRecord btr, Transaction tr, double cx, double cy, string mark)
        {
            try {
                if (UgoLib.TryInsert(btr, tr, btr.Database, UgoLib.UdpNames, cx, cy, 0))
                {
                    if (!string.IsNullOrEmpty(mark))
                        Text(btr, tr, cx + 3.5, cy - 0.5, 1.3, mark, DL.Mark);
                    return;
                }
            } catch { }

            double s = 3.0;
            Line(btr, tr, cx, cy + s, cx + s, cy, DL.Scheme, 3);
            Line(btr, tr, cx + s, cy, cx, cy - s, DL.Scheme, 3);
            Line(btr, tr, cx, cy - s, cx - s, cy, DL.Scheme, 3);
            Line(btr, tr, cx - s, cy, cx, cy + s, DL.Scheme, 3);
            Text(btr, tr, cx + s + 0.5, cy - 0.5, 1.3, mark ?? "УДП", DL.Mark);
        }

        /// <summary>МПТ — модуль ПТ (прибор) — квадрат с буквой.</summary>
        public static void UgoMpt(BlockTableRecord btr, Transaction tr, double x, double y, string mark)
        {
            try {
                if (UgoLib.TryInsert(btr, tr, btr.Database, UgoLib.MptNames, x + 5, y + 4, 0))
                {
                    if (!string.IsNullOrEmpty(mark))
                        Text(btr, tr, x, y + 9, 1.3, mark, DL.Mark);
                    return;
                }
            } catch { }

            Rect(btr, tr, x, y, x + 10, y + 8, DL.Eq, 1);
            Text(btr, tr, x + 1.5, y + 2.5, 1.8, "МПТ", DL.Mark);
            if (!string.IsNullOrEmpty(mark))
                Text(btr, tr, x, y + 9, 1.3, mark, DL.Mark);
        }

        /// <summary>Кабель АЛС — ломаная (условно штрих цветом слоя).</summary>
        public static void UgoCable(BlockTableRecord btr, Transaction tr, double x1, double y1, double x2, double y2)
        {
            Line(btr, tr, x1, y1, x2, y2, DL.Scheme, 3);
        }

    }

    // =========================================================================
    // Модель данных проекта (собирается с чертежа + расчёт)
    // =========================================================================
    public class ProjectData
    {
        public string Cipher = "АГПТ";
        public string ObjectName = "Объект не задан";
        public string ObjectShort = "Объект не задан";
        public string Stage = "РП";
        public string CityYear = "";
        public string Company = "";
        public string CompanyGsl = "";
        public string GenDesigner = "";
        public string VolumeTitle = "Автоматическое газовое пожаротушение";
        public string VolumeNo = "";
        public string Gip = "";
        public string Checked = "";
        public string Drawn = "";
        public string NormCtrl = "";
        public bool HasProjectSettings { get; set; }
        public PlanModel Plan { get; set; }
        public int AlbumSheetCount { get; set; } = 1;
        public List<string> AlbumSheetTitles { get; } = new List<string>();
        public List<ZoneCalc> Zones = new List<ZoneCalc>();
        public List<SpecRow> Spec = new List<SpecRow>();
        public List<CableRow> Cables = new List<CableRow>();
        public List<PipeSeg> Pipes = new List<PipeSeg>();
        public HydroSummary Hydro = new HydroSummary();
    }

    public class ZoneCalc
    {
        public string Name, Guid;
        public int PipeCount;
        public double Vp, H, Fh, Tm, Cn, Rho0, Vtr;
        public string Gotv = "HFC-227ea";
        public double Mp, Mg, Fc;
        public int ModuleVol;
        public int ModuleCountWork = 1, ModuleCountRes = 1;
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

    public class PipeSeg
    {
        public string Id, Type;
        public int Dy;
        public double L, Dp, POut, Npsh, DpHam;
        public bool Cav, Ham;
    }

    public class HydroSummary
    {
        public double TPod = 10, TZpu = 0.15, TCrit, DpTotal;
        public string HammerMode = "partial";
        public bool HasCav, HasHam;
    }

    // =========================================================================
    // Расчёт массы ГОТВ (СП 485 / эталон «Детский сад АГПТ»)
    // Mp = Vp·ρ1·(1+K2)·ln(100/(100−Cn))
    // K2 = Π·δ·tпод·√H ;  δ = FH/Vp ;  ρ1 = ρ0·(T0/Tм)·K3
    // Mg = K1·(Mp + Mтр)  → округление вверх до целых кг
    // =========================================================================
    public static class Calc
    {
        public const double PiLeak = 0.65;   // Π — параметр расположения проёмов
        public const double TPod = 10.0;     // с
        public const double T0 = 293.15;     // K (20 °C)
        public const double K3 = 1.0;        // коэффициент высоты (упрощ.)
        public const double K1 = 1.05;       // запас

        public static void Mass(ZoneCalc z)
        {
            if (z.Vp <= 0) z.Vp = 1;
            if (z.Cn <= 0 || z.Cn >= 100) z.Cn = 7.2;
            if (z.Rho0 <= 0) z.Rho0 = 7.28;
            if (z.H <= 0) z.H = 2.4;

            double TmK = z.Tm + 273.15;
            if (z.Tm < GasZoneInput.MinimumTemperatureC) TmK = 298.15;

            // ρ1 = ρ0 · (T0 / Tм) · K3
            double rho1 = z.Rho0 * (T0 / TmK) * K3;

            // δ = ΣFH / Vp
            double delta = z.Fh / z.Vp;

            // K2 = Π · δ · tпод · √H
            double k2 = PiLeak * delta * TPod * Math.Sqrt(z.H);

            // Mp = Vp · ρ1 · (1+K2) · ln(100/(100−Cn))
            z.Mp = z.Vp * rho1 * (1.0 + k2) * Math.Log(100.0 / (100.0 - z.Cn));

            // Масса остатка в трубопроводах Mтр = Vтр · ρ_GOTV
            // ρ жидкой фазы HFC-227ea ≈ 1400 кг/м³ (оценка); в эталоне Mтр ~0.001–0.002 кг при малых Vтр
            double rhoLiq = 1400.0;
            double mTr = z.Vtr * rhoLiq;
            // если Vтр задан как объём пара/смеси — в эталоне Mтр ≈ Vтр·ρ1·коэфф.; берём max
            mTr = Math.Max(mTr, z.Vtr * rho1 * 2.5);

            // Supplied reference equation has no additional K4 multiplier; pipe volume is derived from source geometry.
            double mgRaw = K1 * (z.Mp + mTr);
            z.Mg = Math.Ceiling(mgRaw);

            // КСИД (упрощённо): требуемая площадь сбросных устройств
            double vOut = 0.7 * Math.Sqrt(2.0 * 0.005 * 1e6 / 1.2);
            double fReq = 1.2 * z.Mp / (rho1 * TPod * Math.Max(vOut, 1.0));
            z.Fc = Math.Max(0, fReq - z.Fh);

            // Подбор модуля: Flamex 20 кг заправка (как в эталоне 66-40-33)
            // если Mg <= 20 → 40л / 20кг; иначе кратно
            double fillKg = 20.0;
            int need = Math.Max(1, (int)Math.Ceiling(z.Mg / fillKg));
            z.ModuleCountWork = need;
            z.ModuleCountRes = need; // 100% резерв по эталону
            z.ModuleVol = 40;        // типоразмер баллона
        }
    }

    // =========================================================================
    // Генераторы листов (всё — в Model Space как «поля» чертежа)
    // Листы раскладываются по оси X: лист N начинается с originX = N * pitch
    // =========================================================================
    public static class SheetGen
    {
        public static double Pitch = 500; // мм между листами (A3 420 + зазор; не сжимать)

        public static Point3d Origin(int sheetIndex) =>
            new Point3d(sheetIndex * Pitch, 0, 0);

        // ----- Лист: Общие данные (двухколоночный, как в альбоме Детский сад АГПТ) -----
        public static void GeneralData(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            if (pd.AlbumSheetTitles.Count == 0)
            {
                pd.AlbumSheetTitles.Add("Общие данные");
                pd.AlbumSheetCount = 1;
            }
            GeneralDataPage(ms, tr, pd, idx, 0);
        }

        static void GeneralDataPage(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx, int page)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Общие данные. Ведомость листов", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());
            Draw.Text(ms, tr, o.X + 25, o.Y + 280, 2.6, "Ведомость фактически сформированных листов", DL.Text);
            var slice = Pagination.Partition(pd.AlbumSheetTitles.Count, 32).ElementAt(page);
            var rows = pd.AlbumSheetTitles.Select((title, number) => new[] { (number + 1).ToString(), title })
                .Skip(slice.Start).Take(slice.Count).ToList();
            Draw.Table(ms, tr, o.X + 25, o.Y + 272, new[] { 16.0, 230.0 }, 5.2,
                new[] { "Лист", "Наименование" }, rows, DL.Table);
            Draw.MText(ms, tr, o.X + 280, o.Y + 275, 125, 2.3,
                "Объект: " + pd.ObjectName + "\nШифр: " + pd.Cipher +
                "\nЗон: " + pd.Zones.Count + "\nПозиций спецификации: " + pd.Spec.Count +
                "\nКабельных трасс: " + pd.Cables.Count +
                "\nКомплект формируется по данным текущей модели. Отсутствующие геометрия, реквизиты и количества требуют заполнения." +
                "\nПРОТОТИП — НЕ ДЛЯ ВЫПУСКА. Требуется проверка проектировщиком и в AutoCAD.", DL.Text);
        }

        // ----- Лист: Структурная схема + схема подключения -----
        public static void StructuralScheme(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Типовая структурная схема", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());

            // ---- Левая часть: структурная схема АУГП ----
            Draw.Text(ms, tr, o.X + 25, o.Y + 278, 2.3,
                "ТИПОВОЕ РЕШЕНИЕ. Адреса, связи и количества требуют задания и проверки по проекту.", DL.Text);
            double cx = o.X + 120, cy = o.Y + 195;

            void Box(double x, double y, double w, double h, string label, short col)
            {
                Draw.Rect(ms, tr, x - w / 2, y - h / 2, x + w / 2, y + h / 2, DL.Scheme, col);
                Draw.Text(ms, tr, x - w / 2 + 1.5, y - 1.2, 1.9, label, DL.Scheme);
            }
            void Arr(double x0, double y0, double x1, double y1)
            {
                Draw.Line(ms, tr, x0, y0, x1, y1, DL.Scheme, 3);
            }

            Draw.Text(ms, tr, o.X + 30, o.Y + 265, 2.6, "1. Структурная схема АУГП", DL.Text);

            Box(cx, cy + 45, 95, 16, "ППКУП / верхний уровень АПС", 3);
            Arr(cx, cy + 37, cx, cy + 28);
            Box(cx, cy + 20, 85, 14, "МПТ-1-R3 (ППУ АУГП)", 1);
            Arr(cx - 28, cy + 13, cx - 70, cy + 4);
            Arr(cx, cy + 13, cx, cy + 4);
            Arr(cx + 28, cy + 13, cx + 70, cy + 4);

            Box(cx - 70, cy - 4, 48, 12, "ИП ×2 (алг. C)", 3);
            Box(cx, cy - 4, 40, 12, "УДП", 3);
            Box(cx + 70, cy - 4, 55, 12, "Табло ОПОП ×3", 6);

            Arr(cx, cy - 10, cx, cy - 20);
            Box(cx - 35, cy - 28, 50, 12, "МГП рабочий", 1);
            Box(cx + 35, cy - 28, 50, 12, "МГП резерв", 8);
            Arr(cx - 35, cy - 34, cx - 35, cy - 42);
            Arr(cx + 35, cy - 34, cx - 35, cy - 42);
            Box(cx - 35, cy - 50, 75, 12, "Трубопровод → насадки", 5);

            // ---- Правая часть: схема подключения (клеммы / цепи) ----
            double rx = o.X + 250;
            Draw.Text(ms, tr, rx, o.Y + 265, 2.6, "2. Схема подключения оборудования", DL.Text);

            // Рамка таблицы клемм
            Draw.Rect(ms, tr, rx, o.Y + 80, rx + 145, o.Y + 255, DL.Scheme, 7);
            Draw.Text(ms, tr, rx + 4, o.Y + 245, 2.0, "МПТ-1-R3", DL.Text);
            Draw.Text(ms, tr, rx + 4, o.Y + 235, 1.7, "Цепь          Оборудование", DL.Text);
            Draw.Line(ms, tr, rx + 2, o.Y + 232, rx + 143, o.Y + 232, DL.Scheme);

            string[][] links = {
                new[] { "АЛС1", "ИП 212-64-R3 (1, 2)" },
                new[] { "АЛС1", "УДП 513-11-A-R3" },
                new[] { "АЛС1", "ОПОП «Газ уходи»" },
                new[] { "АЛС1", "ОПОП «Газ не входи»" },
                new[] { "АЛС1", "ОПОП «Автоматика откл.»" },
                new[] { "Выход 1", "ЗПУ модуля рабочего" },
                new[] { "Выход 2", "ЗПУ модуля резерва" },
                new[] { "Питание", "ИВЭПР 24/2.5 RS-R3" },
                new[] { "СДУ", "СДУ-М (давление)" },
            };
            double ly = o.Y + 220;
            foreach (var row in links)
            {
                Draw.Text(ms, tr, rx + 4, ly, 1.7, row[0], DL.Text);
                Draw.Text(ms, tr, rx + 40, ly, 1.7, row[1], DL.Text);
                ly -= 12;
            }

            // Таблица цепей (AcDbTable)
            double tx = o.X + 30, ty = o.Y + 100;
            var chainRows = new List<string[]>
            {
                new[] { "1", "АЛС1", "ИП 212-64-R3", "2", "алгоритм C" },
                new[] { "2", "АЛС1", "УДП 513-11-A-R3", "1", "ручной пуск" },
                new[] { "3", "АЛС1", "ОПОП «Газ! Уходи!»", "1", "" },
                new[] { "4", "АЛС1", "ОПОП «Газ! Не входи!»", "1", "" },
                new[] { "5", "АЛС1", "ОПОП «Автоматика откл.»", "1", "" },
                new[] { "6", "Выход 1", "ЗПУ модуля рабочего", "1", "ЭМУ QDQ 90N" },
                new[] { "7", "Выход 2", "ЗПУ модуля резерва", "1", "100% резерв" },
                new[] { "8", "Питание", "ИВЭПР 24/2.5 RS-R3", "1", "I кат." },
                new[] { "9", "СДУ", "СДУ-М", "1", "давление" },
            };
            Draw.Table(ms, tr, tx, ty, new[] { 12.0, 28.0, 70.0, 18.0, 40.0 }, 4.5,
                new[] { "№", "Цепь", "Оборудование", "Кол.", "Примечание" }, chainRows, DL.Table);

            Draw.Text(ms, tr, o.X + 30, o.Y + 42, 2.0,
                "Пуск: алгоритм C (2 ИП) → задержка ≥10 с → откл. вентиляции → ЗПУ → выпуск ≤10 с", DL.Text);
            Draw.Text(ms, tr, o.X + 30, o.Y + 32, 1.8,
                "Кабель: КПСнг(А)-FRLS 2×2×0,75. Питание I категория. Резерв модуля 100%.", DL.Text);
        }

        // ----- Лист: Аксонометрия (стиль эталона — 4 зоны, простые схемы с Ду/L) -----
        public static void Axonometry(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            for (int page = 0; page < PageCount(pd.Pipes.Count, 32); page++)
                PipePage(ms, tr, pd, idx + page, page);
        }

        static void PipePage(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx, int page)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Ведомость расчётных участков трубопроводов", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());
            Draw.Text(ms, tr, o.X + 25, o.Y + 280, 2.2,
                "Аксонометрия требует подтверждённой пространственной геометрии трасс.", DL.Text);
            var slice = Pagination.Partition(pd.Pipes.Count, 32).ElementAt(page);
            var rows = pd.Pipes.Skip(slice.Start).Take(slice.Count).Select(p => new[] {
                p.Id, p.Type, p.Dy.ToString(), NumericData.Format(p.L), NumericData.Format(p.Dp)
            }).ToList();
            if (rows.Count == 0)
                Draw.Text(ms, tr, o.X + 25, o.Y + 270, 2.5, "Расчётные трубопроводы не заданы.", DL.Text);
            else
                Draw.Table(ms, tr, o.X + 25, o.Y + 270, new[] { 35.0, 80.0, 35.0, 45.0, 45.0 }, 5,
                    new[] { "Участок", "Тип", "Ду, мм", "L, м", "ΔP, МПа" }, rows, DL.Table);
        }

        // ----- Лист: Спецификация -----
        public static void Specification(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            pd.AlbumSheetCount = PageCount(pd.Spec.Count, 32);
            for (int page = 0; page < pd.AlbumSheetCount; page++) SpecificationPage(ms, tr, pd, idx + page, page);
        }

        static void SpecificationPage(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx, int page)
        {
            var o = Origin(idx);
            var cipherSpec = (pd.Cipher ?? "АГПТ") + ".СО";
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H,
                cipherSpec, "Спецификация оборудования, изделий и материалов", (idx + 1).ToString(), pd.AlbumSheetCount.ToString(),
                pd.ObjectName, pd.Stage, pd.Company, pd.CompanyGsl, pd.CityYear,
                pd.Gip, pd.Checked, pd.Drawn, pd.NormCtrl);

            double x = o.X + DL.BindLeft + 3;
            double y = o.Y + DL.A3H - 14;
            Draw.Text(ms, tr, x, y, 2.8, "СПЕЦИФИКАЦИЯ (ГОСТ 21.110) — АГПТ", DL.Text);
            y -= 5;

            if (pd.Spec.Count == 0)
            {
                Draw.Text(ms, tr, x, y, 2.5,
                    "В модели нет учтённого оборудования и трасс. Образцовые количества не подставляются.", DL.Text);
                return;
            }
            var slice = Pagination.Partition(pd.Spec.Count, 32).ElementAt(page);
            var rows = pd.Spec.Skip(slice.Start).Take(slice.Count).Select(r => new[] {
                r.Pos.ToString(), r.Name, r.Mark, "", r.Unit,
                NumericData.Format(r.Qty), "", r.Note ?? ""
            }).ToList();
            Draw.Table(ms, tr, x, y,
                new[] { 10.0, 95.0, 40.0, 32.0, 12.0, 12.0, 14.0, 28.0 }, 4.8,
                new[] { "Поз.", "Наименование и техническая характеристика", "Тип, марка", "Код", "Ед.", "Кол.", "Масса", "Примечание" },
                rows, DL.Table);
        }

        // ----- Лист: Кабельный журнал -----
        public static void CableJournal(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            pd.AlbumSheetCount = PageCount(pd.Cables.Count, 32);
            for (int page = 0; page < pd.AlbumSheetCount; page++) CableJournalPage(ms, tr, pd, idx + page, page);
        }

        static void CableJournalPage(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx, int page)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Кабельный журнал АГПТ", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());

            double x = o.X + DL.BindLeft + 5;
            double y = o.Y + DL.A3H - 18;
            Draw.Text(ms, tr, x, y, 3.5, "КАБЕЛЬНЫЙ ЖУРНАЛ АГПТ (газ)", DL.Text);
            y -= 6;

            var slice = Pagination.Partition(pd.Cables.Count, 32).ElementAt(page);
            var rows = pd.Cables.Skip(slice.Start).Take(slice.Count).ToList();
            if (rows.Count == 0)
            {
                Draw.Text(ms, tr, x, y, 2.5,
                    "Кабельные трассы не заданы. Используйте AGPT_CABLE для разметки существующих линий.", DL.Text);
                return;
            }
            var data = rows.Select(r => new[] { r.From, r.To, r.Mark, r.Length.ToString("F1") }).ToList();
            Draw.Table(ms, tr, x, y, new[] { 55.0, 55.0, 70.0, 25.0 }, 5.5,
                new[] { "Начало", "Конец", "Марка кабеля", "L, м" }, data, DL.Table);
        }

        // ----- Титульный лист (обложка) -----
        /// <summary>
        /// Титул по эталону «Детский сад АГПТ»: стр.1 (обложка) или стр.2 (с подписями).
        /// idxEven: 0 = обложка, 1 = лист подписей.
        /// </summary>
        public static void TitleSheet(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            double left = o.X + DL.BindLeft;
            double bottom = o.Y + DL.Margin;
            double right = o.X + DL.A3W - DL.Margin;
            double top = o.Y + DL.A3H - DL.Margin;
            Draw.Rect(ms, tr, o.X, o.Y, o.X + DL.A3W, o.Y + DL.A3H, DL.Frame);
            Draw.Rect(ms, tr, left, bottom, right, top, DL.Frame);

            // --- Шапка (как в эталоне) ---
            Draw.Text(ms, tr, left + 8, top - 18, 4.0, "Республика Казахстан", DL.Text);
            Draw.Line(ms, tr, left + 8, top - 22, left + 160, top - 22, DL.Frame);

            Draw.Text(ms, tr, left + 8, top - 36, 2.3,
                "Генеральный проектировщик: " + (pd.GenDesigner ?? ""), DL.Text);
            Draw.Text(ms, tr, left + 8, top - 46, 2.3,
                "Проектировщик: " + (pd.Company ?? "") + " " + (pd.CompanyGsl ?? ""), DL.Text);

            string orderNo = "";
            if (!string.IsNullOrEmpty(pd.Cipher))
            {
                var parts = pd.Cipher.Split(new[] { '-' }, 3);
                if (parts.Length >= 2) orderNo = parts[0] + "-" + parts[1];
            }
            Draw.Text(ms, tr, left + 8, top - 56, 2.3, "Заказ: " + orderNo, DL.Text);

            // --- Центр: наименование объекта ---
            string obj = pd.ObjectName ?? pd.ObjectShort ?? "";
            Draw.MText(ms, tr, left + 40, o.Y + 210, 320, 3.2,
                "«" + obj + "»", DL.Text);

            // --- Блок «РАБОЧИЙ ПРОЕКТ» ---
            double midX = o.X + DL.A3W * 0.38;
            Draw.Text(ms, tr, midX, o.Y + 155, 5.5, "РАБОЧИЙ ПРОЕКТ", DL.Text);
            Draw.Text(ms, tr, midX + 10, o.Y + 138, 4.0, pd.Cipher ?? "", DL.Text);
            Draw.Text(ms, tr, midX + 25, o.Y + 122, 3.5, pd.VolumeNo ?? "", DL.Text);
            Draw.Text(ms, tr, midX - 30, o.Y + 105, 3.5,
                pd.VolumeTitle ?? "Автоматическое газовое пожаротушение", DL.Text);

            // Лист подписей (idx==1): два столбца как стр.2 эталона
            // На обложке (idx==0) — только город; на втором титуле — таблица подписей
            bool withSign = (idx % 10) == 1 || idx == 1;
            // FullAlbum передаёт 0 для первого титула; второй титул — отдельно
            if (withSign)
            {
                double y0 = o.Y + 85;
                // Левый столбец — генпроектировщик
                Draw.Text(ms, tr, left + 15, y0, 2.4, "Генеральный проектировщик", DL.Text);
                Draw.Text(ms, tr, left + 15, y0 - 12, 2.0, "", DL.Text);
                Draw.Text(ms, tr, left + 15, y0 - 28, 2.1, "Директор", DL.Text);
                Draw.Text(ms, tr, left + 70, y0 - 28, 2.1, "", DL.Text);
                Draw.Line(ms, tr, left + 55, y0 - 30, left + 68, y0 - 30, DL.Frame);
                Draw.Text(ms, tr, left + 15, y0 - 42, 2.1, "ГИП", DL.Text);
                Draw.Text(ms, tr, left + 70, y0 - 42, 2.1, "", DL.Text);
                Draw.Line(ms, tr, left + 55, y0 - 44, left + 68, y0 - 44, DL.Frame);

                // Правый столбец — проектировщик
                double rx = o.X + 230;
                Draw.Text(ms, tr, rx, y0, 2.4, "Проектировщик", DL.Text);
                Draw.Text(ms, tr, rx, y0 - 12, 2.0, pd.Company ?? "", DL.Text);
                Draw.Text(ms, tr, rx, y0 - 28, 2.1, "Директор", DL.Text);
                Draw.Text(ms, tr, rx + 55, y0 - 28, 2.1, "", DL.Text);
                Draw.Line(ms, tr, rx + 40, y0 - 30, rx + 53, y0 - 30, DL.Frame);
                Draw.Text(ms, tr, rx, y0 - 42, 2.1, "ГИП", DL.Text);
                Draw.Text(ms, tr, rx + 55, y0 - 42, 2.1, pd.Gip ?? "", DL.Text);
                Draw.Line(ms, tr, rx + 40, y0 - 44, rx + 53, y0 - 44, DL.Frame);
            }

            Draw.Text(ms, tr, o.X + 160, o.Y + 28, 3.0, pd.CityYear ?? "", DL.Text);
            Draw.Text(ms, tr, right - 55, bottom + 6, 1.8, "Формат А3", DL.Text);
        }

        /// <summary>Второй титульный лист (с подписями) — как стр.2 эталона.</summary>
        public static void TitleSheetSigned(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            TitleSheetSignedAt(ms, tr, pd, idx);
        }

        // ----- Лист расчёта по зонам (как стр.3 эталона, формат A3 упрощённо) -----
        public static void CalcSheet(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            pd.AlbumSheetCount = PageCount(pd.Zones.Count, 4);
            for (int page = 0; page < pd.AlbumSheetCount; page++) CalcPage(ms, tr, pd, idx + page, page);
        }

        static void CalcPage(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx, int page)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Расчет газового пожаротушения", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());

            var slice = Pagination.Partition(pd.Zones.Count, 4).ElementAt(page);
            var zones = pd.Zones.Skip(slice.Start).Take(slice.Count).ToList();
            int n = zones.Count;
            if (n == 0)
                Draw.Text(ms, tr, o.X + 25, o.Y + 275, 2.5, "Расчётные зоны не заданы. Добавьте зоны AGPT_ZONE.", DL.Text);

            // Рабочая область строго над штампом
            double xMin = o.X + DL.BindLeft + 4;
            double yMin = o.Y + DL.ContentBottom + 4;
            double yMax = o.Y + DL.ContentTop - 4;
            double workH = yMax - yMin;
            double workW = DL.A3W - DL.BindLeft - DL.Margin - 10;

            // 2×2 ячейки фиксированного размера — без пересечений
            double gap = 6;
            double cellW = (workW - gap) / 2.0;
            double cellH = (workH - gap) / 2.0;

            for (int i = 0; i < n; i++)
            {
                var z = zones[i];
                Calc.Mass(z);
                int col = i % 2;
                int row = i / 2;
                // row 0 = верх
                double x = xMin + col * (cellW + gap);
                double yTop = yMax - row * (cellH + gap);

                Draw.Text(ms, tr, x, yTop - 2, 2.2, (slice.Start + i + 1) + ". " + z.Name, DL.Text);
                double y = yTop - 6;

                // Компактные таблицы: 3.2 мм строка, укладываются в cellH
                var src = new List<string[]>
                {
                    new[] { "Vp, м³", z.Vp.ToString("F2") },
                    new[] { "H, м", z.H.ToString("F2") },
                    new[] { "FH", z.Fh.ToString("F3") },
                    new[] { "Tм", z.Tm.ToString("F0") },
                    new[] { "ГОТВ", z.Gotv ?? "" },
                    new[] { "Cn %", z.Cn.ToString("F1") },
                };
                double h1 = Draw.Table(ms, tr, x, y, new[] { 28.0, 48.0 }, 3.2,
                    new[] { "Парам.", "Знач." }, src, DL.Table);
                y -= h1 + 2.5;
                // не опускаться ниже низа ячейки
                double cellBottom = yTop - cellH + 2;
                if (y < cellBottom + 20) y = cellBottom + 22;

                var res = new List<string[]>
                {
                    new[] { "Mp кг", z.Mp.ToString("F2") },
                    new[] { "Mg кг", z.Mg.ToString("F0") },
                    new[] { "Модуль", z.ModuleVol + "л " + z.ModuleCountWork + "+" + z.ModuleCountRes },
                };
                Draw.Table(ms, tr, x, y, new[] { 28.0, 48.0 }, 3.2,
                    new[] { "Парам.", "Знач." }, res, DL.Table);
            }
            Draw.Text(ms, tr, xMin, yMin + 1, 1.5,
                "СП 485. Mg↑. Резерв 100%. Алгоритм C. Таблицы не пересекают штамп.", DL.Text);
        }

        // ----- Полный комплект (порядок как в альбоме Детский сад АГПТ) -----
        public static void FullAlbum(BlockTableRecord ms, Transaction tr, ProjectData pd)
        {
            if (!pd.HasProjectSettings) throw new InvalidOperationException("Сначала задайте реквизиты командой AGPT_PROJECT.");
            FrameBlock.ResetCache();
            FrameBlock.EnsureDefinition(ms.Database, tr);
            UgoLib.EnsureImported(ms.Database, tr);
            var pages = new List<Action<int>>();
            pd.AlbumSheetTitles.Clear();
            void Add(string title, Action<int> render)
            {
                pd.AlbumSheetTitles.Add(title);
                pages.Add(render);
            }
            Add("Титульный лист", i => TitleSheet(ms, tr, pd, i));
            Add("Титульный лист с подписями", i => TitleSheetSignedAt(ms, tr, pd, i));
            // The index includes its own continuation sheets; solve until the register fits.
            int generalPages = 1;
            int otherPages = 7 + PageCount(pd.Zones.Count, 4) + PageCount(pd.Spec.Count, 32)
                + PageCount(pd.Cables.Count, 32) + PageCount(pd.Pipes.Count, 32);
            while (PageCount(otherPages + generalPages, 32) > generalPages) generalPages++;
            for (int page = 0; page < generalPages; page++)
            {
                int p = page;
                Add("Общие данные. Ведомость листов" + Continuation(p), i => GeneralDataPage(ms, tr, pd, i, p));
            }
            Add("Краткое техническое описание модулей", i => ModuleDescription(ms, tr, pd, i));
            Add("Типовая структурная схема (проверить по проекту)", i => StructuralScheme(ms, tr, pd, i));
            Add("План оборудования и кабельных трасс АГПТ", i => PlanSheet(ms, tr, pd, i));
            Add("План оборудования и трубопроводов АГПТ", i => PlanModulesPipe(ms, tr, pd, i));
            for (int page = 0; page < PageCount(pd.Pipes.Count, 32); page++)
            {
                int p = page;
                Add("Ведомость расчётных участков трубопроводов" + Continuation(p), i => PipePage(ms, tr, pd, i, p));
            }
            for (int page = 0; page < PageCount(pd.Zones.Count, 4); page++)
            {
                int p = page;
                Add("Расчёт газового пожаротушения" + Continuation(p), i => CalcPage(ms, tr, pd, i, p));
            }
            Add("Типовая схема монтажа оборудования", i => MountingScheme(ms, tr, pd, i));
            for (int page = 0; page < PageCount(pd.Spec.Count, 32); page++)
            {
                int p = page;
                Add("Спецификация оборудования" + Continuation(p), i => SpecificationPage(ms, tr, pd, i, p));
            }
            for (int page = 0; page < PageCount(pd.Cables.Count, 32); page++)
            {
                int p = page;
                Add("Кабельный журнал АГПТ" + Continuation(p), i => CableJournalPage(ms, tr, pd, i, p));
            }
            pd.AlbumSheetCount = pages.Count;
            for (int i = 0; i < pages.Count; i++)
            {
                pages[i](i);
                var origin = Origin(i);
                Draw.Text(ms, tr, origin.X + 25, origin.Y + DL.A3H - 7, 1.8,
                    "ПРОТОТИП — НЕ ДЛЯ ВЫПУСКА", DL.Text);
            }
        }

        public static int PageCount(int itemCount, int capacity)
        {
            return Pagination.Partition(itemCount, capacity).Count();
        }

        static string Continuation(int page) => page == 0 ? "" : " (продолжение " + (page + 1) + ")";

        /// <summary>Краткое техническое описание модулей (эталон МГИМО л.6).</summary>
        public static void ModuleDescription(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Краткое техническое описание модулей МПТГ", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());
            double x = o.X + DL.BindLeft + 6;
            double y = o.Y + DL.ContentTop - 8;
            Draw.Text(ms, tr, x, y, 2.8, "Модуль газового пожаротушения (МПТГ)", DL.Text);
            y -= 8;
            string txt =
                "В проекте применяются модули газового пожаротушения (МПТГ) типа Flamex / Firex / Proffex " +
                "с огнетушащим веществом Хладон 227еа (HFC-227ea, C3F7H).\n\n" +
                "Основные характеристики (типовые):\n" +
                "• Рабочее давление — по паспорту модуля; выпуск ГОТВ ≤ 10 с.\n" +
                "• Комплект: баллон, ЗПУ (электромагнитный пуск), рукав РВД, СДУ, насадок.\n" +
                "• Резерв модулей — 100 % от расчётного количества (СП 485).\n" +
                "• Пуск — алгоритм C (два автоматических ИП в зоне).\n" +
                "• Задержка на эвакуацию ≥ 10 с до подачи ГОТВ.\n\n" +
                "Способ тушения — по объёму защищаемого помещения.\n" +
                "Трубопровод — сталь бесшовная Ду15…Ду32 (подбор по гидравлике).\n" +
                "Насадки — по паспорту производителя, ориентация по схеме монтажа.\n\n" +
                "Электропитание АГПТ — I категория (ПУЭ), кабель ВВГнг(А)-FRLS 3×2,5 от щита после АВР.\n" +
                "Линии АЛС/шлейфов — КПСнг(А)-FRLS 1×2×0,5; пусковые — 2×2×0,5.";
            Draw.MText(ms, tr, x, y, 380, 2.1, txt, DL.Text);

            // Таблица типоразмеров
            y = o.Y + 160;
            Draw.Text(ms, tr, x, y, 2.2, "Ориентировочные типоразмеры модулей", DL.Text);
            y -= 5;
            var rows = new List<string[]>
            {
                new[] { "Flamex 66-40-33", "20", "Хладон 227еа", "1+1" },
                new[] { "Firex 65-40-32", "32", "Хладон 227еа", "по расчёту" },
                new[] { "Proffex 65-**-**", "по паспорту", "Хладон 227еа", "по расчёту" },
            };
            Draw.Table(ms, tr, x, y, new[] { 55.0, 30.0, 50.0, 40.0 }, 5.0,
                new[] { "Марка", "V, л", "ГОТВ", "Кол. (раб+рез)" }, rows, DL.Table);
        }

        /// <summary>План: модули + трубопровод + интерфейс (эталон МГИМО л.9).</summary>
        public static void PlanModulesPipe(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "План оборудования и трубопроводов АГПТ", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());
            AGPT.Cad.ProjectPlanRenderer.Render(ms, tr, pd.Plan,
                o.X + DL.BindLeft + 5, o.Y + DL.ContentBottom + 5,
                DL.A3W - DL.BindLeft - DL.Margin - 10, DL.ContentTop - DL.ContentBottom - 15,
                "AGPT", showPipes: true, showCables: false);
        }

        public static void MountingScheme(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "Схема монтажа оборудования АГПТ на поверхности", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());
            double x = o.X + DL.BindLeft + 10;
            double y = o.Y + DL.ContentTop - 10;
            Draw.Text(ms, tr, x, y, 2.6, "Узлы монтажа", DL.Text);
            y -= 12;

            // Узел 1: насадок на потолке
            Draw.Text(ms, tr, x, y, 2.0, "1. Насадок на перекрытии / за фальшпотолком", DL.Text);
            y -= 6;
            Draw.Line(ms, tr, x, y, x + 80, y, DL.Pipe, 1); // труба
            Draw.UgoNozzle(ms, tr, x + 40, y - 2, "");
            Draw.Text(ms, tr, x + 50, y + 2, 1.5, "∅15 насадок", DL.Mark);
            Draw.Text(ms, tr, x + 5, y + 2, 1.5, "Ду20…25", DL.Mark);
            y -= 25;

            // Узел 2: модуль у стены
            Draw.Text(ms, tr, x, y, 2.0, "2. Модуль МГП у стены (крепление хомутами)", DL.Text);
            y -= 8;
            Draw.UgoModule(ms, tr, x + 10, y - 20, "МГП");
            Draw.Line(ms, tr, x + 18, y - 5, x + 18, y + 15, DL.Pipe, 1);
            Draw.Text(ms, tr, x + 30, y, 1.5, "РВД → трубопровод", DL.Mark);
            Draw.Text(ms, tr, x + 30, y - 8, 1.5, "СДУ на выходе", DL.Mark);
            y -= 40;

            // Узел 3: кабель
            Draw.Text(ms, tr, x, y, 2.0, "3. Прокладка кабеля", DL.Text);
            y -= 6;
            string cab =
                "• АЛС / шлейфы: КПСнг(А)-FRLS 1×2×0,5 в гофре d16 или кабель-канале.\n" +
                "• Пусковые линии: КПСнг(А)-FRLS 2×2×0,5.\n" +
                "• Питание: ВВГнг(А)-FRLS 3×2,5 от щита (I категория).\n" +
                "• Опуски к УДП, табло, ИП — в кабель-канале; отверстия — противопожарная пена.";
            Draw.MText(ms, tr, x, y, 380, 2.0, cab, DL.Text);
        }


        static void TitleSheetSignedAt(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            // Копия TitleSheet с подписями, но Origin(idx)
            var o = Origin(idx);
            double left = o.X + DL.BindLeft;
            double bottom = o.Y + DL.Margin;
            double right = o.X + DL.A3W - DL.Margin;
            double top = o.Y + DL.A3H - DL.Margin;
            Draw.Rect(ms, tr, o.X, o.Y, o.X + DL.A3W, o.Y + DL.A3H, DL.Frame);
            Draw.Rect(ms, tr, left, bottom, right, top, DL.Frame);

            Draw.Text(ms, tr, left + 8, top - 18, 4.0, "Республика Казахстан", DL.Text);
            Draw.Line(ms, tr, left + 8, top - 22, left + 160, top - 22, DL.Frame);
            Draw.Text(ms, tr, left + 8, top - 36, 2.3,
                "Генеральный проектировщик: " + (pd.GenDesigner ?? ""), DL.Text);
            Draw.Text(ms, tr, left + 8, top - 46, 2.3,
                "Проектировщик: " + (pd.Company ?? "") + " " + (pd.CompanyGsl ?? ""), DL.Text);
            string orderNo = "";
            if (!string.IsNullOrEmpty(pd.Cipher))
            {
                var parts = pd.Cipher.Split(new[] { '-' }, 3);
                if (parts.Length >= 2) orderNo = parts[0] + "-" + parts[1];
            }
            Draw.Text(ms, tr, left + 8, top - 56, 2.3, "Заказ: " + orderNo, DL.Text);

            Draw.MText(ms, tr, left + 40, o.Y + 210, 320, 3.2,
                "«" + (pd.ObjectName ?? "") + "»", DL.Text);
            double midX = o.X + DL.A3W * 0.38;
            Draw.Text(ms, tr, midX, o.Y + 155, 5.5, "РАБОЧИЙ ПРОЕКТ", DL.Text);
            Draw.Text(ms, tr, midX + 10, o.Y + 138, 4.0, pd.Cipher ?? "", DL.Text);
            Draw.Text(ms, tr, midX + 25, o.Y + 122, 3.5, pd.VolumeNo ?? "", DL.Text);
            Draw.Text(ms, tr, midX - 30, o.Y + 105, 3.5,
                pd.VolumeTitle ?? "Автоматическое газовое пожаротушение", DL.Text);

            double y0 = o.Y + 85;
            Draw.Text(ms, tr, left + 15, y0, 2.4, "Генеральный проектировщик", DL.Text);
            Draw.Text(ms, tr, left + 15, y0 - 12, 2.0, "", DL.Text);
            Draw.Text(ms, tr, left + 15, y0 - 28, 2.1, "Директор", DL.Text);
            Draw.Text(ms, tr, left + 70, y0 - 28, 2.1, "", DL.Text);
            Draw.Line(ms, tr, left + 55, y0 - 30, left + 68, y0 - 30, DL.Frame);
            Draw.Text(ms, tr, left + 15, y0 - 42, 2.1, "ГИП", DL.Text);
            Draw.Text(ms, tr, left + 70, y0 - 42, 2.1, "", DL.Text);
            Draw.Line(ms, tr, left + 55, y0 - 44, left + 68, y0 - 44, DL.Frame);

            double rx = o.X + 230;
            Draw.Text(ms, tr, rx, y0, 2.4, "Проектировщик", DL.Text);
            Draw.Text(ms, tr, rx, y0 - 12, 2.0, pd.Company ?? "", DL.Text);
            Draw.Text(ms, tr, rx, y0 - 28, 2.1, "Директор", DL.Text);
            Draw.Text(ms, tr, rx + 55, y0 - 28, 2.1, "", DL.Text);
            Draw.Line(ms, tr, rx + 40, y0 - 30, rx + 53, y0 - 30, DL.Frame);
            Draw.Text(ms, tr, rx, y0 - 42, 2.1, "ГИП", DL.Text);
            Draw.Text(ms, tr, rx + 55, y0 - 42, 2.1, pd.Gip ?? "", DL.Text);
            Draw.Line(ms, tr, rx + 40, y0 - 44, rx + 53, y0 - 44, DL.Frame);

            Draw.Text(ms, tr, o.X + 160, o.Y + 28, 3.0, pd.CityYear ?? "", DL.Text);
            Draw.Text(ms, tr, right - 55, bottom + 6, 1.8, "Формат А3", DL.Text);
        }

        /// <summary>План: фрагменты помещений по зонам (масштаб ~1:50).</summary>
        public static void PlanSheet(BlockTableRecord ms, Transaction tr, ProjectData pd, int idx)
        {
            var o = Origin(idx);
            Draw.SheetFrame(ms, tr, o.X, o.Y, DL.A3W, DL.A3H, pd,
                "План оборудования и кабельных трасс АГПТ", (idx + 1).ToString(), pd.AlbumSheetCount.ToString());
            AGPT.Cad.ProjectPlanRenderer.Render(ms, tr, pd.Plan,
                o.X + DL.BindLeft + 5, o.Y + DL.ContentBottom + 5,
                DL.A3W - DL.BindLeft - DL.Margin - 10, DL.ContentTop - DL.ContentBottom - 15,
                "AGPT", showPipes: false, showCables: true);
        }
    }

    public static class Collect
    {
        static double RequireDouble(Entity entity, string key)
        {
            try { return NumericData.ParseRequired(XD.Get(entity, key)); }
            catch (FormatException ex)
            {
                throw new InvalidOperationException("Зона " + entity.Handle + ": поле " + key
                    + " отсутствует или не является конечным числом. Повторите AGPT_ZONE.", ex);
            }
        }

        static void RequireZoneFields(Entity entity)
        {
            if (XD.Get(entity, "ROOM_CAPTURE") == "1" && XD.Get(entity, "ROOM_STATUS") != "READY")
                throw new InvalidOperationException("Помещение " + XD.Get(entity, "ZONE_NAME")
                    + ": контур сохранён, но исходные данные модели неполны: " + XD.Get(entity, "MISSING_FIELDS")
                    + ". Эти данные должны поступить из модели/профиля проекта; значения не подставляются.");
            string[] required = { "ZONE_NAME", "VP", "H", "FH", "TM", "CN", "RHO0", "GOTV" };
            var missing = required.Where(key => string.IsNullOrWhiteSpace(XD.Get(entity, key))).ToArray();
            if (missing.Length > 0)
                throw new InvalidOperationException("Зона " + entity.Handle + ": отсутствуют поля "
                    + string.Join(", ", missing) + ". Уточните исходные данные через AGPT_ZONE.");
        }

        static void ValidateZone(ZoneCalc zone, Entity entity)
        {
            var invalid = new GasZoneInput { Name = zone.Name, Gotv = zone.Gotv, Height = zone.H,
                OpeningsArea = zone.Fh, MinimumTemperature = zone.Tm,
                Concentration = zone.Cn, Density = zone.Rho0 }.Validate();
            if (!double.IsFinite(zone.Vp) || zone.Vp <= 0) invalid.Add("VP > 0");
            if (invalid.Count > 0)
                throw new InvalidOperationException("Зона " + entity.Handle + ": " + string.Join("; ", invalid)
                    + ". Повторите AGPT_ZONE и примените справочный профиль.");
        }

        public static ProjectData FromModel(Database db, Transaction tr)
        {
            var pd = new ProjectData { Plan = AGPT.Cad.PlanModelCapture.Read(db, tr, DL.App, DL.Zone) };
            pd.HasProjectSettings = AGPT.Cad.ProjectSettingsStore.TryRead(db, tr, "AGPT", out var saved);
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
            var bill = new BillOfMaterials();

            foreach (ObjectId id in ms)
            {
                var ent = tr.GetObject(id, OpenMode.ForRead) as Entity;
                if (ent == null || AGPT.Cad.AlbumOutput.IsGenerated(ent)) continue;
                string kind = XD.Get(ent, "KIND");
                string zoneName = XD.Get(ent, "ZONE_NAME");
                string volumeText = XD.Get(ent, "VP");
                bool isZone = ZoneIdentity.IsZone(kind, ent.Layer, DL.Zone, zoneName, volumeText);
                bool zoneCandidate = string.Equals(kind, "ZONE", StringComparison.Ordinal)
                    || (string.Equals(ent.Layer, DL.Zone, StringComparison.OrdinalIgnoreCase)
                        && string.IsNullOrWhiteSpace(kind));
                if (zoneCandidate) RequireZoneFields(ent);
                if (zoneCandidate && !isZone)
                    throw new InvalidOperationException("Некорректные данные зоны " + ent.Handle
                        + ": нужны непустое ZONE_NAME и положительный конечный VP в м³.");
                if (isZone)
                {
                    RequireZoneFields(ent);
                    var z = new ZoneCalc
                    {
                        Name = XD.Get(ent, "ZONE_NAME"),
                        Guid = XD.Get(ent, "GUID"),
                        Vp = RequireDouble(ent, "VP"),
                        H = RequireDouble(ent, "H"),
                        Fh = RequireDouble(ent, "FH"),
                        Tm = RequireDouble(ent, "TM"),
                        Cn = RequireDouble(ent, "CN"),
                        Rho0 = RequireDouble(ent, "RHO0"),
                        Gotv = XD.Get(ent, "GOTV")
                    };
                    ValidateZone(z, ent);
                    pd.Zones.Add(z);
                }
                if (!string.IsNullOrWhiteSpace(kind) && kind != "ZONE" && kind != "CABLE")
                {
                    string label;
                    switch (kind)
                    {
                        case "MODULE": label = "Модуль газового пожаротушения"; break;
                        case "NOZZLE": label = "Насадок"; break;
                        case "MPT": label = "Модуль управления пожаротушением"; break;
                        case "IP": label = "Извещатель пожарный"; break;
                        case "UDP": label = "Устройство дистанционного пуска"; break;
                        case "TABLO": label = "Табло"; break;
                        case "OPOP": label = "Оповещатель"; break;
                        case "KSID": label = "Клапан сброса избыточного давления"; break;
                        default: label = kind; break;
                    }
                    string note = XD.Get(ent, "ROLE") ?? "";
                    string code = XD.Get(ent, "CODE");
                    if (!string.IsNullOrWhiteSpace(code)) note += " Код: " + code;
                    bill.Add(label, XD.Get(ent, "MARK") ?? "Марка не задана", "шт.", 1, note);
                }
                if (kind == "CABLE")
                {
                    string from = XD.Get(ent, "FROM"), to = XD.Get(ent, "TO");
                    string mark = XD.Get(ent, "CABLE_MARK");
                    if (!AGPT.Stage3.DrawingUnits.TryGetMetresPerUnit(db, out double unitScale))
                        throw new InvalidOperationException(AGPT.Stage3.DrawingUnits.UnsupportedMessage);
                    string taggedUnits = XD.Get(ent, "PLAN_UNIT");
                    if (!string.Equals(taggedUnits, db.Insunits.ToString(), StringComparison.Ordinal))
                        throw new InvalidOperationException("Единицы кабельной трассы " + ent.Handle
                            + " изменились: проверьте геометрию и повторите AGPT_CABLE.");
                    if (!(ent is Curve cableCurve))
                        throw new InvalidOperationException("Кабельная трасса должна быть линией или полилинией.");
                    double length = PlanUnits.LengthInMetres(Math.Abs(
                        cableCurve.GetDistanceAtParameter(cableCurve.EndParam)
                        - cableCurve.GetDistanceAtParameter(cableCurve.StartParam)), unitScale);
                    if (string.IsNullOrWhiteSpace(from) || string.IsNullOrWhiteSpace(to)
                        || string.IsNullOrWhiteSpace(mark) || length <= 0)
                        throw new InvalidOperationException("Кабель " + ent.Handle + ": нужны FROM, TO, CABLE_MARK и положительная L в метрах.");
                    pd.Cables.Add(new CableRow { From = from, To = to, Mark = mark, Length = length });
                    bill.Add("Кабель", mark, "м", length);
                }
                // Generated album graphics have no segment metadata and are not source pipes.
                if (XD.Get(ent, "SEG_TYPE") != null)
                {
                    var pipe = new PipeSeg
                    {
                        Id = XD.Get(ent, "SEG_ID") ?? "E",
                        Type = XD.Get(ent, "SEG_TYPE") ?? "branch",
                        Dy = (int)XD.GetD(ent, "DY", 20),
                        L = ent is Curve sourcePipe && AGPT.Stage3.DrawingUnits.TryGetMetresPerUnit(db, out double pipeScale)
                            ? PlanUnits.LengthInMetres(Math.Abs(sourcePipe.GetDistanceAtParameter(sourcePipe.EndParam)
                                - sourcePipe.GetDistanceAtParameter(sourcePipe.StartParam)), pipeScale)
                            : throw new InvalidOperationException("Для трубы нужны геометрия Curve и определённые единицы."),
                        Dp = XD.GetD(ent, "DP"),
                        POut = XD.GetD(ent, "POUT"),
                        Npsh = XD.GetD(ent, "NPSH"),
                        Cav = XD.Get(ent, "CAVIT") == "1",
                        Ham = XD.Get(ent, "HAMMER") == "1"
                    };
                    if (pipe.L <= 0 || pipe.Dy <= 0)
                        throw new InvalidOperationException("Трубопровод " + ent.Handle + ": нужны положительные L (м) и DY (мм).");
                    pd.Pipes.Add(pipe);
                    bill.Add("Труба", "Ду" + pipe.Dy.ToString(), "м", pipe.L);
                }
            }
            var pipeVolumes = AGPT.Cad.CadGasPipeVolumes.Read(db, tr);
            foreach (var zone in pd.Zones)
            {
                if (string.IsNullOrWhiteSpace(zone.Guid) || !pipeVolumes.Volumes.ContainsKey(zone.Guid))
                    throw new InvalidOperationException("Зона без корректного GUID: повторите AGPT_ZONE.");
                zone.Vtr = pipeVolumes.Volumes[zone.Guid];
                zone.PipeCount = pipeVolumes.Counts[zone.Guid];
                Calc.Mass(zone);
                if (zone.PipeCount == 0) pd.Plan.Issues.Add("Зона " + zone.Name + ": учтено 0 участков трубопровода; Vтр=0. Модель сети ещё не подтверждена.");
            }
            int position = 1;
            foreach (var item in bill.Rows)
                pd.Spec.Add(new SpecRow { Pos = position++, Name = item.Name, Mark = item.Mark,
                    Unit = item.Unit, Qty = item.Quantity, Note = item.Note });
            // Hydro summary from first pipe TPOD
            if (pd.Pipes.Count > 0)
            {
                pd.Hydro.DpTotal = pd.Pipes.Sum(p => p.Dp);
                pd.Hydro.HasCav = pd.Pipes.Any(p => p.Cav);
                pd.Hydro.HasHam = pd.Pipes.Any(p => p.Ham);
            }
            return pd;
        }
    }

    // =========================================================================
    // КОМАНДЫ
    // =========================================================================

    /// <summary>
    /// Библиотека УГО: вставка именованных блоков из текущего чертежа
    /// или из blocks\ (экспорт из Садик.dwg / R-CAD).
    /// Имена: AGPT_UGO_IP, AGPT_UGO_MODULE, AGPT_UGO_MPT, AGPT_UGO_UDP, AGPT_UGO_TABLO, AGPT_UGO_NOZZLE
    /// Также пробуем RC-UGO-* если есть в чертеже.
    /// </summary>
    public static class UgoLib
    {
        // Имена из Садик.dwg (RubezhCAD) — список AGPT_UGO_LIST
        public static readonly string[] IpNames = {
            "RC-UGO-IRA-04", "RC-UGO-IRA-04_1", "RC-TSP-RUBEZH-R3-IP-1",
            "RC-UGO-IP12-03", "RC-UGO-IP12-03_1", "AGPT_UGO_IP", "ИП", "IP"
        };
        public static readonly string[] ModuleNames = {
            "RC-UGO-UNIT-01", "RC-TSP-RUBEZH-R3-AM1-1", "AGPT_UGO_MODULE", "AGPT_UGO_MGP", "МГП", "MODULE"
        };
        public static readonly string[] MptNames = {
            "RC-TSP-RUBEZH-R3-2OP-1", "RC-UGO-PPK-01", "RC-UGO-PPK-01_1",
            "RC-TSP-RUBEZH-R3-MDU1-1", "RC-UGO-MDU-02", "RC-UGO-MDU-02_1",
            "AGPT_UGO_MPT", "МПТ", "MPT"
        };
        public static readonly string[] UdpNames = {
            "RC-UGO-UDPD-01_1", "RC-UGO-UDPP-01_1", "AGPT_UGO_UDP", "УДП", "UDP"
        };
        public static readonly string[] TabloNames = {
            "RC-TSP-RUBEZH-R3-OPOP-1", "RC-UGO-OS-10", "RC-UGO-OS-01_1",
            "RC-UGO-OR-01", "RC-UGO-OK-12", "RC-UGO-OK-10_1", "RC-UGO-OK-01_1",
            "AGPT_UGO_TABLO", "ОПОП", "TABLO"
        };
        public static readonly string[] NozzleNames = {
            "RC-UGO-KLAP-04", "RC-UGO-KLAP-02_1", "AGPT_UGO_NOZZLE", "НАСАДОК", "NOZZLE"
        };
        public static readonly string[] PowerNames = {
            "RC-TSP-RUBEZH-IVEPR-1", "RC-UGO-BRP-01"
        };
        public static readonly string[] RmNames = {
            "RC-TSP-RUBEZH-R3-RM1-1", "RC-TSP-RUBEZH-R3-RM4K-1",
            "RC-UGO-RM-01_1", "RC-UGO-RM-05", "RC-UGO-RM-07"
        };

        /// <summary>Ключевые блоки для массового импорта из Садик.dwg</summary>
        public static readonly string[] ImportAllNames = {
            "RC-UGO-IRA-04", "RC-TSP-RUBEZH-R3-IP-1",
            "RC-TSP-RUBEZH-R3-OPOP-1", "RC-UGO-UDPD-01_1", "RC-UGO-UDPP-01_1",
            "RC-TSP-RUBEZH-R3-2OP-1", "RC-UGO-PPK-01", "RC-UGO-MDU-02",
            "RC-UGO-UNIT-01", "RC-TSP-RUBEZH-IVEPR-1",
            "RC-UGO-RM-05", "RC-TSP-RUBEZH-R3-IO-1"
        };

        public static ObjectId FindBlock(Transaction tr, Database db, string[] candidates)
        {
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            foreach (string name in candidates)
            {
                if (string.IsNullOrEmpty(name)) continue;
                if (bt.Has(name))
                    return bt[name];
            }
            // partial match
            foreach (ObjectId id in bt)
            {
                var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                if (btr.IsAnonymous || btr.IsLayout) continue;
                string n = btr.Name ?? "";
                foreach (string c in candidates)
                {
                    if (string.IsNullOrEmpty(c)) continue;
                    if (n.IndexOf(c, StringComparison.OrdinalIgnoreCase) >= 0)
                        return id;
                }
            }
            return ObjectId.Null;
        }

        public static bool TryInsert(BlockTableRecord ms, Transaction tr, Database db,
            string[] candidates, double x, double y, double scale = 1.0)
        {
            ObjectId defId = FindBlock(tr, db, candidates);
            if (defId == ObjectId.Null) return false;

            // Автомасштаб: R-CAD блоки часто 200–800 ед. → на плане нужно ~5–8 мм
            double sc = scale;
            if (sc <= 0 || Math.Abs(sc - 1.0) < 1e-9)
            {
                try
                {
                    var btrDef = (BlockTableRecord)tr.GetObject(defId, OpenMode.ForRead);
                    Extents3d? ext = null;
                    foreach (ObjectId eid in btrDef)
                    {
                        var ent = tr.GetObject(eid, OpenMode.ForRead) as Entity;
                        if (ent == null) continue;
                        try
                        {
                            var ee = ent.GeometricExtents;
                            if (ext == null) ext = ee;
                            else { var x2 = ext.Value; x2.AddExtents(ee); ext = x2; }
                        }
                        catch { }
                    }
                    if (ext.HasValue)
                    {
                        double bw = Math.Max(0.01, ext.Value.MaxPoint.X - ext.Value.MinPoint.X);
                        double bh = Math.Max(0.01, ext.Value.MaxPoint.Y - ext.Value.MinPoint.Y);
                        double maxDim = Math.Max(bw, bh);
                        // целевой размер на листе ~6 мм
                        sc = 6.0 / maxDim;
                        if (sc > 2.0) sc = 1.0; // уже мелкий блок
                        if (sc < 0.001) sc = 0.01;
                    }
                    else sc = 0.05; // типичный масштаб R-CAD мм→лист
                }
                catch { sc = 0.05; }
            }

            var br = new BlockReference(new Point3d(x, y, 0), defId);
            br.ScaleFactors = new Scale3d(sc, sc, 1);
            try { br.Layer = DL.Scheme; } catch { }
            ms.AppendEntity(br);
            tr.AddNewlyCreatedDBObject(br, true);
            return true;
        }

        /// <summary>Импорт ключевых RC-UGO из Садик_UGO_source.dwg, если ещё нет в чертеже.</summary>
        public static void EnsureImported(Database db, Transaction tr)
        {
            string path = ResourceLocator.FindBlockFile(
                Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                "Садик_UGO_source.dwg", "Садик.dwg");
            foreach (string c in new[] {
                @"c:\Work\AGPT_Plugin\blocks\Садик_UGO_source.dwg",
                @"C:\Work\AGPT_Plugin\blocks\Садик_UGO_source.dwg",
                @"c:\Work\AGPT_Plugin\blocks\Садик.dwg"
            })
            {
                if (path != null) break;
                if (System.IO.File.Exists(c)) { path = c; break; }
            }
            if (path == null) return;

            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            bool need = false;
            foreach (string nm in ImportAllNames)
            {
                if (!bt.Has(nm)) { need = true; break; }
            }
            if (!need) return;

            try
            {
                using (var src = new Database(false, true))
                {
                    src.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, "");
                    foreach (string blockName in ImportAllNames)
                    {
                        try
                        {
                            if (bt.Has(blockName)) continue;
                            ObjectId srcId = ObjectId.Null;
                            using (var trSrc = src.TransactionManager.StartTransaction())
                            {
                                var btSrc = (BlockTable)trSrc.GetObject(src.BlockTableId, OpenMode.ForRead);
                                if (!btSrc.Has(blockName)) { trSrc.Commit(); continue; }
                                srcId = btSrc[blockName];
                                trSrc.Commit();
                            }
                            var ids = new ObjectIdCollection();
                            ids.Add(srcId);
                            var map = new IdMapping();
                            src.WblockCloneObjects(ids, db.BlockTableId, map, DuplicateRecordCloning.Replace, false);
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        /// <summary>Список имён блоков в чертеже, похожих на УГО / R-CAD.</summary>
        public static System.Collections.Generic.List<string> ListUgoLike(Transaction tr, Database db)
        {
            var list = new System.Collections.Generic.List<string>();
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            foreach (ObjectId id in bt)
            {
                var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                if (btr.IsAnonymous || btr.IsLayout) continue;
                string n = btr.Name ?? "";
                string u = n.ToUpperInvariant();
                if (u.Contains("UGO") || u.Contains("RC-") || u.Contains("ИП") || u.Contains("IP")
                    || u.Contains("МПТ") || u.Contains("УДП") || u.Contains("ОПОП")
                    || u.Contains("МГП") || u.Contains("DIP") || u.Contains("R3")
                    || u.Contains("TABLO") || u.Contains("NOZZ"))
                    list.Add(n);
            }
            list.Sort();
            return list;
        }
    }

    public class AgptDrawingCommands
    {
        /// <summary>
        /// AGPT_FRAME — вставить блок рамки A3+штамп (из blocks\AGPT_Frame_A3.dxf/.dwg).
        /// Запрос точки вставки. Повторная вставка — тот же блок, со сдвигом вручную.
        /// </summary>
        /// <summary>
        /// AGPT_UGO_LIST — список блоков УГО/R-CAD в текущем чертеже.
        /// Откройте Садик.dwg и выполните эту команду, чтобы увидеть имена для WBLOCK.
        /// </summary>
        [CommandMethod("AGPT_UGO_LIST")]
        public void UgoList()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var ed = doc.Editor;
            try
            {
                using (doc.LockDocument())
                using (var tr = doc.Database.TransactionManager.StartTransaction())
                {
                    var list = UgoLib.ListUgoLike(tr, doc.Database);
                    ed.WriteMessage("\n[AGPT_UGO_LIST] Блоков, похожих на УГО/R-CAD: " + list.Count);
                    foreach (var n in list)
                        ed.WriteMessage("\n  " + n);
                    if (list.Count == 0)
                    {
                        ed.WriteMessage("\n  Откройте Садик.dwg (источник УГО) и повторите команду.");
                        ed.WriteMessage("\n  Либо: INSERT → обзор блоков чертежа.");
                        ed.WriteMessage("\n  Экспорт: _WBLOCK → блок → c:\\Work\\AGPT_Plugin\\blocks\\AGPT_UGO_IP.dwg");
                    }
                    tr.Commit();
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT_UGO_LIST] " + ex.Message);
            }
        }

        /// <summary>
        /// AGPT_UGO_IMPORT — подтянуть определение блока из внешнего DWG в текущий чертёж.
        /// Запрос: путь к DWG (по умолчанию blocks\\Садик_UGO_source.dwg) и имя блока.
        /// </summary>
        [CommandMethod("AGPT_UGO_IMPORT")]
        public void UgoImport()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                string defPath = ResourceLocator.FindBlockFile(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                    "Садик_UGO_source.dwg", "Садик.dwg")
                    ?? @"c:\Work\AGPT_Plugin\blocks\Садик_UGO_source.dwg";
                if (!System.IO.File.Exists(defPath))
                    defPath = @"c:\Work\AGPT_Plugin\blocks\Садик.dwg";
                var pso = new PromptStringOptions("\nПуть к DWG с УГО <" + defPath + ">: ");
                pso.AllowSpaces = true;
                var psr = ed.GetString(pso);
                string path = (psr.Status == PromptStatus.OK && !string.IsNullOrWhiteSpace(psr.StringResult))
                    ? psr.StringResult.Trim().Trim('"') : defPath;
                if (!System.IO.File.Exists(path))
                {
                    ed.WriteMessage("\n[AGPT_UGO_IMPORT] Файл не найден: " + path);
                    ed.WriteMessage("\n  Положите Садик.dwg в c:\\Work\\AGPT_Plugin\\blocks\\");
                    return;
                }

                var pso2 = new PromptStringOptions("\nИмя блока для импорта <RC-UGO-IRA-04>: ");
                pso2.AllowSpaces = true;
                var psr2 = ed.GetString(pso2);
                string blockName = (psr2.Status == PromptStatus.OK && !string.IsNullOrWhiteSpace(psr2.StringResult))
                    ? psr2.StringResult.Trim() : "RC-UGO-IRA-04";

                using (doc.LockDocument())
                using (var tr = db.TransactionManager.StartTransaction())
                using (var src = new Database(false, true))
                {
                    src.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, "");
                    ObjectId srcId = ObjectId.Null;
                    using (var trSrc = src.TransactionManager.StartTransaction())
                    {
                        var btSrc = (BlockTable)trSrc.GetObject(src.BlockTableId, OpenMode.ForRead);
                        if (!btSrc.Has(blockName))
                        {
                            ed.WriteMessage("\n[AGPT_UGO_IMPORT] Блок «" + blockName + "» не найден. Доступные (фрагмент):");
                            int n = 0;
                            foreach (ObjectId id in btSrc)
                            {
                                var btr = (BlockTableRecord)trSrc.GetObject(id, OpenMode.ForRead);
                                if (btr.IsAnonymous || btr.IsLayout) continue;
                                string nm = btr.Name ?? "";
                                if (nm.StartsWith("*")) continue;
                                ed.WriteMessage("\n  " + nm);
                                if (++n >= 40) { ed.WriteMessage("\n  ..."); break; }
                            }
                            trSrc.Commit();
                            tr.Abort();
                            return;
                        }
                        srcId = btSrc[blockName];
                        trSrc.Commit();
                    }

                    var ids = new ObjectIdCollection();
                    ids.Add(srcId);
                    var map = new IdMapping();
                    src.WblockCloneObjects(ids, db.BlockTableId, map, DuplicateRecordCloning.Replace, false);
                    tr.Commit();
                    ed.WriteMessage("\n[AGPT_UGO_IMPORT] Блок «" + blockName + "» импортирован. Вставка: INSERT или AGPT_SHEET_PLAN.");
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT_UGO_IMPORT] " + ex.Message);
            }
        }

                /// <summary>
        /// AGPT_UGO_IMPORT_ALL — импорт набора ключевых УГО из Садик.dwg (R-CAD).
        /// </summary>
        [CommandMethod("AGPT_UGO_IMPORT_ALL")]
        public void UgoImportAll()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                string path = ResourceLocator.FindBlockFile(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                    "Садик_UGO_source.dwg", "Садик.dwg")
                    ?? @"c:\Work\AGPT_Plugin\blocks\Садик_UGO_source.dwg";
                if (!System.IO.File.Exists(path))
                {
                    // если Садик открыт — можно клонировать из текущего? нет, нужен файл
                    ed.WriteMessage("\n[AGPT_UGO_IMPORT_ALL] Нет файла: " + path);
                    ed.WriteMessage("\n  Скопируйте Садик.dwg в blocks\\Садик_UGO_source.dwg");
                    ed.WriteMessage("\n  Или откройте Садик.dwg — блоки уже в чертеже, AGPT_SHEET_PLAN подхватит их.");
                    return;
                }
                int ok = 0, skip = 0, fail = 0;
                using (doc.LockDocument())
                using (var tr = db.TransactionManager.StartTransaction())
                using (var src = new Database(false, true))
                {
                    src.ReadDwgFile(path, FileOpenMode.OpenForReadAndAllShare, true, "");
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    foreach (string blockName in UgoLib.ImportAllNames)
                    {
                        try
                        {
                            ObjectId srcId = ObjectId.Null;
                            using (var trSrc = src.TransactionManager.StartTransaction())
                            {
                                var btSrc = (BlockTable)trSrc.GetObject(src.BlockTableId, OpenMode.ForRead);
                                if (!btSrc.Has(blockName)) { skip++; trSrc.Commit(); continue; }
                                srcId = btSrc[blockName];
                                trSrc.Commit();
                            }
                            if (bt.Has(blockName)) { skip++; continue; }
                            var ids = new ObjectIdCollection();
                            ids.Add(srcId);
                            var map = new IdMapping();
                            src.WblockCloneObjects(ids, db.BlockTableId, map, DuplicateRecordCloning.Replace, false);
                            ok++;
                            ed.WriteMessage("\n  + " + blockName);
                        }
                        catch
                        {
                            fail++;
                            ed.WriteMessage("\n  ! " + blockName);
                        }
                    }
                    tr.Commit();
                }
                ed.WriteMessage("\n[AGPT_UGO_IMPORT_ALL] импорт=" + ok + " пропуск=" + skip + " ошибка=" + fail);
                ed.WriteMessage("\n  Далее: AGPT_SHEET_PLAN или AGPT_ALBUM");
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT_UGO_IMPORT_ALL] " + ex.Message);
            }
        }

        [CommandMethod("AGPT_FRAME")]
        public void InsertFrame()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                FrameBlock.ResetCache();
                string path = FrameBlock.FindPath();
                if (path != null)
                    ed.WriteMessage("\n[AGPT_FRAME] Файл: " + path);
                else
                    ed.WriteMessage("\n[AGPT_FRAME] DXF/DWG не найден — программный блок рамки.");

                var ppo = new PromptPointOptions("\nТочка вставки рамки (левый нижний угол) <0,0>: ");
                ppo.AllowNone = true;
                var ppr = ed.GetPoint(ppo);
                Point3d pt = Point3d.Origin;
                if (ppr.Status == PromptStatus.OK)
                    pt = ppr.Value;
                else if (ppr.Status != PromptStatus.None)
                    return;

                using (doc.LockDocument())
                using (var tr = db.TransactionManager.StartTransaction())
                {
                    ObjectId defId = FrameBlock.EnsureDefinition(db, tr);
                    if (defId == ObjectId.Null)
                    {
                        ed.WriteMessage("\n[AGPT_FRAME] Не удалось загрузить определение блока.");
                        tr.Abort();
                        return;
                    }

                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);

                    var br = FrameBlock.CreateReference(tr, defId, pt);
                    try { br.Layer = DL.Frame; } catch { }
                    ms.AppendEntity(br);
                    tr.AddNewlyCreatedDBObject(br, true);

                    // Опционально — подпись шифра/листа
                    var pso = new PromptStringOptions("\nНаименование листа <Общие данные>: ");
                    pso.AllowSpaces = true;
                    var psr = ed.GetString(pso);
                    string title = (psr.Status == PromptStatus.OK && !string.IsNullOrWhiteSpace(psr.StringResult))
                        ? psr.StringResult.Trim() : "Общие данные";

                    var pso2 = new PromptStringOptions("\nНомер листа <1>: ");
                    pso2.AllowSpaces = false;
                    var psr2 = ed.GetString(pso2);
                    string sheetNo = (psr2.Status == PromptStatus.OK && !string.IsNullOrWhiteSpace(psr2.StringResult))
                        ? psr2.StringResult.Trim() : "1";

                    // Текст поверх штампа блока
                    double right = pt.X + DL.A3W - DL.Margin;
                    double bottom = pt.Y + DL.Margin;
                    Draw.Text(ms, tr, right - 183, bottom + 45, 2.4, title, DL.Text);
                    Draw.Text(ms, tr, right - 117, bottom + 4, 2.2, sheetNo, DL.Text);

                    tr.Commit();
                    ed.WriteMessage("\n[AGPT_FRAME] Блок " + FrameBlock.BlockName + " вставлен в " +
                        string.Format("({0:F0},{1:F0})", pt.X, pt.Y));
                    ed.WriteMessage("\n  Шаг следующего листа ≈ " + SheetGen.Pitch.ToString("F0") + " мм по X.  Масштаб блока=" + FrameBlock.InsertScale.ToString("0.####"));
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT_FRAME] Ошибка: " + ex.Message);
            }
        }

        /// <summary>AGPT_FRAME_LOAD — только загрузить определение блока рамки в чертёж (без вставки).</summary>
        [CommandMethod("AGPT_FRAME_LOAD")]
        public void LoadFrameDef()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                FrameBlock.ResetCache();
                string path = FrameBlock.FindPath();
                ed.WriteMessage("\n[AGPT_FRAME_LOAD] Поиск: " + (path ?? "(не найден)"));
                // path optional — EnsureDefinition builds programmatic frame
                using (doc.LockDocument())
                using (var tr = db.TransactionManager.StartTransaction())
                {
                    var id = FrameBlock.EnsureDefinition(db, tr);
                    tr.Commit();
                    if (id == ObjectId.Null)
                        ed.WriteMessage("\n[AGPT_FRAME_LOAD] Ошибка загрузки.");
                    else
                        ed.WriteMessage("\n[AGPT_FRAME_LOAD] Блок " + FrameBlock.BlockName +
                            " загружен. Вставка: INSERT или AGPT_FRAME. Ширина=" +
                            FrameBlock.FrameWidth.ToString("F0") + " мм.");
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT_FRAME_LOAD] " + ex.Message);
            }
        }

        /// <summary>AGPT_SHEET_OD — лист «Общие данные + расчёт» в модели</summary>
        [CommandMethod("AGPT_SHEET_OD")]
        public void SheetOd()
        {
            RunSheet((ms, tr, pd) => SheetGen.GeneralData(ms, tr, pd, 0));
        }

        /// <summary>AGPT_SHEET_SS — структурная схема</summary>
        [CommandMethod("AGPT_SHEET_SS")]
        public void SheetSs()
        {
            RunSheet((ms, tr, pd) => SheetGen.StructuralScheme(ms, tr, pd, 0));
        }

        /// <summary>AGPT_SHEET_AXO — аксонометрия + таблица гидравлики</summary>
        [CommandMethod("AGPT_SHEET_AXO")]
        public void SheetAxo()
        {
            RunSheet((ms, tr, pd) => SheetGen.Axonometry(ms, tr, pd, 0));
        }

        /// <summary>AGPT_SHEET_SPEC — спецификация как чертёж</summary>
        [CommandMethod("AGPT_SHEET_SPEC")]
        public void SheetSpec()
        {
            RunSheet((ms, tr, pd) => SheetGen.Specification(ms, tr, pd, 0));
        }

        /// <summary>AGPT_SHEET_KZH — кабельный журнал как чертёж</summary>
        [CommandMethod("AGPT_SHEET_KZH")]
        public void SheetKzh()
        {
            RunSheet((ms, tr, pd) => SheetGen.CableJournal(ms, tr, pd, 0));
        }

        /// <summary>AGPT_SHEET_PLAN — план с УГО и расстановкой оборудования</summary>
        [CommandMethod("AGPT_SHEET_PLAN")]
        public void SheetPlan()
        {
            RunSheet((ms, tr, pd) => SheetGen.PlanSheet(ms, tr, pd, 0));
        }

        /// <summary>AGPT_ALBUM — полный комплект по размеченным контурам AGPT_ZONE.</summary>
        [CommandMethod("AGPT_ALBUM")]
        public void Album()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database;
            var ed = doc.Editor;
            try
            {
                ProjectData pd;
                using (var tr = db.TransactionManager.StartTransaction())
                {
                    pd = Collect.FromModel(db, tr);
                    tr.Commit();
                }

                if (!pd.HasProjectSettings)
                    throw new InvalidOperationException("Сначала задайте реквизиты командой AGPT_PROJECT.");

                if (pd.Zones.Count == 0)
                    ed.WriteMessage("\nРасчётные зоны отсутствуют. Для расчётов и планов отметьте существующие контуры командой AGPT_ZONE. "
                        + "Скрытые параметры и помещения не подставляются.");

                using (var tr = db.TransactionManager.StartTransaction())
                {
                    XD.EnsureApp(db, tr);
                    Layers.EnsureAll(db, tr);
                    Draw.EnsureTextStyle(db, tr);
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var ms = (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], OpenMode.ForWrite);

                    AGPT.Cad.AlbumOutput.Replace(ms, tr, "AGPT", () => SheetGen.FullAlbum(ms, tr, pd));
                    tr.Commit();
                    ed.WriteMessage("\n[AGPT_ALBUM] Альбом построен по оси X (шаг 500 мм). ZOOM → E");
                    ed.WriteMessage("\nСформировано листов: " + pd.AlbumSheetCount + ". Состав и номера — в ведомости общих данных.");
                    ed.WriteMessage(string.Format("\nЗон в расчёте: {0}", pd.Zones.Count));
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT_ALBUM] Ошибка: " + ex.Message);
            }
        }

        /// <summary>AGPT_CALC_DRAW — пересчитать зоны и обновить лист общих данных</summary>
        [CommandMethod("AGPT_CALC_DRAW")]
        public void CalcDraw()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            var db = doc.Database; var ed = doc.Editor;
            using (var tr = db.TransactionManager.StartTransaction())
            {
                XD.EnsureApp(db, tr);
                var pd = Collect.FromModel(db, tr);
                foreach (var z in pd.Zones)
                {
                    Calc.Mass(z);
                    ed.WriteMessage($"\n[{z.Name}] Vp={z.Vp:F1} Mg={z.Mg:F2} кг модуль {z.ModuleVol}л Fc={z.Fc:F4}");
                }
                tr.Commit();
            }
            // Перестроить лист OD в начале координат
            RunSheet((ms, tr, pd) => SheetGen.GeneralData(ms, tr, pd, 0));
        }

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
                    build(ms, tr, pd);
                    tr.Commit();
                    ed.WriteMessage("\n[AGPT] Лист сформирован в пространстве модели (чертёж).");
                }
            }
            catch (System.Exception ex)
            {
                ed.WriteMessage("\n[AGPT] Ошибка: " + ex.Message);
            }
        }
    }
}
