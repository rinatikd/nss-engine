using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

/// <summary>Standalone CCTV analysis launcher. It reads source files and writes a new DXF;</summary>
/// <summary>it never opens or edits the current drawing database.</summary>
public sealed class CctvCommands
{
    static readonly string Root=Directory.GetParent(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!)!.FullName;

    [CommandMethod("NSS_CCTV_ANALYZE", CommandFlags.Modal|CommandFlags.NoUndoMarker)]
    public void Analyze()
    {
        var doc=AcApp.DocumentManager.MdiActiveDocument;
        if(doc==null)return;
        Editor ed=doc.Editor;
        try
        {
            string module=Path.Combine(Root,"modules","cctv");
            string script=Path.Combine(module,"cctv_cli.py");
            string python=Path.Combine(Root,"runtime","python.exe");
            if(!File.Exists(script)||!File.Exists(python))
                throw new FileNotFoundException("CCTV module or packaged Python runtime is missing. Expected: "+module);

            string? plan=Pick(ed,"Architectural plan DXF","DXF files (*.dxf)|*.dxf|All files (*.*)|*.*");if(plan==null)return;
            string? cameras=Pick(ed,"Camera placement CSV","CSV files (*.csv)|*.csv|All files (*.*)|*.*");if(cameras==null)return;
            string output=Path.Combine(Path.GetDirectoryName(plan)!,Path.GetFileNameWithoutExtension(plan)+"_CCTV_result.dxf");
            if(File.Exists(output))
            {
                var overwriteOptions=new PromptKeywordOptions("\nOutput already exists. [Overwrite/Cancel] <Cancel>: "){AllowNone=true};
                overwriteOptions.Keywords.Add("Overwrite");overwriteOptions.Keywords.Add("Cancel");overwriteOptions.Keywords.Default="Cancel";
                var overwrite=ed.GetKeywords(overwriteOptions);
                if(overwrite.Status!=PromptStatus.OK||!overwrite.StringResult.Equals("Overwrite",StringComparison.OrdinalIgnoreCase))return;
            }
            var daysOptions=new PromptIntegerOptions("\nArchive retention days <30>: "){AllowNone=true,DefaultValue=30,LowerLimit=1,UpperLimit=3650};
            var daysResult=ed.GetInteger(daysOptions);if(daysResult.Status==PromptStatus.Cancel)return;
            int days=daysResult.Status==PromptStatus.None?30:daysResult.Value;

            var start=new ProcessStartInfo(python)
            {
                UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,
                RedirectStandardError=true,WorkingDirectory=module
            };
            start.ArgumentList.Add("-E");start.ArgumentList.Add("-s");start.ArgumentList.Add("-X");start.ArgumentList.Add("utf8");
            start.ArgumentList.Add(script);start.ArgumentList.Add(plan);start.ArgumentList.Add(cameras);start.ArgumentList.Add(output);
            start.ArgumentList.Add("--days");start.ArgumentList.Add(days.ToString(System.Globalization.CultureInfo.InvariantCulture));
            start.Environment["PYTHONIOENCODING"]="utf-8";
            using var process=Process.Start(start)??throw new IOException("Python process did not start");
            Task<string> stdout=process.StandardOutput.ReadToEndAsync();Task<string> stderr=process.StandardError.ReadToEndAsync();
            if(!process.WaitForExit(120000))
            {
                process.Kill(true);process.WaitForExit();
                throw new TimeoutException("CCTV calculation exceeded 120 seconds.");
            }
            string report=stdout.GetAwaiter().GetResult();string errors=stderr.GetAwaiter().GetResult();
            if(process.ExitCode!=0)throw new InvalidDataException("CCTV calculation failed (exit "+process.ExitCode+"): "+errors+report);
            if(!File.Exists(output))throw new InvalidDataException("Calculation finished without producing the output DXF.");
            ed.WriteMessage("\nCCTV calculation complete. Source plan and active drawing were not modified.\nResult: "+output+"\n"+report);
        }
        catch(System.Exception ex){ed.WriteMessage("\nNSS_CCTV_ANALYZE failed: "+ex.Message);}
    }

    static string? Pick(Editor ed,string prompt,string filter)
    {
        var options=new PromptOpenFileOptions("\n"+prompt+": "){Filter=filter};
        var result=ed.GetFileNameForOpen(options);
        if(result.Status==PromptStatus.Cancel)return null;
        string path=Path.GetFullPath(result.StringResult);
        if(!File.Exists(path))throw new FileNotFoundException("Selected file does not exist.",path);
        return path;
    }
}
