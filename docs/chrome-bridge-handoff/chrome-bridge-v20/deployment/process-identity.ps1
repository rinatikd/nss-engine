# Read-only native metadata; no WMI service dependency or privilege adjustment.
if (!('BridgeNativeMetadata' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Net;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BridgeNativeMetadata {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int info, IntPtr buffer, int size, out int required);
  [DllImport("iphlpapi.dll", SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);
  public static string Image(IntPtr h) {
    int size=32768; var b=new StringBuilder(size);
    if(!QueryFullProcessImageName(h,0,b,ref size)) throw new System.ComponentModel.Win32Exception();
    return b.ToString();
  }
  public static string Command(IntPtr h) {
    int size; NtQueryInformationProcess(h,60,IntPtr.Zero,0,out size);
    if(size<16 || size>1048576) throw new Exception("Command line query unavailable");
    IntPtr p=Marshal.AllocHGlobal(size);
    try { int needed; int status=NtQueryInformationProcess(h,60,p,size,out needed);
      if(status!=0) throw new Exception("Command line query denied");
      int length=(ushort)Marshal.ReadInt16(p); IntPtr text=Marshal.ReadIntPtr(p,IntPtr.Size==8?8:4);
      return Marshal.PtrToStringUni(text,length/2);
    } finally { Marshal.FreeHGlobal(p); }
  }
  public static string[] Listeners(int port) {
    int size=0; GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,5,0);
    IntPtr p=Marshal.AllocHGlobal(size);
    try { if(GetExtendedTcpTable(p,ref size,false,2,5,0)!=0) throw new Exception("Listener query failed");
      int count=Marshal.ReadInt32(p); var found=new List<string>();
      for(int i=0;i<count;i++) {IntPtr r=IntPtr.Add(p,4+24*i);
        int localPort=Marshal.ReadByte(r,8)*256+Marshal.ReadByte(r,9);
        if(Marshal.ReadInt32(r)==2 && localPort==port) found.Add(new IPAddress((uint)Marshal.ReadInt32(r,4)).ToString()+"|"+Marshal.ReadInt32(r,20));
      }
      int size6=0; GetExtendedTcpTable(IntPtr.Zero,ref size6,false,23,5,0);
      IntPtr p6=Marshal.AllocHGlobal(size6);
      try { if(GetExtendedTcpTable(p6,ref size6,false,23,5,0)!=0) throw new Exception("IPv6 listener query failed");
        int count6=Marshal.ReadInt32(p6);
        for(int i=0;i<count6;i++){IntPtr r=IntPtr.Add(p6,4+56*i);int localPort=Marshal.ReadByte(r,20)*256+Marshal.ReadByte(r,21);
          if(Marshal.ReadInt32(r,48)==2 && localPort==port) found.Add("IPv6|"+Marshal.ReadInt32(r,52));
        }
      } finally {Marshal.FreeHGlobal(p6);}
      return found.ToArray();
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
}
function Get-BridgeIdentity($number) {
  $p=[Diagnostics.Process]::GetProcessById([int]$number)
  try {
    Get-BridgeHandleIdentity $p
  } finally {$p.Dispose()}
}
function Get-BridgeHandleIdentity($p) {
  $h=$p.Handle
  if ($p.HasExited) {throw 'Process exited'}
  @{id=$p.Id;executable=[BridgeNativeMetadata]::Image($h);command=[BridgeNativeMetadata]::Command($h);created=$p.StartTime.ToUniversalTime().ToString('o')}
}

