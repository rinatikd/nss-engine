using System;
using AGPT.Shared;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;

[assembly: CommandClass(typeof(AGPT.Cad.GasPipeDataCommands))]

namespace AGPT.Cad
{
    public class GasPipeDataCommands
    {
        [CommandMethod("AGPT_PIPE_DATA")]
        public void ConfigurePipe()
        {
            var doc = Application.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var db = doc.Database; var editor = doc.Editor;
            var pipeSelection = editor.GetEntity("\nВыберите исходный участок AGPT_PIPE: ");
            if (pipeSelection.Status != PromptStatus.OK) return;
            var zoneOptions = new PromptEntityOptions("\nВыберите исходный контур защищаемой зоны: ");
            zoneOptions.SetRejectMessage("\nТребуется замкнутая Polyline зоны AGPT_ZONE.");
            zoneOptions.AddAllowedClass(typeof(Polyline), true);
            var zoneSelection = editor.GetEntity(zoneOptions);
            if (zoneSelection.Status != PromptStatus.OK) return;
            try
            {
                using var tr = db.TransactionManager.StartTransaction();
                var pipe = tr.GetObject(pipeSelection.ObjectId, OpenMode.ForRead) as Entity;
                if (pipe is not Curve || !CadGasPipeVolumes.IsSourcePipe(pipe))
                    throw new InvalidOperationException("Выберите исходный размеченный участок AGPT_PIPE.");
                AGPT.ProjectCommands.RequireTaggable(pipe, "AGPT", "PIPE");
                if (string.IsNullOrWhiteSpace(AGPT.Stage3.XD.Get(pipe, "SEG_ID"))
                    || string.IsNullOrWhiteSpace(AGPT.Stage3.XD.Get(pipe, "SEG_TYPE")))
                    throw CadGasPipeVolumes.PipeError(pipe, "отсутствуют исходные SEG_ID/SEG_TYPE; создайте участок AGPT_PIPE");
                var zones = CadGasPipeVolumes.ReadZones(db, tr);
                var zoneEntity = (Entity)tr.GetObject(zoneSelection.ObjectId, OpenMode.ForRead);
                string zone = AGPT.Stage3.XD.Get(zoneEntity, "GUID");
                if (string.IsNullOrWhiteSpace(zone) || !zones.TryGetValue(zone, out ObjectId zoneId) || zoneId != zoneSelection.ObjectId)
                    throw new InvalidOperationException("Выберите уникальный исходный контур AGPT_ZONE.");
                double nominal = CadGasPipeVolumes.ReadPositive(pipe, "DY");
                if (!AGPT.Stage3.DrawingUnits.TryGetMetresPerUnit(db, out double scale))
                    throw new InvalidOperationException(AGPT.Stage3.DrawingUnits.UnsupportedMessage);
                // Validate current geometry before accepting engineering properties.
                double nativeLength = Math.Abs(((Curve)pipe).GetDistanceAtParameter(((Curve)pipe).EndParam)
                    - ((Curve)pipe).GetDistanceAtParameter(((Curve)pipe).StartParam));
                double length = PlanUnits.LengthInMetres(nativeLength, scale);
                if (!double.IsFinite(length) || length <= 0) throw CadGasPipeVolumes.PipeError(pipe, "некорректная фактическая длина");
                var diameterOptions = new PromptDoubleOptions("\nФактический внутренний диаметр по спецификации трубы, мм (не Ду): ")
                { AllowNegative = false, AllowZero = false, UseDefaultValue = false };
                var diameter = editor.GetDouble(diameterOptions);
                if (diameter.Status != PromptStatus.OK) return;
                if (!double.IsFinite(diameter.Value) || diameter.Value <= 0)
                    throw CadGasPipeVolumes.PipeError(pipe, "нужен положительный конечный внутренний диаметр");
                _ = PipeVolumeCalculator.Compute(length, diameter.Value);
                pipe.UpgradeOpen();
                AGPT.Stage3.XD.EnsureApp(db, tr);
                AGPT.Stage3.XD.Set(pipe, ("ZONE_GUID", zone),
                    ("INNER_D_MM", NumericData.Format(diameter.Value)), ("INNER_D_FOR_DY", NumericData.Format(nominal)),
                    ("PLAN_UNIT", db.Insunits.ToString()), ("METRES_PER_UNIT", NumericData.Format(scale)));
                tr.Commit();
                editor.WriteMessage("\n[AGPT_PIPE_DATA] Свойства трубы сохранены. Vтр рассчитывается из внутреннего диаметра и фактической длины.");
            }
            catch (System.Exception ex) { editor.WriteMessage("\n[AGPT_PIPE_DATA] " + ex.Message); }
        }
    }
}
