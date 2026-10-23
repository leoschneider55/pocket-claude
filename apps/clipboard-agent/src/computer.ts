import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ComputerAction, ComputerResult, ScreenImage } from '@pocket/protocol';
import { keyCode, parseKeys } from './keys.js';
import type { ScreenWatchHost, WatchCapture, WatchSample } from './watch.js';

/** Computer use on this machine: one step at a time, in physical desktop pixels. */
export interface ComputerBackend {
  act(action: ComputerAction): Promise<ComputerResult>;
  /** The kill switch: drops queued steps, ends the one in flight and lets go of every key and button. */
  release(): void;
  close(): void;
}

/** Screenshot size that suits computer use: big enough to read, small enough for quick turns. */
export const SHOT_MAX = { width: 1280, height: 800 };
export const ZOOM_MAX = { width: 1600, height: 1200 };

/** What the PowerShell host reads, one JSON line per step. Key names are already codes here. */
export type HostCommand =
  | { op: 'screenshot'; display: number; maxWidth: number; maxHeight: number }
  | { op: 'zoom'; x: number; y: number; width: number; height: number; maxWidth: number; maxHeight: number }
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; at: boolean; button: string; count: number; mods: number[] }
  | { op: 'button'; button: string; down: boolean }
  | { op: 'drag'; path: number[]; button: string }
  | { op: 'scroll'; x: number; y: number; at: boolean; dx: number; dy: number; mods: number[] }
  | { op: 'type'; text: string }
  | { op: 'keys'; combos: number[][]; holdMs: number }
  | { op: 'cursor' }
  | { op: 'windows' }
  | { op: 'window'; handle: string; what: string }
  | { op: 'open'; target: string; args: string }
  | { op: 'watchSample'; display: number }
  | { op: 'watchCapture'; display: number }
  | { op: 'release' };

const mods = (names: readonly string[] | undefined) => (names ?? []).map((n) => keyCode(n));
const at = (x: number | undefined, y: number | undefined) => x !== undefined && y !== undefined;

export function hostCommand(a: ComputerAction): HostCommand {
  switch (a.action) {
    case 'screenshot':
      return { op: 'screenshot', display: a.display ?? -1, maxWidth: a.maxWidth ?? SHOT_MAX.width, maxHeight: a.maxHeight ?? SHOT_MAX.height };
    case 'zoom':
      return { op: 'zoom', x: a.x, y: a.y, width: a.width, height: a.height, maxWidth: a.maxWidth ?? ZOOM_MAX.width, maxHeight: a.maxHeight ?? ZOOM_MAX.height };
    case 'move':
      return { op: 'move', x: a.x, y: a.y };
    case 'click':
      return { op: 'click', x: a.x ?? 0, y: a.y ?? 0, at: at(a.x, a.y), button: a.button, count: a.count, mods: mods(a.modifiers) };
    case 'button':
      return { op: 'button', button: a.button, down: a.down };
    case 'drag':
      return { op: 'drag', path: a.path.flat(), button: a.button ?? 'left' };
    case 'scroll':
      return { op: 'scroll', x: a.x ?? 0, y: a.y ?? 0, at: at(a.x, a.y), dx: a.dx, dy: a.dy, mods: mods(a.modifiers) };
    case 'type':
      return { op: 'type', text: a.text };
    case 'key':
      return { op: 'keys', combos: parseKeys(a.keys), holdMs: a.holdMs ?? 0 };
    case 'cursor':
      return { op: 'cursor' };
    case 'windows':
      return { op: 'windows' };
    case 'window':
      return { op: 'window', handle: a.handle, what: a.op };
    case 'open':
      return { op: 'open', target: a.target, args: a.args ?? '' };
    case 'release':
      return { op: 'release' };
  }
}

/** How long a step may take before the host is presumed stuck and restarted. */
export function timeoutFor(c: HostCommand): number {
  if (c.op === 'type') return 10_000 + c.text.length * 20;
  if (c.op === 'keys') return 10_000 + c.combos.length * (c.holdMs + 100);
  if (c.op === 'drag') return 10_000 + c.path.length * 200;
  return 20_000;
}

/**
 * The host: Windows PowerShell 5.1 with a C# helper compiled once by Add-Type (C# 5: no newer syntax), then a loop
 * of JSON lines. Per-monitor DPI awareness keeps every coordinate in physical pixels. ASCII only and no backticks:
 * PowerShell reads a BOM-less file in the ANSI code page, and this lives in a template literal.
 */
