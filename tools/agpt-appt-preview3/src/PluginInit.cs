// =============================================================================
// AGPT/APPT Plugin v1.0 — точка входа (IExtensionApplication)
// =============================================================================

using System;
using System.Diagnostics;
using Autodesk.AutoCAD.Runtime;
using Autodesk.AutoCAD.ApplicationServices;
using AcadApp = Autodesk.AutoCAD.ApplicationServices.Application;

[assembly: ExtensionApplication(typeof(AGPT.PluginInit))]
[assembly: CommandClass(typeof(AGPT.PluginInit))]

namespace AGPT
{
    public class PluginInit : IExtensionApplication
    {
        public const string Version = "1.1.0-preview.6";

        public void Initialize()
        {
            try
            {
                var doc = AcadApp.DocumentManager.MdiActiveDocument;
                var ed = doc?.Editor;
                if (ed != null)
                {
                    ed.WriteMessage("\n*** AGPT/APPT v" + Version + " INITIALIZED ***");
                    ed.WriteMessage("\nПРОТОТИП: расчёты и альбом требуют проверки до проектного выпуска.");
                    ed.WriteMessage("\n  AGPT_PROJECT / APPT_PROJECT — реквизиты текущего проекта");
                    ed.WriteMessage("\n  --- АГПТ (газ) ---");
                    ed.WriteMessage("\n  AGPT_ALBUM  AGPT_ZONE  AGPT_MODULE  AGPT_PIPE  AGPT_CALC");
                    ed.WriteMessage("\n  AGPT_CABLE — учёт кабельной трассы по существующей линии");
                    ed.WriteMessage("\n  AGPT_HYDRO2  AGPT_AXO2  AGPT_PIPE_DATA");
                    ed.WriteMessage("\n  AGPT_FRAME  AGPT_FRAME_LOAD  — рамка A3+штамп (блок)");
                    ed.WriteMessage("\n  AGPT_UGO_LIST  AGPT_UGO_IMPORT  AGPT_UGO_IMPORT_ALL  — УГО R-CAD");
                    ed.WriteMessage("\n  --- АППТ (порошок) ---");
                    ed.WriteMessage("\n  APPT_ALBUM  APPT_ZONE  APPT_CALC  APPT_DEVICE  APPT_CABLE");
                    ed.WriteMessage("\n  APPT_SHEET_OD  APPT_SHEET_CALC  APPT_SHEET_SPEC");
                    ed.WriteMessage("\n");
                }
                else Trace.WriteLine("AGPT/APPT initialized without an active document.");
            }
            catch (System.Exception ex)
            {
                Trace.TraceError("AGPT/APPT initialization logging failed: {0}", ex.GetType().Name);
            }
        }

        [CommandMethod("AGPT_VERSION")]
        public void ShowVersion()
        {
            AcadApp.DocumentManager.MdiActiveDocument?.Editor.WriteMessage(
                "\nAGPT/APPT " + Version + "\nDLL: " + typeof(PluginInit).Assembly.Location);
        }

        public void Terminate() { }
    }
}
