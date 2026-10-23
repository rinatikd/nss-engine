using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
namespace NssEngine.Export;

public sealed class PythonBridgeV042
{
#if !NSS_DEBUG_ISOLATED
    [CommandMethod("NSS_ANALYZE_V042",CommandFlags.Modal)]
#endif
    public void Analyze()=>ObservabilityV036.Run("NSS_ANALYZE_V042",()=>
    {
        var doc=Application.DocumentManager.MdiActiveDocument??throw new InvalidOperationException("No active drawing");
        var prompt=doc.Editor.GetFileNameForOpen(new PromptOpenFileOptions("\nSelect NSS_EXPORT_V042 snapshot") { Filter="NSS snapshot (*.json)|*.json" });
        if(prompt.Status!=PromptStatus.OK)return;
        string folder=Environment.GetEnvironmentVariable("NSS_REPORT_DIR")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"NSS_Engine");
        string job=PythonJobV042.Start(doc,prompt.StringResult,folder);
        doc.Editor.WriteMessage("\nNSS analysis dispatched; completion is NOT confirmed. Inspect "+Path.Combine(job,"status.json"));
    });
}

public static class PythonJobV042
{
    public static string Start(Document doc,string sourcePath,string folder)
    {
        var source=new FileInfo(sourcePath);
        if(!source.Exists||source.Length>256000000)throw new InvalidDataException("Snapshot missing or exceeds 256 MB");
        DirectoryInfo? root=new DirectoryInfo(Path.GetDirectoryName(typeof(PythonBridgeV042).Assembly.Location)!);
        for(int i=0;i<7&&root!=null&&!File.Exists(Path.Combine(root.FullName,"scripts","analyze_job_v042.py"));i++)root=root.Parent;
        if(root==null||!File.Exists(Path.Combine(root.FullName,"runtime","python.exe")))throw new FileNotFoundException("Deploy the full NSS kit with runtime and scripts, not a detached DLL");
        string job=Path.Combine(folder,"analysis_"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(job);
        var info=new ProcessStartInfo(Path.Combine(root.FullName,"runtime","python.exe")){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root.FullName};
        foreach(string arg in new[]{"-E","-s","-X","utf8",Path.Combine(root.FullName,"scripts","analyze_job_v042.py"),"--input",source.FullName,"--output-dir",job,"--drawing-id",doc.Database.FingerprintGuid.ToString(),"--drawing-name",Path.GetFileName(doc.Name)})info.ArgumentList.Add(arg);
        var process=new Process{StartInfo=info,EnableRaisingEvents=true};
        process.Exited+=(_,__)=>
        {
            try
            {
                string status=Path.Combine(job,"status.json");
                bool terminal=false;
                if(File.Exists(status)){using var json=JsonDocument.Parse(File.ReadAllText(status));terminal=json.RootElement.GetProperty("phase").GetString()!="RUNNING";}
                if(!terminal)File.WriteAllText(status,JsonSerializer.Serialize(new{phase="FAILED",reason="Python exited without terminal report",exit_code=process.ExitCode}));
            }
            catch(System.Exception error){try{File.WriteAllText(Path.Combine(job,"bridge_error.log"),error.ToString());}catch(System.Exception){} }
            finally{process.Dispose();}
        };
        try
        {
            if(!process.Start())throw new InvalidOperationException("Python did not start");
        }
        catch(System.Exception error)
        {
            File.WriteAllText(Path.Combine(job,"status.json"),JsonSerializer.Serialize(new{phase="FAILED",reason="Python launch failed",exception=error.ToString()}));
            process.Dispose();throw;
        }
        return job;
    }
}