/** Add-Type in Windows PowerShell 5.1 compiles C# 5; keep the helper free of newer syntax and unsafe code. */
export const COMPUTER_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PocketComputer {
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  const uint WHEEL = 0x0800, HWHEEL = 0x1000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
  const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;
  const int EXT = 0x100, CHAR = 0x10000;
  const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_RETURN = 0x0D, VK_TAB = 0x09, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetDC(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)] static extern int ReleaseDC(IntPtr handle, IntPtr dc);
  [DllImport("gdi32.dll", SetLastError = true)] static extern int SetStretchBltMode(IntPtr dc, int mode);
  [DllImport("gdi32.dll", SetLastError = true)] static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr old);
  [DllImport("gdi32.dll", SetLastError = true)] static extern bool StretchBlt(IntPtr dst, int dx, int dy, int dw, int dh, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char ch, IntPtr layout);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

  struct KeyCode { public ushort Vk; public bool Ext; public KeyCode(ushort vk, bool ext) { Vk = vk; Ext = ext; } }
  class Display { public RECT R; public bool Primary; public double Scale; }

  static ImageCodecInfo jpeg;

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
    try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
  }

  static string Q(string s) {
    StringBuilder b = new StringBuilder(s.Length + 2);
    b.Append('"');
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c == '\n') b.Append("\\n");
      else if (c == '\r') b.Append("\\r");
      else if (c == '\t') b.Append("\\t");
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static List<Display> Displays() {
    List<Display> list = new List<Display>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFOEX info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (GetMonitorInfo(h, ref info)) {
        Display m = new Display();
        m.R = info.rcMonitor;
        m.Primary = (info.dwFlags & 1) != 0;
        m.Scale = 1.0;
        try {
          uint dx, dy;
          if (GetDpiForMonitor(h, 0, out dx, out dy) == 0 && dx > 0) m.Scale = dx / 96.0;
        } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
        list.Add(m);
      }
      return true;
    }, IntPtr.Zero);
    list.Sort(delegate(Display a, Display b) {
      if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
      if (a.R.Left != b.R.Left) return a.R.Left.CompareTo(b.R.Left);
      return a.R.Top.CompareTo(b.R.Top);
    });
    if (list.Count == 0) throw new InvalidOperationException("No display found");
    return list;
  }

  static string DisplaysJson(List<Display> list) {
    StringBuilder b = new StringBuilder("[");
    for (int i = 0; i < list.Count; i++) {
      RECT r = list[i].R;
      if (i > 0) b.Append(',');
      b.Append("{\"index\":").Append(i).Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
        .Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top)
        .Append(",\"primary\":").Append(list[i].Primary ? "true" : "false")
        .Append(",\"scale\":").Append(list[i].Scale.ToString("0.###", CultureInfo.InvariantCulture)).Append('}');
    }
    return b.Append(']').ToString();
  }

  static int DisplayOf(List<Display> list, int x, int y) {
    for (int i = 0; i < list.Count; i++) {
      RECT r = list[i].R;
      if (x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom) return i;
    }
    return -1;
  }

  static string CursorJson() {
    POINT p;
    GetCursorPos(out p);
    return "{\"x\":" + p.X + ",\"y\":" + p.Y + "}";
  }

  public static string Cursor() { return "{\"cursor\":" + CursorJson() + "}"; }

  static string Jpeg(Bitmap bmp) {
    if (jpeg == null) foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
    using (EncoderParameters p = new EncoderParameters(1)) {
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
      using (MemoryStream ms = new MemoryStream()) {
        bmp.Save(ms, jpeg, p);
        return Convert.ToBase64String(ms.ToArray());
      }
    }
  }

  static void DrawCursor(Graphics g, int ox, int oy) {
    CURSORINFO ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0 || ci.hCursor == IntPtr.Zero) return;
    int hx = 0, hy = 0;
    ICONINFO ii;
    if (GetIconInfo(ci.hCursor, out ii)) {
      hx = ii.xHotspot;
      hy = ii.yHotspot;
      if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
      if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
    }
    IntPtr hdc = g.GetHdc();
    try { DrawIconEx(hdc, ci.pt.X - ox - hx, ci.pt.Y - oy - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(hdc); }
  }

  /** The part of the desktop at x,y,w,h with the pointer drawn in, shrunk to fit maxW x maxH. */
  static string Capture(int x, int y, int w, int h, int maxW, int maxH) {
    using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) {
        // .NET Framework rejects SourceCopy | CaptureBlt as an undefined CopyPixelOperation value: plain SourceCopy only.
        g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        DrawCursor(g, x, y);
      }
      double k = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
      int ow = Math.Max(1, (int)Math.Round(w * k));
      int oh = Math.Max(1, (int)Math.Round(h * k));
      string data;
      if (ow == w && oh == h) {
        data = Jpeg(full);
      } else {
        using (Bitmap small = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
          using (Graphics g2 = Graphics.FromImage(small)) {
            g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g2.DrawImage(full, 0, 0, ow, oh);
          }
          data = Jpeg(small);
        }
      }
      return "\"image\":{\"mime\":\"image/jpeg\",\"dataBase64\":\"" + data + "\",\"width\":" + ow + ",\"height\":" + oh + "}"
        + ",\"region\":{\"x\":" + x + ",\"y\":" + y + ",\"width\":" + w + ",\"height\":" + h + "}";
    }
  }

  public static string Screenshot(int display, int maxW, int maxH) {
    List<Display> mons = Displays();
    int i = display < 0 ? 0 : display;
    if (i >= mons.Count) throw new ArgumentException("There is no display " + display + ": this computer has " + mons.Count + ".");
    RECT r = mons[i].R;
    return "{" + Capture(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, maxW, maxH) + ",\"displays\":" + DisplaysJson(mons) + ",\"cursor\":" + CursorJson() + "}";
  }

  static bool InputDesktopLocked() {
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return true;
    try {
      StringBuilder name = new StringBuilder(128);
      int needed;
      if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return true;
      return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
    } finally { CloseDesktop(desktop); }
  }

  static string ForegroundMetadata() {
    IntPtr h = GetForegroundWindow();
    int length = h == IntPtr.Zero ? 0 : Math.Min(2048, GetWindowTextLength(h));
    StringBuilder title = new StringBuilder(length + 1);
    if (length > 0) GetWindowText(h, title, title.Capacity);
    uint pid = 0;
    if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);
    string process = "";
    if (pid != 0) {
      try { using (Process p = Process.GetProcessById((int)pid)) process = p.ProcessName; }
      catch (ArgumentException) { } catch (InvalidOperationException) { } catch (Win32Exception) { }
    }
    return "\"windowTitle\":" + Q(title.ToString()) + ",\"processName\":" + Q(process);
  }

  static byte[] GraySample(RECT r) {
    const int width = 160, height = 90;
    using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb)) {
      using (Graphics graphics = Graphics.FromImage(bitmap)) {
        IntPtr dst = graphics.GetHdc();
        try {
          IntPtr src = GetDC(IntPtr.Zero);
          if (src == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the desktop");
          try {
            SetStretchBltMode(dst, 4);
            SetBrushOrgEx(dst, 0, 0, IntPtr.Zero);
            if (!StretchBlt(dst, 0, 0, width, height, src, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, 0x00CC0020))
              throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not sample the desktop");
          } finally { ReleaseDC(IntPtr.Zero, src); }
        } finally { graphics.ReleaseHdc(dst); }
      }
      BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try {
        int stride = Math.Abs(data.Stride);
        byte[] rgba = new byte[stride * height];
        byte[] gray = new byte[width * height];
        Marshal.Copy(data.Scan0, rgba, 0, rgba.Length);
        for (int y = 0; y < height; y++) {
          int row = data.Stride >= 0 ? y * stride : (height - 1 - y) * stride;
          for (int x = 0; x < width; x++) {
            int i = row + x * 4;
            gray[y * width + x] = (byte)((rgba[i + 2] * 299 + rgba[i + 1] * 587 + rgba[i] * 114) / 1000);
          }
        }
        return gray;
      } finally { bitmap.UnlockBits(data); }
    }
  }

  public static string WatchSample(int display) {
    if (InputDesktopLocked()) return "{\"locked\":true}";
    List<Display> mons = Displays();
    if (display >= mons.Count) throw new ArgumentException("There is no display " + display + ".");
    RECT r = mons[display].R;
    byte[] sample = GraySample(r);
    if (InputDesktopLocked()) return "{\"locked\":true}";
    return "{\"locked\":false,\"pixelsBase64\":" + Q(Convert.ToBase64String(sample))
      + ",\"width\":160,\"height\":90,\"display\":" + display + "," + ForegroundMetadata() + "}";
  }

  public static string WatchCapture(int display) {
    if (InputDesktopLocked()) return "{\"locked\":true}";
    List<Display> mons = Displays();
    if (display >= mons.Count) throw new ArgumentException("There is no display " + display + ".");
    RECT r = mons[display].R;
    string image = Capture(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, 1280, 800);
    if (InputDesktopLocked()) return "{\"locked\":true}";
    return "{\"locked\":false," + image + ",\"display\":" + display + "," + ForegroundMetadata() + "}";
  }

  public static string Zoom(int x, int y, int w, int h, int maxW, int maxH) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int left = Math.Max(vx, x), top = Math.Max(vy, y);
    int right = Math.Min(vx + vw, x + w), bottom = Math.Min(vy + vh, y + h);
    if (right - left < 4 || bottom - top < 4) throw new ArgumentException("That region is outside the screen");
    return "{" + Capture(left, top, right - left, bottom - top, maxW, maxH) + ",\"cursor\":" + CursorJson() + "}";
  }

  static void Send(params INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows blocked the input: a window running as administrator, a UAC prompt or the lock screen is in front");
  }

  static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dx = dx;
    i.u.mi.dy = dy;
    i.u.mi.mouseData = data;
    i.u.mi.dwFlags = flags;
    return i;
  }

  static INPUT Key(ushort vk, bool up, bool ext) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.u.ki.dwFlags = (up ? KEY_UP : 0) | (ext ? KEY_EXTENDED : 0);
    return i;
  }

  static INPUT Unicode(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEY_UNICODE | (up ? KEY_UP : 0);
    return i;
  }

  static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    Send(Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny, 0));
    SetCursorPos(x, y);
  }

  static uint ButtonFlag(string button, bool down) {
    if (button == "right") return down ? RIGHTDOWN : RIGHTUP;
    if (button == "middle") return down ? MIDDLEDOWN : MIDDLEUP;
    return down ? LEFTDOWN : LEFTUP;
  }

  static List<KeyCode> Resolve(int[] codes) {
    List<KeyCode> keys = new List<KeyCode>();
    if (codes == null) return keys;
    uint pid;
    IntPtr layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), out pid));
    foreach (int c in codes) {
      if ((c & CHAR) == 0) { keys.Add(new KeyCode((ushort)(c & 0xFF), (c & EXT) != 0)); continue; }
      char ch = (char)(c & 0xFFFF);
      short r = VkKeyScanEx(ch, layout);
      if (r == -1) throw new ArgumentException("The keyboard layout in use has no key for '" + ch + "'");
      int state = (r >> 8) & 0xFF;
      if ((state & 1) != 0) AddOnce(keys, VK_SHIFT);
      if ((state & 2) != 0) AddOnce(keys, VK_CONTROL);
      if ((state & 4) != 0) AddOnce(keys, VK_MENU);
      keys.Add(new KeyCode((ushort)(r & 0xFF), false));
    }
    return keys;
  }

  static void AddOnce(List<KeyCode> keys, ushort vk) {
    foreach (KeyCode k in keys) if (k.Vk == vk) return;
    keys.Add(new KeyCode(vk, false));
  }

  static List<KeyCode> Press(int[] codes) {
    List<KeyCode> down = new List<KeyCode>();
    foreach (KeyCode k in Resolve(codes)) {
      Send(Key(k.Vk, false, k.Ext));
      down.Add(k);
      Thread.Sleep(10);
    }
    return down;
  }

  static void Lift(List<KeyCode> down) {
    for (int i = down.Count - 1; i >= 0; i--) {
      Send(Key(down[i].Vk, true, down[i].Ext));
      Thread.Sleep(5);
    }
  }

  public static string Move(int x, int y) {
    MoveTo(x, y);
    return Cursor();
  }

  public static string Click(int x, int y, bool at, string button, int count, int[] mods) {
    if (at) { MoveTo(x, y); Thread.Sleep(40); }
    List<KeyCode> held = Press(mods);
    try {
      int n = Math.Max(1, Math.Min(3, count));
      for (int i = 0; i < n; i++) {
        if (i > 0) Thread.Sleep(70);
        Send(Mouse(ButtonFlag(button, true), 0, 0, 0), Mouse(ButtonFlag(button, false), 0, 0, 0));
      }
    } finally { Lift(held); }
    return Cursor();
  }

  public static string Button(string button, bool down) {
    Send(Mouse(ButtonFlag(button, down), 0, 0, 0));
    return Cursor();
  }

  public static string Drag(int[] path, string button) {
    if (path == null || path.Length < 4) throw new ArgumentException("A drag needs a start and an end point");
    MoveTo(path[0], path[1]);
    Thread.Sleep(50);
    Send(Mouse(ButtonFlag(button, true), 0, 0, 0));
    try {
      int cx = path[0], cy = path[1];
      for (int i = 2; i + 1 < path.Length; i += 2) {
        int tx = path[i], ty = path[i + 1];
        double dist = Math.Sqrt((double)(tx - cx) * (tx - cx) + (double)(ty - cy) * (ty - cy));
        int steps = Math.Max(4, Math.Min(40, (int)(dist / 20)));
        for (int s = 1; s <= steps; s++) {
          MoveTo(cx + (tx - cx) * s / steps, cy + (ty - cy) * s / steps);
          Thread.Sleep(12);
        }
        cx = tx;
        cy = ty;
      }
      Thread.Sleep(60);
    } finally { Send(Mouse(ButtonFlag(button, false), 0, 0, 0)); }
    return Cursor();
  }

  public static string Scroll(int x, int y, bool at, int dx, int dy, int[] mods) {
    if (at) { MoveTo(x, y); Thread.Sleep(30); }
    List<KeyCode> held = Press(mods);
    try {
      for (int i = 0; i < Math.Abs(dy); i++) { Send(Mouse(WHEEL, 0, 0, unchecked((uint)(dy > 0 ? -120 : 120)))); Thread.Sleep(20); }
      for (int i = 0; i < Math.Abs(dx); i++) { Send(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx > 0 ? 120 : -120)))); Thread.Sleep(20); }
    } finally { Lift(held); }
    return Cursor();
  }

  public static string TypeText(string text) {
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\r') {
        if (i + 1 < text.Length && text[i + 1] == '\n') continue;
        c = '\n';
      }
      if (c == '\n') Send(Key(VK_RETURN, false, false), Key(VK_RETURN, true, false));
      else if (c == '\t') Send(Key(VK_TAB, false, false), Key(VK_TAB, true, false));
      else Send(Unicode(c, false), Unicode(c, true));
      Thread.Sleep(c == '\n' ? 30 : 4);
    }
    return Cursor();
  }

  public static string Keys(int[] codes, int holdMs) {
    List<KeyCode> held = Press(codes);
    try { Thread.Sleep(holdMs > 0 ? holdMs : 30); } finally { Lift(held); }
    return Cursor();
  }

  public static string Windows() {
    IntPtr front = GetForegroundWindow();
    List<Display> mons = Displays();
    List<IntPtr> handles = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { handles.Add(h); return true; }, IntPtr.Zero);
    StringBuilder b = new StringBuilder("{\"windows\":[");
    bool first = true;
    foreach (IntPtr h in handles) {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) continue;
      if ((GetWindowLong(h, -20) & 0x80) != 0) continue;
      try {
        int cloaked;
        if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) continue;
      } catch (DllNotFoundException) { }
      int len = GetWindowTextLength(h);
      if (len <= 0) continue;
      StringBuilder title = new StringBuilder(len + 1);
      GetWindowText(h, title, title.Capacity);
      RECT r;
      GetWindowRect(h, out r);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { using (Process p = Process.GetProcessById((int)pid)) proc = p.ProcessName; } catch (ArgumentException) { } catch (InvalidOperationException) { }
      bool minimized = IsIconic(h);
      int display = minimized ? -1 : DisplayOf(mons, (r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2);
      if (!first) b.Append(',');
      first = false;
      b.Append("{\"handle\":").Append(Q(h.ToInt64().ToString(CultureInfo.InvariantCulture)))
        .Append(",\"title\":").Append(Q(title.ToString())).Append(",\"process\":").Append(Q(proc))
        .Append(",\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
        .Append(",\"width\":").Append(Math.Max(0, r.Right - r.Left)).Append(",\"height\":").Append(Math.Max(0, r.Bottom - r.Top))
        .Append(",\"minimized\":").Append(minimized ? "true" : "false").Append(",\"maximized\":").Append(IsZoomed(h) ? "true" : "false")
        .Append(",\"focused\":").Append(h == front ? "true" : "false");
      if (display >= 0) b.Append(",\"display\":").Append(display);
      b.Append('}');
    }
    return b.Append("],\"displays\":").Append(DisplaysJson(mons)).Append('}').ToString();
  }

  static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(100); }
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    uint pid;
    uint frontThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    if (frontThread != 0 && frontThread != me && AttachThreadInput(me, frontThread, true)) {
      try { BringWindowToTop(h); SetForegroundWindow(h); } finally { AttachThreadInput(me, frontThread, false); }
    }
    if (GetForegroundWindow() == h) return true;
    // Windows keeps background processes from taking the foreground; a synthetic Alt press lifts that lock.
    Send(Key(VK_MENU, false, false));
    SetForegroundWindow(h);
    Send(Key(VK_MENU, true, false));
    Thread.Sleep(50);
    return GetForegroundWindow() == h;
  }

  public static string Window(long handle, string what) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) throw new ArgumentException("That window no longer exists; list the windows again");
    string text;
    if (what == "focus") text = Focus(h) ? "The window is now in front." : "Windows did not bring the window to the front; click it instead.";
    else if (what == "minimize") { ShowWindow(h, 6); text = "Minimized."; }
    else if (what == "maximize") { ShowWindow(h, 3); Focus(h); text = "Maximized."; }
    else if (what == "restore") { ShowWindow(h, 9); Focus(h); text = "Restored."; }
    else if (what == "close") {
      PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      Thread.Sleep(400);
      text = IsWindow(h) ? "Asked the window to close; it is still open, maybe asking to save." : "Closed.";
    } else throw new ArgumentException("Unknown window operation: " + what);
    return "{\"text\":" + Q(text) + "}";
  }

  // A program the shell cannot find by name (not on PATH, e.g. "telegram") is looked up among the Start menu shortcuts.
  static string StartMenuShortcut(string name) {
    string want = name.Trim().ToLowerInvariant();
    if (want.Length == 0 || want.IndexOfAny(new char[] { '\\', '/', ':' }) >= 0) return null;
    string best = null;
    int bestRank = int.MaxValue;
    string[] roots = { Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu) };
    foreach (string root in roots) {
      if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
      string[] links;
      try { links = Directory.GetFiles(root, "*.lnk", SearchOption.AllDirectories); } catch (Exception) { continue; }
      foreach (string link in links) {
        string n = Path.GetFileNameWithoutExtension(link).ToLowerInvariant();
        if (n.Contains("uninstall")) continue;
        int rank = n == want ? 0 : n.StartsWith(want) ? 1 : n.Contains(want) ? 2 : -1;
        if (rank < 0) continue;
        rank = rank * 1000 + n.Length;
        if (rank < bestRank) { bestRank = rank; best = link; }
      }
    }
    return best;
  }

  public static string Open(string target, string args) {
    try {
      return StartTarget(target, args);
    } catch (Win32Exception e) {
      string link = e.NativeErrorCode == 2 ? StartMenuShortcut(target) : null;
      if (link == null) throw new ArgumentException("Could not open " + target + ": " + e.Message);
      try {
        return StartTarget(link, args);
      } catch (Win32Exception e2) {
        throw new ArgumentException("Could not open " + target + ": " + e2.Message);
      }
    }
  }

  static string StartTarget(string target, string args) {
    ProcessStartInfo info = new ProcessStartInfo(target);
    if (!string.IsNullOrEmpty(args)) info.Arguments = args;
    info.UseShellExecute = true;
    info.WindowStyle = ProcessWindowStyle.Normal;
    info.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    using (Process p = Process.Start(info)) {
      return "{\"text\":" + Q(p != null ? "Started " + target + " (process " + p.Id + ")." : "Opened " + target + ".") + "}";
    }
  }

  public static string ReleaseAll() {
    ushort[] mods = { VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
    foreach (ushort vk in mods) {
      try { Send(Key(vk, true, vk == VK_LWIN || vk == VK_RWIN || vk == 0xA3 || vk == 0xA5)); } catch (Win32Exception) { }
    }
    int[] buttons = { 0x01, 0x02, 0x04 };
    uint[] ups = { LEFTUP, RIGHTUP, MIDDLEUP };
    for (int i = 0; i < buttons.Length; i++) {
      if ((GetAsyncKeyState(buttons[i]) & 0x8000) == 0) continue;
      try { Send(Mouse(ups[i], 0, 0, 0)); } catch (Win32Exception) { }
    }
    return "{\"text\":\"Let go of all keys and mouse buttons.\"}";
  }
}
'@
[PocketComputer]::Init()

