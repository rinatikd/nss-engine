using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using NssEngine.Export;
using System.Text.Json;
if(args.Length==3&&args[0]=="--inspect-assembly")
{
    using var stream=File.OpenRead(args[1]);using var pe=new PEReader(stream);var metadata=pe.GetMetadataReader();
    var entries=new List<object>();
    foreach(var handle in metadata.CustomAttributes)
    {
        var a=metadata.GetCustomAttribute(handle);
        if(a.Constructor.Kind!=HandleKind.MemberReference)continue;
        var reference=metadata.GetMemberReference((MemberReferenceHandle)a.Constructor);
        if(reference.Parent.Kind!=HandleKind.TypeReference)continue;
        var type=metadata.GetTypeReference((TypeReferenceHandle)reference.Parent);string name=metadata.GetString(type.Name);
        if(name!="CommandMethodAttribute"&&name!="LispFunctionAttribute")continue;
        var blob=metadata.GetBlobReader(a.Value);if(blob.ReadUInt16()!=1)throw new Exception("Invalid attribute prolog");
        entries.Add(new{kind=name,name=blob.ReadSerializedString()});
    }
    File.WriteAllText(args[2],JsonSerializer.Serialize(new{assembly=metadata.GetString(metadata.GetAssemblyDefinition().Name),entries},new JsonSerializerOptions{WriteIndented=true}));
    return;
}
int passed=0;
void Require(bool ok){if(!ok)throw new Exception("assertion failed");passed++;}
Require(DatabaseStateV042.Canonicalize(new object[]{new{x=1},new{x=2}})==DatabaseStateV042.Canonicalize(new object[]{new{x=2},new{x=1}}));
Require(DatabaseStateV042.Canonicalize(new object[]{new{x=1}})!=DatabaseStateV042.Canonicalize(new object[]{new{x=2}}));
Require(DatabaseStateV042.Canonicalize(new object[]{new{x=1}})!=DatabaseStateV042.Canonicalize(new object[]{new{x=1},new{x=1}}));
string lockedFixture=Path.GetTempFileName();
try
{
    byte[] bytes=System.Text.Encoding.UTF8.GetBytes("NSS open drawing sharing regression");
    File.WriteAllBytes(lockedFixture,bytes);
    using var owner=new FileStream(lockedFixture,FileMode.Open,FileAccess.ReadWrite,FileShare.Read);
    bool previousFailed=false;
    try{File.ReadAllBytes(lockedFixture);}catch(IOException){previousFailed=true;}
    if(OperatingSystem.IsWindows())Require(previousFailed);
    Require(SharedFileHashV042.Compute(lockedFixture)==Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant());
}
finally{File.Delete(lockedFixture);}
void Reject(EntityV042 e){try{SnapshotContractV042.Validate(e);}catch(ArgumentException){passed++;return;}throw new Exception("accepted invalid record");}
var line=new EntityV042("A","NSS","LINE",new[]{new[]{0d,0d,0d},new[]{0d,0d,5d}},Array.Empty<double>(),false,"",new(),new[]{0d,0d,1d},false);
SnapshotContractV042.Validate(line);Require(line.vertices[1][2]==5);
Reject(line with {vertices=new[]{new[]{0d,0d,double.NaN},new[]{0d,0d,1d}}});
Reject(line with {normal=new[]{0d,0d,0d}});
Reject(line with {type="SPLINE"});
Reject(line with {bulges=new[]{1d}});
Reject(line with {handle=""});
var poly=line with {type="LWPOLYLINE",bulges=new[]{1d,0d},normal=new[]{0d,1d,0d}};
SnapshotContractV042.Validate(poly);Require(poly.bulges[0]==1);
Reject(line with {vertices=new[]{new[]{0d,0d,0d},new[]{1e13,0d,0d}}});
Reject(poly with {normal=new[]{0d,0d,1d}});
var snapshot=new{schema_version="0.42",kind="snapshot3d",drawing=new{id="fixture",name="fixture.dwg",insunits_code=4,coordinate_system="unverified"},coverage=new{visited=1,exported=1,skipped=0,truncated=false,complete=true},entities=new[]{line},warnings=Array.Empty<object>()};
string json=JsonSerializer.Serialize(snapshot);
SnapshotContractV042.ValidateSnapshotJson(json);Require(true);
try{SnapshotContractV042.ValidateSnapshotJson(json.Replace("\"exported\":1","\"exported\":2"));throw new Exception("accepted inconsistent coverage");}catch(ArgumentException){passed++;}
if(args.Length==1)File.WriteAllText(args[0],json);
// Synthetic contract input: these checks must run without a drawing or host kit.
string preview=JsonSerializer.Serialize(new{schema_version="0.31",kind="route_preview",units="unverified_raw_drawing_units",requires_engineer_approval=true,source_drawing="runtime_fixture_v042.dwg",routes=new[]{new{id="fixture",points=new[]{new[]{0d,0d},new[]{10d,0d}}}}});
Require(PreviewContractV042.Parse(preview,"runtime_fixture_v042.dwg").Count==1);
void RejectPreview(string data,string drawing="runtime_fixture_v042.dwg"){
    bool rejected=false;try{PreviewContractV042.Parse(data,drawing);}catch(System.Exception){rejected=true;}Require(rejected);
}
RejectPreview(preview,"wrong.dwg");
RejectPreview(preview.Replace("true","false"));
RejectPreview(preview.Replace("\"fixture\"","\"bad name\""));
RejectPreview(preview.Replace("\"0.31\"","\"0.42\""));
var node=System.Text.Json.Nodes.JsonNode.Parse(preview)!;
node["routes"]![0]!["points"]![0]![0]=true;RejectPreview(node.ToJsonString());
node=System.Text.Json.Nodes.JsonNode.Parse(preview)!;var routes=node["routes"]!.AsArray();routes.Add(routes[0]!.DeepClone());RejectPreview(node.ToJsonString());
Console.WriteLine($"{passed} C# contract checks passed");
