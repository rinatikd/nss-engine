using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Autodesk.AutoCAD.Runtime;

public sealed class CoreProbe
{
    [CommandMethod("NSS_TKK_CORE_PROBE",CommandFlags.Modal)]
    public void Probe()
    {
        string root=Environment.GetEnvironmentVariable("NSS_TKK_PACKAGE");
        string output=Environment.GetEnvironmentVariable("NSS_TKK_NATIVE_OUT");
        try
        {
            var assembly=Assembly.LoadFrom(Path.Combine(root,"native/bin/NssTkkNativeSmoke.V002.dll"));
            var type=assembly.GetType("NativeSmoke",throwOnError:true);
            var instance=Activator.CreateInstance(type);
            type.GetMethod("Run").Invoke(instance,null);
        }
        catch(System.Exception e){File.WriteAllText(Path.Combine(output,"probe_error.txt"),e.ToString());}
        File.WriteAllText(Path.Combine(output,"probe_runtime.json"),JsonSerializer.Serialize(new{runtime=System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,assemblies=AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.FullName).ToArray()}));
    }
}