function Num($v, $d) { if ($null -eq $v) { return $d }; return [int]$v }
function Codes($v) { if ($null -eq $v) { return ,([int[]]@()) }; return ,([int[]]@($v)) }

function Invoke-Op($c) {
  switch ([string]$c.op) {
    'screenshot' { return [PocketComputer]::Screenshot((Num $c.display -1), (Num $c.maxWidth 1280), (Num $c.maxHeight 800)) }
    'watchSample' { return [PocketComputer]::WatchSample((Num $c.display 0)) }
    'watchCapture' { return [PocketComputer]::WatchCapture((Num $c.display 0)) }
    'zoom' { return [PocketComputer]::Zoom([int]$c.x, [int]$c.y, [int]$c.width, [int]$c.height, (Num $c.maxWidth 1600), (Num $c.maxHeight 1200)) }
    'move' { return [PocketComputer]::Move([int]$c.x, [int]$c.y) }
    'click' { return [PocketComputer]::Click((Num $c.x 0), (Num $c.y 0), [bool]$c.at, [string]$c.button, (Num $c.count 1), (Codes $c.mods)) }
    'button' { return [PocketComputer]::Button([string]$c.button, [bool]$c.down) }
    'drag' { return [PocketComputer]::Drag((Codes $c.path), [string]$c.button) }
    'scroll' { return [PocketComputer]::Scroll((Num $c.x 0), (Num $c.y 0), [bool]$c.at, (Num $c.dx 0), (Num $c.dy 0), (Codes $c.mods)) }
    'type' { return [PocketComputer]::TypeText([string]$c.text) }
    'keys' {
      $out = $null
      foreach ($combo in @($c.combos)) {
        $out = [PocketComputer]::Keys((Codes $combo), (Num $c.holdMs 0))
        Start-Sleep -Milliseconds 40
      }
      return $out
    }
    'cursor' { return [PocketComputer]::Cursor() }
    'windows' { return [PocketComputer]::Windows() }
    'window' { return [PocketComputer]::Window([long]$c.handle, [string]$c.what) }
    'open' { return [PocketComputer]::Open([string]$c.target, [string]$c.args) }
    'release' { return [PocketComputer]::ReleaseAll() }
    default { throw ('Unknown operation: ' + $c.op) }
  }
}

