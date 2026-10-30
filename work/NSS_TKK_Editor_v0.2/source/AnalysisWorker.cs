using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;

// No AutoCAD objects cross this boundary; all database work stays on its main thread.
internal sealed class AnalysisWorker : IDisposable
{
    readonly Process process;
    readonly Task<string> stderr, stdout;
    readonly DateTime started = DateTime.UtcNow;
    readonly JsonElement snapshot;
    bool disposed;
    internal string Folder { get; }
    internal string Fingerprint { get; }
    internal long Generation { get; }
    internal TimeSpan Timeout { get; }
    internal int ProcessId => process.Id;

    internal static string Hash(object snapshot) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(snapshot)));

    internal AnalysisWorker(string root, object source, long generation, TimeSpan? timeout = null, string? scriptPath = null, string? pythonExecutable = null)
    {
        Fingerprint=Hash(source);Generation=generation;Timeout=timeout??TimeSpan.FromMinutes(2);
        Folder=Path.Combine(root,"Runs",DateTime.UtcNow.ToString("yyyyMMdd_HHmmss")+"_"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Folder);
        using var document=JsonDocument.Parse(JsonSerializer.Serialize(source));snapshot=document.RootElement.Clone();
        var input=snapshot.EnumerateObject().ToDictionary(p=>p.Name,p=>(object)p.Value.Clone());
        input["job_id"]=Path.GetFileName(Folder);input["fingerprint"]=Fingerprint;
        string file=Path.Combine(Folder,"snapshot.json");AtomicJson.Write(file,input);
        var start=new ProcessStartInfo(pythonExecutable??Path.Combine(root,"runtime","python.exe"))
        {UseShellExecute=false,CreateNoWindow=true,RedirectStandardError=true,RedirectStandardOutput=true,WorkingDirectory=root};
        foreach(string arg in new[]{"-E","-s","-X","utf8",scriptPath??Path.Combine(root,"engine","tkk_editor_core.py"),file,Path.Combine(Folder,"result.json")})start.ArgumentList.Add(arg);
        process=Process.Start(start)??throw new IOException("Python did not start");
        stderr=process.StandardError.ReadToEndAsync();stdout=process.StandardOutput.ReadToEndAsync();
    }

    internal bool TryComplete(out JsonDocument? result)
    {
        ObjectDisposedException.ThrowIf(disposed,this);result=null;
        if(!process.HasExited)
        {
            if(DateTime.UtcNow-started>Timeout){Dispose();throw new TimeoutException("Analysis worker exceeded "+Timeout.TotalSeconds+" seconds");}
            return false;
        }
        File.WriteAllText(Path.Combine(Folder,"worker_stderr.txt"),stderr.GetAwaiter().GetResult());
        File.WriteAllText(Path.Combine(Folder,"worker_stdout.txt"),stdout.GetAwaiter().GetResult());
        if(process.ExitCode!=0)throw new InvalidDataException("Analysis worker exit code "+process.ExitCode+"; see "+Folder);
        string file=Path.Combine(Folder,"result.json");
        if(!File.Exists(file))throw new InvalidDataException("Worker did not produce result.json; see "+Folder);
        if(new FileInfo(file).Length>64*1024*1024)throw new InvalidDataException("Worker result size limit exceeded");
        var parsed=JsonDocument.Parse(File.ReadAllText(file));
        try {ResultContract.Validate(parsed.RootElement,snapshot,Path.GetFileName(Folder),Fingerprint);result=parsed;return true;}
        catch {parsed.Dispose();throw;}
    }

    internal JsonDocument Wait()
    {
        // Only used by explicit modal CHECK/REBUILD commands, never by Idle.
        JsonDocument? result;
        while(!TryComplete(out result))process.WaitForExit(25);
        return result!;
    }

    public void Dispose()
    {
        if(disposed)return;disposed=true;
        try {if(!process.HasExited){process.Kill(true);process.WaitForExit(2000);}}catch(System.Exception e) when(e is InvalidOperationException or System.ComponentModel.Win32Exception){}finally{process.Dispose();}
    }
}

