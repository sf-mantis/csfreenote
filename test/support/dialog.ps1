# Answer a sequence of Windows dialogs by button caption, reporting what each said.
#
# The uninstall question can only be reached by a person clicking a box, which is
# exactly the path that stayed broken while every automated check passed. This
# drives the real dialogs so that path gets tested too.
#
#   dialog.ps1 -Want "확인,아니요"
#
# Prints one "TEXT ..." line per dialog answered, then CLICKED or TIMEOUT.
param([string]$Want, [int]$TimeoutMs = 40000, [string]$Report)

# Report to a file rather than stdout. A caller that redirects our output
# leaves us with no console, and touching [Console]::OutputEncoding then
# throws before the script does anything; writing the file ourselves also
# keeps the Korean in UTF-8 instead of the console codepage.
$lines = New-Object System.Collections.ArrayList
function Say([string]$line) {
  [void]$lines.Add($line)
  if ($Report) { [IO.File]::WriteAllLines($Report, $lines, [Text.UTF8Encoding]::new($false)) }
  else { Write-Output $line }
}

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static string Text(IntPtr h) {
    StringBuilder s = new StringBuilder(2048); GetWindowTextW(h, s, 2048); return s.ToString();
  }
  public static string Class(IntPtr h) {
    StringBuilder s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString();
  }
}
'@

# Answer one dialog carrying a button with this caption. Korean buttons come
# with an accelerator — "아니요(&N)" — so compare without it.
function Answer([string]$caption, [int]$budget) {
  $deadline = [Environment]::TickCount + $budget
  while ([Environment]::TickCount -lt $deadline) {
    $dialogs = New-Object System.Collections.ArrayList
    [void][Win]::EnumWindows({ param($h, $p)
      if ([Win]::IsWindowVisible($h) -and [Win]::Class($h) -eq '#32770') { [void]$dialogs.Add($h) }
      return $true
    }, [IntPtr]::Zero)

    foreach ($d in $dialogs) {
      $body = New-Object System.Collections.ArrayList
      $script:button = [IntPtr]::Zero
      [void][Win]::EnumChildWindows($d, { param($h, $p)
        $cls = [Win]::Class($h)
        $txt = [Win]::Text($h)
        if ($cls -eq 'Static' -and $txt) { [void]$body.Add($txt) }
        $clean = (($txt -replace '\(&.\)', '') -replace '&', '').Trim()
        if ($cls -eq 'Button' -and $clean -eq $caption) { $script:button = $h }
        return $true
      }, [IntPtr]::Zero)

      if ($script:button -ne [IntPtr]::Zero) {
        Say ('TEXT ' + (($body -join ' | ') -replace '\r?\n', ' '))
        [void][Win]::SendMessageW($script:button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
        Say ('CLICKED ' + $caption)
        return $true
      }
    }
    Start-Sleep -Milliseconds 200
  }
  # Nothing matched in time. Record what was actually on screen — a timeout
  # with no picture of the desktop is the least useful failure there is.
  Say ('TIMEOUT ' + $caption)
  [void][Win]::EnumWindows({ param($h, $p)
    if ([Win]::IsWindowVisible($h) -and [Win]::Class($h) -eq '#32770') {
      $seen = New-Object System.Collections.ArrayList
      [void][Win]::EnumChildWindows($h, { param($c, $q)
        if ([Win]::Class($c) -eq 'Button') {
          $b = [Win]::Text($c)
          if ($b) { [void]$seen.Add($b) }
        }
        return $true
      }, [IntPtr]::Zero)
      Say ('  SAW [' + [Win]::Text($h) + '] buttons: ' + ($seen -join ' / '))
    }
    return $true
  }, [IntPtr]::Zero)
  return $false
}

foreach ($caption in ($Want -split ',')) {
  if (-not (Answer $caption.Trim() $TimeoutMs)) { exit 1 }
}
exit 0
