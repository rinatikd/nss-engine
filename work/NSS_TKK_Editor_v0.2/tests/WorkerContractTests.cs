using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

// Integration checks for the actual C#->Python boundary, independent of AutoCAD startup.
static class WorkerContractTests
{
    static readonly List<object> checks=new();
    static void Check(string name,Action check)
    {
        try{check();checks.Add(new{name,success=true});Console.WriteLine("PASS "+name);}
        catch(Exception error){checks.Add(new{name,success=false,error=error.ToString()});Console.WriteLine("FAIL "+name+": "+error.Message);}
    }
    static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
    static void Reject(Action action,string message)
    {
        try{action();}catch(InvalidDataException error){Require(error.Message.Contains(message),error.Message);return;}
        throw new Exception("Invalid worker result was accepted: "+message);
    }
    static int Main(string[] args)
    {
        string root=Path.GetFullPath(args[0]);
        bool synthetic=args.Length>1&&args[1]=="--synthetic";
        string? python=synthetic&&args.Length>2?Path.GetFullPath(args[2]):null;
        if(python!=null&&!File.Exists(python))throw new FileNotFoundException("Synthetic worker Python executable does not exist",python);
        AnalysisWorker Worker(object snapshot,long generation,TimeSpan? timeout=null,string? scriptPath=null)
            =>new AnalysisWorker(root,snapshot,generation,timeout,scriptPath,python);
        using var source=JsonDocument.Parse(synthetic ? """
            {"job_id":"test","fingerprint":"test","protected":{"A":1},
             "wells":[{"id":"A","xyz":[0,0,0]},{"id":"B","xyz":[60,0,0]},
                      {"id":"C","xyz":[120,0,0]},{"id":"D","xyz":[0,30,0]},
                      {"id":"E","xyz":[60,30,0]}],
             "routes":[{"id":"r","points":[[0,0,0],[140,0,0]]}]}
            """ : File.ReadAllText(Path.Combine(root,"evidence/editor_fixture.json")));
        using var worker=Worker(source.RootElement,41);
        using var result=worker.Wait();
        var value=result.RootElement;
        Check(synthetic?"synthetic_snapshot_5_wells_2_spans":"real_snapshot_112_wells_109_spans",()=>{Require(value.GetProperty("leaders").GetArrayLength()==(synthetic?5:112),"Well count");Require(value.GetProperty("spans").GetArrayLength()==(synthetic?2:109),"Span count");Require(worker.Generation==41,"Generation not retained");});
        void Tamper(string name,Action<JsonObject> edit,string expected)=>Check(name,()=>
        {
            var node=JsonNode.Parse(value.GetRawText())!.AsObject();edit(node);
            using var changed=JsonDocument.Parse(node.ToJsonString());
            Reject(()=>ResultContract.Validate(changed.RootElement,source.RootElement,Path.GetFileName(worker.Folder),worker.Fingerprint),expected);
        });
        Tamper("stale_fingerprint_rejected",n=>n["fingerprint"]="old","Stale worker fingerprint");
        Tamper("wrong_job_rejected",n=>n["job_id"]="other","Wrong worker job");
        Tamper("geometry_change_rejected",n=>n["source_geometry_changed"]=true,"geometry change");
        Tamper("undeclared_source_rotation_rejected",n=>n["well_rotations"]!.AsArray().Add(new JsonObject{["id"]="A",["rotation"]=1.0}),"source well rotations");
        Tamper("duplicate_numbers_rejected",n=>{var numbers=n["numbering"]!.AsObject();var keys=numbers.Select(p=>p.Key).Take(2).ToArray();numbers[keys[1]]=numbers[keys[0]]!.DeepClone();},"duplicate well numbers");
        Tamper("missing_well_rejected",n=>n["numbering"]!.AsObject().Remove(n["numbering"]!.AsObject().First().Key),"cover the snapshot wells");
        Tamper("missing_leader_rejected",n=>n["leaders"]!.AsArray().RemoveAt(0),"Missing well leaders");
        Tamper("moved_arrow_rejected",n=>n["leaders"]![0]!["target"]![0]=999.0,"arrow moved");
        Tamper("duplicate_annotations_rejected",n=>n["captions"]![1]!["key"]=n["captions"]![0]!["key"]!.DeepClone(),"Duplicate or invalid annotation");
        Tamper("negative_span_rejected",n=>n["spans"]![0]!["length_m"]=-1,"Invalid span length");
        Tamper("missing_caption_rejected",n=>n["captions"]!.AsArray().RemoveAt(0),"caption count mismatch");
        Tamper("reported_collision_rejected",n=>n["layout_checks"]!["text_text_collisions"]=1,"Text collision");
        Tamper("unknown_span_boundary_rejected",n=>n["spans"]![0]!["end"]="UNKNOWN","span boundary");
        Tamper("protected_number_change_rejected",n=>
        {
            string key=source.RootElement.GetProperty("protected").EnumerateObject().First().Name;
            n["numbering"]![key]=100000;
        },"Protected well number changed");
        Tamper("inverted_text_box_rejected",n=>n["leaders"]![0]!["box"]![0]=n["leaders"]![0]!["box"]![2]!.DeepClone(),"Inverted leader box");
        Check("fingerprinted_issue_reports_written",()=>
        {
            using var report=JsonDocument.Parse(File.ReadAllText(Path.Combine(worker.Folder,"issues.json")));
            Require(report.RootElement.GetProperty("fingerprint").GetString()==worker.Fingerprint,"Report fingerprint");
            Require(report.RootElement.GetProperty("issues").GetArrayLength()==value.GetProperty("warnings").GetArrayLength(),"Report issue count");
            Require(File.Exists(Path.Combine(worker.Folder,"ISSUES_RU.md")),"Readable issue report missing");
        });
        Tamper("wrong_issue_count_rejected",n=>n["diagnostics"]!["total"]=999,"Invalid diagnostic summary");
        Tamper("inferred_connection_rejected",n=>n["diagnostics"]!["connectivity_inferred"]=true,"inferred network connections");
        Tamper("duplicate_issue_id_rejected",n=>n["warnings"]![1]!["issue_id"]=n["warnings"]![0]!["issue_id"]!.DeepClone(),"review issue identity");
        Tamper("unknown_review_source_rejected",n=>n["warnings"]![0]!["source_ids"]!.AsArray().Add("UNKNOWN"),"Unknown review source");
        Tamper("inverted_issue_bounds_rejected",n=>n["warnings"]![0]!["bounds"]![0]=n["warnings"]![0]!["bounds"]![2]!.GetValue<double>()+10,"Inverted issue bounds");
        Tamper("invalid_nearby_candidate_rejected",n=>
        {
            var issue=n["warnings"]!.AsArray().First(i=>i!["endpoints"] is JsonArray endpoints&&endpoints.Count>0&&endpoints[0]!["nearby_wells"] is JsonArray nearby&&nearby.Count>0);
            issue!["endpoints"]![0]!["nearby_wells"]![0]!["distance_m"]=-1;
        },"Invalid issue candidate");
        Check("worker_failure_is_diagnostic",()=>
        {
            using var bad=JsonDocument.Parse("{\"wells\":[],\"routes\":[],\"protected\":{\"A\":0}}");
            using var failed=Worker(bad.RootElement,42);
            Reject(()=>failed.Wait().Dispose(),"positive integer");
        });
        // Exercise cancellation and timeout with a controlled script and the real runtime.
        string temp=Path.Combine(root,"evidence","worker_lifecycle_"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);string sleeper=Path.Combine(temp,"sleep.py");
        File.WriteAllText(sleeper,"import time\ntime.sleep(60)\n");
        Check("dispose_cancels_running_worker",()=>
        {
            var active=Worker(source.RootElement,43,scriptPath:sleeper);int pid=active.ProcessId;active.Dispose();
            bool running;try{using var child=Process.GetProcessById(pid);running=!child.HasExited;}catch(ArgumentException){running=false;}
            Require(!running,"Cancelled worker still running");active.Dispose();
        });
        Check("timeout_cancels_running_worker",()=>
        {
            using var active=Worker(source.RootElement,44,TimeSpan.FromMilliseconds(150),sleeper);
            try{active.Wait().Dispose();throw new Exception("No timeout");}catch(TimeoutException){}
        });
        Check("nonzero_worker_exit_rejected",()=>
        {
            string script=Path.Combine(temp,"exit.py");File.WriteAllText(script,"import sys\nsys.exit(7)\n");
            using var active=Worker(source.RootElement,45,scriptPath:script);
            Reject(()=>active.Wait().Dispose(),"exit code 7");
        });
        Check("missing_worker_result_rejected",()=>
        {
            string script=Path.Combine(temp,"empty.py");File.WriteAllText(script,"pass\n");
            using var active=Worker(source.RootElement,46,scriptPath:script);
            Reject(()=>active.Wait().Dispose(),"did not produce result.json");
        });
        bool success=checks.All(c=>JsonSerializer.Serialize(c).Contains("\"success\":true"));
        AtomicJson.Write(Path.Combine(root,"evidence","worker_contract_summary.json"),new{success,tests=checks.Count,checks});
        return success?0:1;
    }
}
