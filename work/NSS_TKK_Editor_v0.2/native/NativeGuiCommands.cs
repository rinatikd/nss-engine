using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.AutoCAD.ApplicationServices;
using AcApp=Autodesk.AutoCAD.ApplicationServices.Core.Application;

internal static class NativeGuiCommands
{
    internal static async void Run(Document target,string commands,Action acknowledged,Action<System.Exception> failed)
    {
        try
        {
            await AcApp.DocumentManager.ExecuteInCommandContextAsync(_=>
            {
                try
                {
                    if(AcApp.DocumentManager.MdiActiveDocument!=target)throw new InvalidOperationException("The private test drawing is not active");
                    var tokens=commands.Split(' ',StringSplitOptions.RemoveEmptyEntries);
                    for(int i=0;i<tokens.Length;i++)
                    {
                        if(tokens[i]=="_.UNDO")target.Editor.Command(tokens[i],int.Parse(tokens[++i]));
                        else target.Editor.Command(tokens[i]);
                    }
                    acknowledged();
                }
                catch(System.Exception error){failed(error);}
                return Task.CompletedTask;
            },null);
        }
        catch(System.Exception error){failed(error);}
    }
    internal static void QuitOwnedProcess()
    {
        string folder=Path.GetFullPath(Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT")!)+Path.DirectorySeparatorChar;
        // PID validation happens before calling this helper. Recheck all documents:
        // nothing outside this run's private directory may be discarded.
        foreach(Document document in AcApp.DocumentManager)
            if(!Path.GetFullPath(document.Name).StartsWith(folder,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Refusing to close an unexpected drawing");
        AcApp.DocumentManager.ExecuteInApplicationContext(_=>
        {
            try
            {
                foreach(Document document in AcApp.DocumentManager.Cast<Document>().ToArray())document.CloseAndDiscard();
                Autodesk.AutoCAD.ApplicationServices.Application.Quit();
            }
            catch(System.Exception error){File.WriteAllText(Path.Combine(folder,"shutdown_error.txt"),error.ToString());}
        },null);
    }
}
