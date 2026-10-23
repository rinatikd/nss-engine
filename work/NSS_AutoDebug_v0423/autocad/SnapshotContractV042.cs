using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace NssEngine.Export;

public sealed record EntityV042(string handle,string layer,string type,double[][] vertices,
    double[] bulges,bool closed,string block_name,Dictionary<string,string> attributes,double[] normal,bool is_xref);
public static class SnapshotContractV042
{
    public const int MaxEntities=1000000,MaxVertices=100000;
    public static void ValidateSnapshotJson(string json)
    {
        using var doc=JsonDocument.Parse(json);var root=doc.RootElement;
        if(root.GetProperty("schema_version").GetString()!="0.42"||root.GetProperty("kind").GetString()!="snapshot3d")throw new ArgumentException("invalid schema");
        var drawing=root.GetProperty("drawing");
        foreach(string name in new[]{"id","name"})if(string.IsNullOrWhiteSpace(drawing.GetProperty(name).GetString()))throw new ArgumentException("invalid drawing identity");
        int units=drawing.GetProperty("insunits_code").GetInt32();
        if(units<0||units>24||drawing.GetProperty("coordinate_system").GetString()!="unverified")throw new ArgumentException("invalid units/coordinates");
        var array=root.GetProperty("entities");
        if(array.GetArrayLength()>MaxEntities)throw new ArgumentException("entity limit");
        var handles=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach(var element in array.EnumerateArray())
        {
            foreach(string name in new[]{"handle","layer","type","vertices","bulges","closed","block_name","attributes","normal","is_xref"})element.GetProperty(name);
            var e=element.Deserialize<EntityV042>()??throw new ArgumentException("null entity");Validate(e);
            if(!handles.Add(e.handle))throw new ArgumentException("duplicate handle");
        }
        var c=root.GetProperty("coverage");int visited=c.GetProperty("visited").GetInt32(),exported=c.GetProperty("exported").GetInt32(),skipped=c.GetProperty("skipped").GetInt32();
        bool truncated=c.GetProperty("truncated").GetBoolean(),complete=c.GetProperty("complete").GetBoolean();
        if(visited<0||exported<0||skipped<0||visited!=(long)exported+skipped||exported!=array.GetArrayLength()||complete!=(skipped==0&&!truncated))throw new ArgumentException("inconsistent coverage");
        foreach(var warning in root.GetProperty("warnings").EnumerateArray())
            foreach(string key in new[]{"handle","code","message"})if(warning.GetProperty(key).ValueKind!=JsonValueKind.String)throw new ArgumentException("invalid warning");
    }
    public static void Validate(EntityV042 e)
    {
        if(string.IsNullOrWhiteSpace(e.handle)||e.handle.Length>128||e.layer==null)throw new ArgumentException("invalid identity");
        if(e.vertices==null||e.vertices.Length>MaxVertices||e.vertices.Any(p=>p==null||p.Length!=3||p.Any(v=>!double.IsFinite(v)||Math.Abs(v)>1e12)))throw new ArgumentException("invalid XYZ");
        if(e.normal==null||e.normal.Length!=3||e.normal.Any(v=>!double.IsFinite(v))||e.normal.All(v=>v==0))throw new ArgumentException("invalid normal");
        if(e.bulges==null||e.bulges.Any(v=>!double.IsFinite(v)))throw new ArgumentException("invalid bulges");
        if(e.type=="LINE") { if(e.vertices.Length!=2||e.bulges.Length!=0||e.closed)throw new ArgumentException("invalid line"); }
        else if(e.type=="LWPOLYLINE") {
            if(e.vertices.Length<2||e.bulges.Length!=e.vertices.Length)throw new ArgumentException("invalid polyline");
            double scale=e.normal.Max(v=>Math.Abs(v));
            var n=e.normal.Select(v=>v/scale).ToArray();double mag=Math.Sqrt(n.Sum(v=>v*v));
            foreach(var p in e.vertices){var d=p.Select((v,i)=>v-e.vertices[0][i]).ToArray();double distance=Math.Sqrt(d.Sum(v=>v*v));
                double dot=d.Select((v,i)=>v*n[i]/mag).Sum();
                if(!double.IsFinite(distance)||!double.IsFinite(dot)||Math.Abs(dot)>Math.Max(1,distance)*1e-9)throw new ArgumentException("nonplanar polyline");}
        }
        else if(e.type=="INSERT") { if(e.vertices.Length!=1||e.bulges.Length!=0||e.closed||string.IsNullOrWhiteSpace(e.block_name))throw new ArgumentException("invalid insert"); }
        else throw new ArgumentException("unsupported type");
        if(e.attributes==null || e.attributes.Keys.Distinct(StringComparer.OrdinalIgnoreCase).Count()!=e.attributes.Count)throw new ArgumentException("invalid attributes");
    }
}