internal static class AtomicJson
{
    internal static void Write(string path,object value)
    {
        string temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try {File.WriteAllText(temporary,JsonSerializer.Serialize(value,new JsonSerializerOptions{WriteIndented=true}));File.Move(temporary,path,true);}
        finally {if(File.Exists(temporary))File.Delete(temporary);}
    }
}

internal static class ResultContract
{
    static void Require(bool value,string message){if(!value)throw new InvalidDataException(message);}
    static void Position(JsonElement point)
    {
        Require(point.ValueKind==JsonValueKind.Array&&point.GetArrayLength() is 2 or 3,"Invalid annotation coordinates");
        foreach(var number in point.EnumerateArray())Require(number.TryGetDouble(out double n)&&double.IsFinite(n),"Non-finite annotation coordinate");
    }
    internal static void Validate(JsonElement result,JsonElement snapshot,string job,string fingerprint)
    {
        Require(result.GetProperty("phase").GetString()=="READY",result.TryGetProperty("error",out var error)?error.GetString()??"Analysis failed":"Analysis failed");
        Require(result.GetProperty("job_id").GetString()==job,"Wrong worker job identity");
        Require(result.GetProperty("fingerprint").GetString()==fingerprint,"Stale worker fingerprint");
        Require(result.GetProperty("source_geometry_changed").ValueKind==JsonValueKind.False,"Worker declared a geometry change");
        Require(result.GetProperty("well_rotations").ValueKind==JsonValueKind.Array&&result.GetProperty("well_rotations").GetArrayLength()==0,"Worker requested source well rotations");
        var wells=snapshot.GetProperty("wells").EnumerateArray().ToDictionary(w=>w.GetProperty("id").GetString()!);
        var numbers=result.GetProperty("numbering").EnumerateObject().ToDictionary(p=>p.Name,p=>p.Value.GetInt32());
        Require(numbers.Keys.ToHashSet().SetEquals(wells.Keys),"Worker numbering does not cover the snapshot wells");
        Require(numbers.Values.All(n=>n>0)&&numbers.Values.Distinct().Count()==numbers.Count,"Invalid or duplicate well numbers");
        foreach(var pinned in snapshot.GetProperty("protected").EnumerateObject())
        {
            int number=pinned.Value.GetInt32();
            if(wells.ContainsKey(pinned.Name))Require(numbers[pinned.Name]==number,"Protected well number changed: "+pinned.Name);
            else Require(!numbers.Values.Contains(number),"Deleted protected number was reused");
        }
        var keys=new HashSet<string>();var leaderKeys=new HashSet<string>();
        foreach(string field in new[]{"leaders","captions"})foreach(var item in result.GetProperty(field).EnumerateArray())
        {
            string key=item.GetProperty("key").GetString()??"";
            Require(key.Length is >0 and <255&&keys.Add(key),"Duplicate or invalid annotation identity");
            Require(!string.IsNullOrEmpty(item.GetProperty("text").GetString()),"Empty annotation text");
            if(field=="leaders")
            {
                leaderKeys.Add(key);Require(key.StartsWith("well:")&&wells.ContainsKey(key[5..]),"Unknown leader well");
                Position(item.GetProperty("target"));Position(item.GetProperty("insert"));
                var target=item.GetProperty("target");var origin=wells[key[5..]].GetProperty("xyz");
                Require(Math.Abs(target[0].GetDouble()-origin[0].GetDouble())<1e-9&&Math.Abs(target[1].GetDouble()-origin[1].GetDouble())<1e-9,"Leader arrow moved away from well");
                var box=item.GetProperty("box");Require(box.GetArrayLength()==4,"Invalid leader box");
                foreach(var v in box.EnumerateArray())Require(double.IsFinite(v.GetDouble()),"Non-finite leader box");
                Require(box[0].GetDouble()<box[2].GetDouble()&&box[1].GetDouble()<box[3].GetDouble(),"Inverted leader box");
            }
            else {Position(item.GetProperty("xyz"));Require(double.IsFinite(item.GetProperty("rotation").GetDouble()),"Invalid text rotation");}
        }
        Require(leaderKeys.SetEquals(wells.Keys.Select(k=>"well:"+k)),"Missing well leaders");
        var boundaries=wells.Keys.Concat(snapshot.GetProperty("routes").EnumerateArray().Where(r=>r.TryGetProperty("building_entry",out var entry)&&entry.ValueKind==JsonValueKind.True).Select(r=>"ENTRY:"+r.GetProperty("id").GetString())).ToHashSet();
        foreach(var span in result.GetProperty("spans").EnumerateArray())
        {
            string a=span.GetProperty("start").GetString()!,b=span.GetProperty("end").GetString()!;
            double length=span.GetProperty("length_m").GetDouble();
            Require(a!=b&&boundaries.Contains(a)&&boundaries.Contains(b),"Unknown or self-returning span boundary");
            Require(double.IsFinite(length)&&length>=.005,"Invalid span length");
        }
        Require(result.GetProperty("captions").GetArrayLength()==2*result.GetProperty("spans").GetArrayLength(),"Span caption count mismatch");
        var checks=result.GetProperty("layout_checks");
        foreach(string field in new[]{"text_route_collisions","text_well_collisions","text_caption_collisions","text_text_collisions"})Require(checks.GetProperty(field).GetInt32()==0,"Text collision: "+field);
        var diagnostics=result.GetProperty("diagnostics");var warnings=result.GetProperty("warnings");
        Require(diagnostics.GetProperty("schema_version").GetInt32()==1&&diagnostics.GetProperty("total").GetInt32()==warnings.GetArrayLength(),"Invalid diagnostic summary");
        Require(diagnostics.GetProperty("connectivity_inferred").ValueKind==JsonValueKind.False,"Diagnostics inferred network connections");
        var sources=wells.Keys.Concat(snapshot.GetProperty("routes").EnumerateArray().Select(r=>r.GetProperty("id").GetString()!)).ToHashSet();
        var issueIds=new HashSet<string>();
        foreach(var issue in warnings.EnumerateArray())
        {
            string identity=issue.GetProperty("issue_id").GetString()??"";
            Require(identity.StartsWith("NSS-")&&identity.Length==20&&issueIds.Add(identity),"Duplicate or invalid review issue identity");
            Require(!string.IsNullOrWhiteSpace(issue.GetProperty("title").GetString()),"Missing review issue title");
            foreach(var source in issue.GetProperty("source_ids").EnumerateArray())Require(sources.Contains(source.GetString()!),"Unknown review source object");
            var bounds=issue.GetProperty("bounds");
            if(bounds.ValueKind!=JsonValueKind.Null)
            {
                Require(bounds.ValueKind==JsonValueKind.Array&&bounds.GetArrayLength()==4,"Invalid issue bounds");
                foreach(var number in bounds.EnumerateArray())Require(double.IsFinite(number.GetDouble()),"Non-finite issue bounds");
                Require(bounds[0].GetDouble()<=bounds[2].GetDouble()&&bounds[1].GetDouble()<=bounds[3].GetDouble(),"Inverted issue bounds");
            }
            if(issue.TryGetProperty("endpoints",out var endpoints))foreach(var endpoint in endpoints.EnumerateArray())
            {
                Position(endpoint.GetProperty("xy"));
                foreach(string field in new[]{"nearby_routes","nearby_wells"})foreach(var candidate in endpoint.GetProperty(field).EnumerateArray())
                {
                    double distance=candidate.GetProperty("distance_m").GetDouble();
                    Require(sources.Contains(candidate.GetProperty("id").GetString()!)&&double.IsFinite(distance)&&distance>=0,"Invalid issue candidate");
                    Position(candidate.GetProperty("xy"));
                }
            }
        }
    }
}
