# Read-only native metadata for exact Windows process and Lab isolation checks.
if (!('BridgeNativeMetadata' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Net;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BridgeNativeMetadata {
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public UIntPtr UniqueProcessId;
    public UIntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int info, IntPtr buffer, int size, out int required);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int info, out PROCESS_BASIC_INFORMATION buffer, int size, out int required);
  [DllImport("iphlpapi.dll", SetLastError=true)]
  static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

  public static string Image(IntPtr h) {
    int size=32768; var b=new StringBuilder(size);
    if(!QueryFullProcessImageName(h,0,b,ref size)) throw new System.ComponentModel.Win32Exception();
    return b.ToString();
  }
  public static string Command(IntPtr h) {
    int size; NtQueryInformationProcess(h,60,IntPtr.Zero,0,out size);
    if(size<16 || size>1048576) throw new Exception("Command line query unavailable");
    IntPtr p=Marshal.AllocHGlobal(size);
    try {
      int needed; int status=NtQueryInformationProcess(h,60,p,size,out needed);
      if(status!=0) throw new Exception("Command line query denied");
      int length=(ushort)Marshal.ReadInt16(p);
      IntPtr text=Marshal.ReadIntPtr(p,IntPtr.Size==8?8:4);
      return Marshal.PtrToStringUni(text,length/2);
    } finally { Marshal.FreeHGlobal(p); }
  }
  static PROCESS_BASIC_INFORMATION Basic(IntPtr h) {
    if(IntPtr.Size!=8) throw new Exception("64-bit process inspection host required");
    PROCESS_BASIC_INFORMATION basic; int returned;
    int status=NtQueryInformationProcess(h,0,out basic,Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),out returned);
    if(status!=0 || basic.PebBaseAddress==IntPtr.Zero) throw new Exception("PEB query failed");
    return basic;
  }
  static IntPtr ReadPointer(IntPtr h,IntPtr address) {
    byte[] b=new byte[IntPtr.Size]; IntPtr read;
    if(!ReadProcessMemory(h,address,b,(IntPtr)b.Length,out read) || (long)read!=b.Length)
      throw new Exception("Process pointer read failed");
    return new IntPtr(BitConverter.ToInt64(b,0));
  }
  static byte[] ReadExact(IntPtr h,IntPtr address,int length) {
    byte[] b=new byte[length]; IntPtr read;
    if(!ReadProcessMemory(h,address,b,(IntPtr)length,out read) || (long)read!=length)
      throw new Exception("Process memory read failed");
    return b;
  }
  static IntPtr Parameters(IntPtr h) {
    IntPtr p=ReadPointer(h,IntPtr.Add(Basic(h).PebBaseAddress,0x20));
    if(p==IntPtr.Zero) throw new Exception("Process parameters unavailable");
    return p;
  }
  public static string CurrentDirectory(IntPtr h) {
    byte[] descriptor=ReadExact(h,IntPtr.Add(Parameters(h),0x38),16);
    int length=BitConverter.ToUInt16(descriptor,0);
    IntPtr buffer=new IntPtr(BitConverter.ToInt64(descriptor,8));
    if(length<=0 || length>32768 || buffer==IntPtr.Zero) throw new Exception("Process current directory unavailable");
    return Encoding.Unicode.GetString(ReadExact(h,buffer,length));
  }
  public static string EnvironmentVariable(IntPtr h,string requestedName) {
    if(String.IsNullOrWhiteSpace(requestedName)) throw new ArgumentException("Environment variable name required");
    IntPtr env=ReadPointer(h,IntPtr.Add(Parameters(h),0x80));
    if(env==IntPtr.Zero) throw new Exception("Process environment unavailable");
    using(MemoryStream stream=new MemoryStream()) {
      bool done=false;
      for(int offset=0;offset<1048576 && !done;offset+=4096) {
        byte[] chunk=new byte[4096]; IntPtr got;
        bool ok=ReadProcessMemory(h,IntPtr.Add(env,offset),chunk,(IntPtr)chunk.Length,out got);
        int count=(int)got;
        if(!ok && count<=0) throw new Exception("Process environment read failed");
        if(count<=0) break;
        stream.Write(chunk,0,count);
        byte[] all=stream.ToArray();
        for(int i=0;i+3<all.Length;i+=2) {
          if(all[i]==0 && all[i+1]==0 && all[i+2]==0 && all[i+3]==0) { done=true; break; }
        }
        if(count<chunk.Length) break;
      }
      string[] entries=Encoding.Unicode.GetString(stream.ToArray()).Split(new char[]{'\0'},StringSplitOptions.RemoveEmptyEntries);
      foreach(string entry in entries) {
        int equals=entry.IndexOf('=');
        if(equals>0 && String.Equals(entry.Substring(0,equals),requestedName,StringComparison.OrdinalIgnoreCase))
          return entry.Substring(equals+1);
      }
    }
    return "";
  }
  public static string[] Listeners(int port) {
    int size=0; GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,5,0);
    IntPtr p=Marshal.AllocHGlobal(size);
    try {
      if(GetExtendedTcpTable(p,ref size,false,2,5,0)!=0) throw new Exception("Listener query failed");
      int count=Marshal.ReadInt32(p); var found=new List<string>();
      for(int i=0;i<count;i++) {
        IntPtr r=IntPtr.Add(p,4+24*i);
        int localPort=Marshal.ReadByte(r,8)*256+Marshal.ReadByte(r,9);
        if(Marshal.ReadInt32(r)==2 && localPort==port)
          found.Add(new IPAddress((uint)Marshal.ReadInt32(r,4)).ToString()+"|"+Marshal.ReadInt32(r,20));
      }
      int size6=0; GetExtendedTcpTable(IntPtr.Zero,ref size6,false,23,5,0);
      IntPtr p6=Marshal.AllocHGlobal(size6);
      try {
        if(GetExtendedTcpTable(p6,ref size6,false,23,5,0)!=0) throw new Exception("IPv6 listener query failed");
        int count6=Marshal.ReadInt32(p6);
        for(int i=0;i<count6;i++) {
          IntPtr r=IntPtr.Add(p6,4+56*i);
          int localPort=Marshal.ReadByte(r,20)*256+Marshal.ReadByte(r,21);
          if(Marshal.ReadInt32(r,48)==2 && localPort==port)
            found.Add("IPv6|"+Marshal.ReadInt32(r,52));
        }
      } finally { Marshal.FreeHGlobal(p6); }
      return found.ToArray();
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
}
function Get-BridgeIdentity($number) {
  $p=[Diagnostics.Process]::GetProcessById([int]$number)
  try { Get-BridgeHandleIdentity $p } finally { $p.Dispose() }
}
function Get-BridgeHandleIdentity($p) {
  $h=$p.Handle
  if ($p.HasExited) { throw 'Process exited' }
  @{
    id=$p.Id
    executable=[BridgeNativeMetadata]::Image($h)
    command=[BridgeNativeMetadata]::Command($h)
    workingDirectory=[IO.Path]::GetFullPath([BridgeNativeMetadata]::CurrentDirectory($h)).TrimEnd('\\')
    bridgeHome=[BridgeNativeMetadata]::EnvironmentVariable($h,'CHROME_BRIDGE_HOME')
    bridgePort=[BridgeNativeMetadata]::EnvironmentVariable($h,'CHROME_BRIDGE_PORT')
    extensionId=[BridgeNativeMetadata]::EnvironmentVariable($h,'CHROME_BRIDGE_EXTENSION_ID')
    created=$p.StartTime.ToUniversalTime().ToString('o')
  }
}
