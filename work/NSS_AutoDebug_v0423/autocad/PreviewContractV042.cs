using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
namespace NssEngine.Export;
public sealed record PreviewPointV042(double X,double Y);
public sealed record PreviewRouteV042(string Name,List<PreviewPointV042> Points);
public static class PreviewContractV042
{
    public static List<PreviewRouteV042> Parse(string json,string drawing)
    {
        using var document=JsonDocument.Parse(json);var root=document.RootElement;
        if(root.GetProperty("schema_version").GetString()!="0.31"||root.GetProperty("kind").GetString()!="route_preview"||root.GetProperty("units").GetString()!="unverified_raw_drawing_units"||root.GetProperty("requires_engineer_approval").ValueKind!=JsonValueKind.True)
            throw new InvalidDataException("Invalid preview metadata");
        if(root.TryGetProperty("source_drawing",out var source)&&source.ValueKind!=JsonValueKind.Null)
        {
            string? expected=source.GetString();
            if(!string.IsNullOrWhiteSpace(expected)&&!string.Equals(Path.GetFileName(expected.Replace('\\','/')),Path.GetFileName(drawing.Replace('\\','/')),StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Drawing mismatch");
        }
        var routes=root.GetProperty("routes");
        if(routes.GetArrayLength()<1||routes.GetArrayLength()>20)throw new InvalidDataException("Invalid route count");
        var result=new List<PreviewRouteV042>();var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);int total=0;
        foreach(var route in routes.EnumerateArray())
        {
            string name=route.GetProperty("id").GetString()??"";
            if(name.Length<1||name.Length>64||name.Any(c=>c>127||(!char.IsLetterOrDigit(c)&&c!='_'))||!names.Add(name))throw new InvalidDataException("Invalid or duplicate ID");
            var points=route.GetProperty("points");total+=points.GetArrayLength();
            if(points.GetArrayLength()<2||total>20000)throw new InvalidDataException("Point limit");
            var list=new List<PreviewPointV042>();
            foreach(var pair in points.EnumerateArray())
            {
                if(pair.GetArrayLength()!=2)throw new InvalidDataException("Expected XY");
                double x=pair[0].GetDouble(),y=pair[1].GetDouble();
                if(!double.IsFinite(x)||!double.IsFinite(y)||Math.Abs(x)>1e9||Math.Abs(y)>1e9)throw new InvalidDataException("Invalid coordinate");
                list.Add(new(x,y));
            }
            if(list.Zip(list.Skip(1),(a,b)=>Math.Sqrt(Math.Pow(a.X-b.X,2)+Math.Pow(a.Y-b.Y,2))).All(d=>d<1e-9))throw new InvalidDataException("Degenerate route");
            result.Add(new(name,list));
        }
        return result;
    }
}
