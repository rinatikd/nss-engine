using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;

namespace NssEngine.Export;

public sealed class PreviewCommands
{
    private const string LayerPrefix = "NSS_PREVIEW_V031_";
    private const int MaxFileBytes = 8_000_000;
    private const int MaxPoints = 20_000;

    private sealed record PreviewRoute(string Name, List<Point2d> Points);

    private static List<PreviewRouteV042> Parse(string path,string currentDrawing)
    {
        var info=new FileInfo(path);
        if(!info.Exists||info.Length>MaxFileBytes)throw new InvalidDataException("Preview file missing or too large");
        return PreviewContractV042.Parse(File.ReadAllText(path),currentDrawing);
    }

#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_PREVIEW_V031", CommandFlags.Modal)]
#endif
    public void Preview()=>ObservabilityV036.Run("NSS_PREVIEW_V031",PreviewCore);
    private void PreviewCore()
    {
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var ed = doc.Editor;
        var file = ed.GetString(new PromptStringOptions("\nFull path to NSS v0.31 preview JSON: ") { AllowSpaces = true });
        if (file.Status != PromptStatus.OK) return;
        try
        {
            var routes = Parse(file.StringResult.Trim('"'), doc.Name);
            ed.WriteMessage($"\nValidated {routes.Count} routes. Units are UNVERIFIED; preview is not an approved design.");
            var confirm = ed.GetKeywords(new PromptKeywordOptions("\nCreate preview geometry? [Yes/No] ", "Yes No") { AllowNone = false });
            if (confirm.Status != PromptStatus.OK || confirm.StringResult != "Yes") return;
            PreviewServiceV042.Apply(doc.Database,routes,true);
            ed.WriteMessage($"\nCreated {routes.Count} preview polylines on non-plot NSS layers. Original geometry untouched.");
        }
        catch (System.Exception) { throw; }
    }

#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_CLEAR_PREVIEW_V031", CommandFlags.Modal)]
#endif
    public void ClearPreview()=>ObservabilityV036.Run("NSS_CLEAR_PREVIEW_V031",ClearCore);
    private void ClearCore()
    {
        var doc = Application.DocumentManager.MdiActiveDocument;
        if (doc == null) return;
        var ed = doc.Editor;
        var confirm = ed.GetKeywords(new PromptKeywordOptions("\nErase only NSS-owned preview polylines? [Yes/No] ", "Yes No") { AllowNone = false });
        if (confirm.Status != PromptStatus.OK || confirm.StringResult != "Yes") return;
        int removed=PreviewServiceV042.Clear(doc.Database,true);
        ed.WriteMessage($"\nErased {removed} NSS preview polylines.");
    }
}