function Send-Line([string]$s) {
  [Console]::Out.WriteLine($s)
  [Console]::Out.Flush()
}

Send-Line '{"ready":true}'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [int]$req.id
    $json = Invoke-Op $req.cmd
    Send-Line ('{"id":' + $id + ',"ok":true,"result":' + $json + '}')
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Send-Line ('{"id":' + $id + ',"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$e.Message) -Compress) + '}')
  }
}
`;

const POWERSHELL = { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File'] };
const START_TIMEOUT_MS = 60_000;

type Pending = { resolve: (r: ComputerResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type RawWatchSample = { locked: boolean; pixelsBase64?: string; width?: number; height?: number };
type RawWatchCapture = { locked: boolean; image?: ScreenImage; windowTitle?: string; processName?: string; display?: number };

/** Keeps the PowerShell host running and feeds it one step at a time. */
export class ComputerHost implements ComputerBackend, ScreenWatchHost {
  private child: ChildProcess | undefined;
  private starting: Promise<ChildProcess> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  /** Bumped by release(): steps queued before it are dropped. */
  private epoch = 0;
  private inFlight = 0;
  private used = false;
  private closed = false;

  constructor(
    private readonly opts: {
      /** Path of the host script; the caller writes COMPUTER_PS there. */
      script: string;
      log: (m: string) => void;
      spawn?: typeof nodeSpawn;
      shell?: { command: string; args: string[] };
    },
  ) {}

  act(action: ComputerAction): Promise<ComputerResult> {
    const epoch = this.epoch;
    const step = async (): Promise<ComputerResult> => {
      if (epoch !== this.epoch) throw new Error('Stopped by the user.');
      const cmd = hostCommand(action);
      this.inFlight++;
      try {
        return await this.call(cmd, timeoutFor(cmd));
      } finally {
        this.inFlight--;
      }
    };
    return this.enqueue(step);
  }

  sample(display: number): Promise<WatchSample> {
    return this.watchCall({ op: 'watchSample', display }).then((value) => {
      const result = value as ComputerResult & RawWatchSample;
      if (result.locked) return { locked: true };
      if (typeof result.pixelsBase64 !== 'string' || result.width !== 160 || result.height !== 90) {
        throw new Error('The computer returned an invalid screen sample');
      }
      const pixels = Uint8Array.from(Buffer.from(result.pixelsBase64, 'base64'));
      if (pixels.length !== result.width * result.height) throw new Error('The computer returned an incomplete screen sample');
      return { locked: false, pixels, width: result.width, height: result.height };
    });
  }

  capture(display: number): Promise<WatchCapture> {
    return this.watchCall({ op: 'watchCapture', display }).then((value) => {
      const result = value as ComputerResult & RawWatchCapture;
      if (result.locked) return { locked: true };
      const image = result.image;
      if (!image || image.mime !== 'image/jpeg' || !image.dataBase64 || image.dataBase64.length > 4_000_000 ||
        image.width < 1 || image.height < 1 || image.width > 1280 || image.height > 800 ||
        typeof result.windowTitle !== 'string' || typeof result.processName !== 'string' || !Number.isInteger(result.display) || result.display! < 0) {
        throw new Error('The computer returned an invalid watch frame');
      }
      return { locked: false, image: { ...image, mime: 'image/jpeg' }, windowTitle: result.windowTitle, processName: result.processName, display: result.display };
    });
  }

  isBusy(): boolean {
    return this.queued > 0;
  }

  release(): void {
    this.epoch++;
    if (!this.used) return;
    // A step in flight may be typing a long text; ending the host stops it at once, a fresh one lets go of the keys.
    if (this.inFlight > 0) this.stopChild('stopped by the user');
    void this.call({ op: 'release' }, 20_000).catch((e: Error) => this.opts.log(`computer: release failed: ${e.message}`));
  }

  close(): void {
    this.closed = true;
    this.stopChild('PocketClipboard is closing');
  }

  private call(cmd: HostCommand, timeoutMs: number): Promise<ComputerResult> {
    return this.ensure().then(
      (child) =>
        new Promise<ComputerResult>((resolve, reject) => {
          const id = this.nextId++;
          const timer = setTimeout(() => {
            if (!this.pending.delete(id)) return;
            reject(new Error('The computer did not finish the step in time'));
            this.stopChild(`step ${cmd.op} timed out`);
          }, timeoutMs);
          this.pending.set(id, { resolve, reject, timer });
          child.stdin?.write(`${JSON.stringify({ id, cmd })}\n`);
        }),
    );
  }

  private watchCall(cmd: HostCommand): Promise<ComputerResult> {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (epoch !== this.epoch) throw new Error('Stopped by the user.');
      this.inFlight++;
      try {
        return await this.call(cmd, 20_000);
      } finally {
        this.inFlight--;
      }
    });
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.chain.then(step, step).finally(() => { this.queued--; });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private ensure(): Promise<ChildProcess> {
    if (this.closed) return Promise.reject(new Error('PocketClipboard is closing'));
    if (this.child && !this.starting) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.used = true;
    const spawn = this.opts.spawn ?? nodeSpawn;
    const shell = this.opts.shell ?? POWERSHELL;
    const child = spawn(shell.command, [...shell.args, this.opts.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let errors = '';
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The computer control helper did not start'));
        this.stopChild('start timed out');
      }, START_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not start PowerShell: ${e.message}`));
      });
      child.stdin?.on('error', () => {});
      child.stderr && createInterface({ input: child.stderr }).on('line', (line) => {
        if (!line.trim()) return;
        errors = `${errors}${line.trim()}\n`.slice(-2000);
        this.opts.log(`computer: ${line.trim()}`);
      });
      child.stdout &&
        createInterface({ input: child.stdout }).on('line', (raw) => {
          const line = raw.replace(/^\uFEFF/, '').trim();
          if (!line) return;
          let msg: { ready?: boolean; id?: number; ok?: boolean; result?: ComputerResult; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            this.opts.log(`computer: ${line.slice(0, 200)}`);
            return;
          }
          if (msg.ready) {
            clearTimeout(timer);
            if (this.child === child) this.starting = undefined;
            resolve(child);
            return;
          }
          const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
          if (!p || msg.id === undefined) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result ?? {});
          else p.reject(new Error(msg.error || 'The step failed'));
        });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = undefined;
          this.starting = undefined;
        }
        reject(new Error(`The computer control helper stopped (code ${code})${errors ? `: ${errors.trim().split('\n').pop()}` : ''}`));
        this.failPending(`The computer control helper stopped (code ${code})`);
      });
    });
    return this.starting;
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private stopChild(reason: string): void {
    const child = this.child;
    if (!child) return;
    this.opts.log(`computer: restarting the helper (${reason})`);
    this.child = undefined;
    this.starting = undefined;
    this.failPending(reason === 'stopped by the user' ? 'Stopped by the user.' : `The computer control helper was restarted: ${reason}`);
    child.kill();
  }
}
