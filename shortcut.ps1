# shortcut.ps1 — create or update the Start-menu entry for ChatGPT Fastlane, with the icon and the
# AppUserModelID the patched copy registers ("com.openai.codex.fastlane": gate G5 of the patch changes the
# app's own "com.openai.codex", otherwise Windows merges this entry with the running window under the name
# "ChatGPT"). With matching ids a pinned "ChatGPT Fastlane" taskbar button adopts the running window, so the
# taskbar shows this icon instead of a blank page. Called by patch-codex-speed.mjs --shortcut; -Read prints it.
param(
  [string]$Lnk = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\ChatGPT Fastlane.lnk'),
  [string]$Target = (Join-Path $PSScriptRoot 'launch.cmd'),
  [string]$WorkDir = $PSScriptRoot,
  [string]$Icon = (Join-Path $PSScriptRoot 'assets\chatgpt-fastlane.ico'),
  [string]$Aumid = 'com.openai.codex.fastlane',
  [switch]$Read
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
namespace ChatGptFastlane {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint c); void GetAt(uint i, out PROPERTYKEY k); void GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    void SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); void Commit();
  }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class ShellLink { }
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, int flags);
    void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short h); void SetHotkey(short h);
    void GetShowCmd(out int s); void SetShowCmd(int s);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c, out int i); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, int r); void Resolve(IntPtr h, int f);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }
  public static class Lnk {
    static PROPERTYKEY Key() { return new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; }
    public static void Write(string lnk, string target, string workDir, string icon, string desc, int showCmd, string aumid) {
      var link = (IShellLinkW)new ShellLink();
      link.SetPath(target); link.SetWorkingDirectory(workDir); link.SetIconLocation(icon, 0); link.SetDescription(desc); link.SetShowCmd(showCmd);
      var store = (IPropertyStore)link; var k = Key();
      var v = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
      store.SetValue(ref k, ref v); store.Commit(); Marshal.FreeCoTaskMem(v.p);
      ((IPersistFile)link).Save(lnk, true);
    }
    public static string Read(string lnk) {
      var link = (IShellLinkW)new ShellLink(); ((IPersistFile)link).Load(lnk, 0);
      var sb = new StringBuilder(1024); int i; link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0); string path = sb.ToString();
      link.GetIconLocation(sb, sb.Capacity, out i); string ico = sb.ToString() + "," + i;
      int show; link.GetShowCmd(out show);
      var store = (IPropertyStore)link; var k = Key(); PROPVARIANT v; store.GetValue(ref k, out v);
      string a = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "(unset)";
      return "target=" + path + "\nicon=" + ico + "\nshowCmd=" + show + "\naumid=" + a;
    }
  }
}
"@
if ($Read) { [ChatGptFastlane.Lnk]::Read($Lnk); exit 0 }
$desc = 'Codex desktop, patched copy with the Speed controls for a custom provider. Builds the installed version first if needed.'
[ChatGptFastlane.Lnk]::Write($Lnk, $Target, $WorkDir, $Icon, $desc, 7, $Aumid)   # 7 = start minimised
"Start-menu entry written: $Lnk"
[ChatGptFastlane.Lnk]::Read($Lnk)
