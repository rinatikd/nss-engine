using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

/// <summary>Standalone CCTV analysis launcher. It reads source files and writes a new DXF;</summary>
/// <summary>it never opens or edits the current drawing database.</summary>
public sealed class CctvCommands
{
    // Resolve inside Analyze()'s try block so invalid installation paths
    // are reported through the command rather than a type initializer failure.
    const int DefaultTimeoutSeconds=120;
    const int VkEscape=0x1B;
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int virtualKey);
    [DllImport("user32.dll")]static extern System.IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(System.IntPtr window,out uint processId);

    // ESC counts only while a window of this (AutoCAD) process is in the foreground, so pressing ESC in another application does not cancel the calculation.
    static bool EscapePressed()
    {
        if((GetAsyncKeyState(VkEscape)&0x8000)==0)return false;
        System.IntPtr window=GetForegroundWindow();
        if(window==System.IntPtr.Zero)return false;
        GetWindowThreadProcessId(window,out uint processId);
        return processId==(uint)System.Environment.ProcessId;
    }

    // Timeout can be set with NSS_CCTV_TIMEOUT_SECONDS (10..3600); anything else falls back to the default.
    static int TimeoutSeconds()
    {
        string? raw=Environment.GetEnvironmentVariable("NSS_CCTV_TIMEOUT_SECONDS");
        return int.TryParse(raw,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out int value)&&value>=10&&value<=3600?value:DefaultTimeoutSeconds;
    }

    // Keeps the AutoCAD window alive while waiting. The compile-smoke project has no WinForms, so it defines CCTV_COMPILE_SMOKE.
    static void PumpMessages()
    {
#if !CCTV_COMPILE_SMOKE
        System.Windows.Forms.Application.DoEvents();
#endif
    }

    static void StopProcess(Process process)
    {
        try{if(!process.HasExited){process.Kill(true);process.WaitForExit(2000);}}
        catch(System.Exception e) when(e is System.InvalidOperationException or System.ComponentModel.Win32Exception or System.NotSupportedException){}
    }

    static string Drain(Task<string> task,int milliseconds)
    {
        try{return task.Wait(milliseconds)?task.Result:"";}
        catch(System.AggregateException){return "";}
    }

    static void DeleteQuietly(string path)
    {
        try{if(File.Exists(path))File.Delete(path);}
        catch(System.Exception e) when(e is IOException or System.UnauthorizedAccessException){}
    }

    static string GetRoot()
    {
        string? assemblyDirectory=Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        if(string.IsNullOrWhiteSpace(assemblyDirectory))
            throw new DirectoryNotFoundException("CCTV plugin assembly directory is unavailable.");
        string? root=Directory.GetParent(assemblyDirectory)?.FullName;
        if(string.IsNullOrWhiteSpace(root))
            throw new DirectoryNotFoundException("CCTV plugin parent directory is unavailable.");
        return root;
    }

    // Editor.WriteMessage has formatting overloads. Never treat generated
    // Python stdout or exceptions as a format string.
    static void Print(Editor ed,string text) => ed.WriteMessage("{0}",text);

    [CommandMethod("NSS_CCTV_ANALYZE", CommandFlags.Modal|CommandFlags.NoUndoMarker)]
    public void Analyze()
    {
        var doc=AcApp.DocumentManager.MdiActiveDocument;
        if(doc==null)return;
        Editor ed=doc.Editor;
        try
        {
            string root=GetRoot();
            string module=Path.Combine(root,"modules","cctv");
            string script=Path.Combine(module,"cctv_cli.py");
            string python=Path.Combine(root,"runtime","python.exe");
            if(!File.Exists(script)||!File.Exists(python))
                throw new FileNotFoundException("CCTV module or packaged Python runtime is missing. Expected: "+module);

            string? plan=Pick(ed,"Architectural plan DXF","DXF files (*.dxf)|*.dxf|All files (*.*)|*.*");if(plan==null)return;
            string? cameras=Pick(ed,"Camera placement CSV","CSV files (*.csv)|*.csv|All files (*.*)|*.*");if(cameras==null)return;
            string output=Path.Combine(Path.GetDirectoryName(plan)!,Path.GetFileNameWithoutExtension(plan)+"_CCTV_result.dxf");
            if(File.Exists(output))
            {
                var overwriteOptions=new PromptKeywordOptions("\nOutput already exists: "){AllowNone=true};
                overwriteOptions.Keywords.Add("Overwrite");overwriteOptions.Keywords.Add("Cancel");overwriteOptions.Keywords.Default="Cancel";
                var overwrite=ed.GetKeywords(overwriteOptions);
                if(overwrite.Status!=PromptStatus.OK||!overwrite.StringResult.Equals("Overwrite",StringComparison.OrdinalIgnoreCase))return;
            }
            var daysOptions=new PromptIntegerOptions("\nArchive retention days: "){AllowNone=true,DefaultValue=30,LowerLimit=1,UpperLimit=3650};
            var daysResult=ed.GetInteger(daysOptions);if(daysResult.Status!=PromptStatus.OK&&daysResult.Status!=PromptStatus.None)return;
            int days=daysResult.Status==PromptStatus.None?30:daysResult.Value;

            // F6: drawing units and wall layers are explicit; the script no longer silently assumes millimetres and treats every layer as a wall.
            var unitOptions=new PromptKeywordOptions("\nDrawing units: "){AllowNone=true};
            unitOptions.Keywords.Add("Millimeters");unitOptions.Keywords.Add("Centimeters");unitOptions.Keywords.Add("Meters");unitOptions.Keywords.Default="Millimeters";
            var unitResult=ed.GetKeywords(unitOptions);
            if(unitResult.Status!=PromptStatus.OK&&unitResult.Status!=PromptStatus.None)return;
            string unitName=unitResult.Status==PromptStatus.OK?unitResult.StringResult:"Millimeters";
            double unitToMeters=unitName.Equals("Meters",StringComparison.OrdinalIgnoreCase)?1.0:unitName.Equals("Centimeters",StringComparison.OrdinalIgnoreCase)?0.01:0.001;
            // "Millimeters" and "Meters" share the first letter, so show which unit AutoCAD actually resolved before the calculation starts.
            Print(ed,"\nDrawing units: "+unitName+" (1 drawing unit = "+unitToMeters.ToString("R",System.Globalization.CultureInfo.InvariantCulture)+" m).");

            var layerOptions=new PromptStringOptions("\nWall layers, comma-separated (Enter = all layers): "){AllowSpaces=true};
            var layerResult=ed.GetString(layerOptions);
            if(layerResult.Status!=PromptStatus.OK&&layerResult.Status!=PromptStatus.None)return;
            var layerNames=new System.Collections.Generic.List<string>();
            if(layerResult.Status==PromptStatus.OK)
                foreach(string part in layerResult.StringResult.Replace("\r"," ").Replace("\n"," ").Split(','))
                {
                    string layerName=part.Trim();
                    if(layerName.Length>0)layerNames.Add(layerName);
                }
            string layers=string.Join(",",layerNames);
            if(layers.Length>500)throw new ArgumentException("Wall layer list is too long (limit 500 characters).");
            if(layers.Length==0)Print(ed,"\nNo wall layers given: every layer in the plan is treated as a wall.");

            // The script writes to a private temporary file; the real output is replaced only after a verified success.
            string tempOutput=output+"."+Guid.NewGuid().ToString("N")+".tmp";
            var start=new ProcessStartInfo(python)
            {
                UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,
                RedirectStandardError=true,StandardOutputEncoding=System.Text.Encoding.UTF8,
                StandardErrorEncoding=System.Text.Encoding.UTF8,WorkingDirectory=module
            };
            start.ArgumentList.Add("-E");start.ArgumentList.Add("-s");start.ArgumentList.Add("-X");start.ArgumentList.Add("utf8");
            start.ArgumentList.Add(script);start.ArgumentList.Add(plan);start.ArgumentList.Add(cameras);start.ArgumentList.Add(tempOutput);
            start.ArgumentList.Add("--days");start.ArgumentList.Add(days.ToString(System.Globalization.CultureInfo.InvariantCulture));
            start.ArgumentList.Add("--unit");start.ArgumentList.Add(unitToMeters.ToString("R",System.Globalization.CultureInfo.InvariantCulture));
            if(layers.Length>0){start.ArgumentList.Add("--layers");start.ArgumentList.Add(layers);}
            start.Environment["PYTHONIOENCODING"]="utf-8";
            using var process=Process.Start(start)??throw new IOException("Python process did not start");
            try
            {
                Task<string> stdout=process.StandardOutput.ReadToEndAsync();Task<string> stderr=process.StandardError.ReadToEndAsync();
                int timeoutSeconds=TimeoutSeconds();
                DateTime deadline=DateTime.UtcNow.AddSeconds(timeoutSeconds);
                string? stopReason=null;
                Print(ed,"\nCCTV calculation started. Press ESC to cancel (timeout "+timeoutSeconds+" s).");
                while(!process.WaitForExit(100))
                {
                    PumpMessages();
                    if(EscapePressed()){stopReason="cancelled";break;}
                    if(DateTime.UtcNow>=deadline){stopReason="timeout";break;}
                }
                // If the process finished between the last poll and the stop check, treat it as completed.
                if(stopReason!=null&&!process.HasExited)
                {
                    StopProcess(process);
                    string partialErrors=Drain(stderr,2000);
                    if(stopReason=="cancelled"){Print(ed,"\nCCTV calculation cancelled. No result was written.");return;}
                    throw new TimeoutException("CCTV calculation exceeded "+timeoutSeconds+" seconds. "+partialErrors);
                }
                process.WaitForExit();
                string report=Drain(stdout,5000);string errors=Drain(stderr,5000);
                if(process.ExitCode!=0)throw new InvalidDataException("CCTV calculation failed (exit "+process.ExitCode+"): "+errors+report);
                var produced=new FileInfo(tempOutput);
                // The temporary name is a fresh GUID, so it cannot be a stale file; existence and non-zero length are enough.
                if(!produced.Exists||produced.Length==0)
                    throw new InvalidDataException("Calculation finished without producing an output DXF.");
                try{File.Move(tempOutput,output,true);}
                catch(System.Exception e) when(e is IOException or System.UnauthorizedAccessException)
                {
                    throw new IOException("The calculation succeeded, but the result could not replace "+output+" (is it open in another program or read-only?). Close it and run the command again. "+e.Message,e);
                }
                Print(ed,"\nCCTV calculation complete. Source plan and active drawing were not modified.\nResult: "+output+"\n"+report);
            }
            finally
            {
                // Any exit path: no stray Python process and no stray temporary file (after a successful move it no longer exists).
                StopProcess(process);
                DeleteQuietly(tempOutput);
            }
        }
        catch(System.Exception ex){Print(ed,"\nNSS_CCTV_ANALYZE failed: "+ex.Message);}
    }

    static string? Pick(Editor ed,string prompt,string filter)
    {
        var options=new PromptOpenFileOptions("\n"+prompt+": "){Filter=filter};
        var result=ed.GetFileNameForOpen(options);
        if(result.Status!=PromptStatus.OK)return null;
        string path=Path.GetFullPath(result.StringResult);
        if(!File.Exists(path))throw new FileNotFoundException("Selected file does not exist.",path);
        return path;
    }
}
