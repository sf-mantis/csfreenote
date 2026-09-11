# Put the machine's csFreeNote registry entries aside, and back afterwards.
#
# The installer check installs and uninstalls for real. Both write the same two
# places a real install uses - the per-user install key, named after the app id,
# and the entry Windows lists in Add/Remove - and the check's own cleanup
# deletes anything there whose name starts with csFreeNote.
#
# On a machine where somebody actually uses csFreeNote, that is their entry. The
# program itself would survive, but it would vanish from Add/Remove and the next
# upgrade would no longer know where it lives. So the entries are exported
# before the check and put back when it ends.
#
# Deliberately ASCII only. Windows PowerShell reads a .ps1 without a byte order
# mark in the system codepage, so non-ASCII here comes back as mojibake and can
# unbalance a quote. The Korean belongs in the Node side, which prints it.
#
# Usage: keep-registry.ps1 -Action save|restore -Dir <folder>

param(
  [Parameter(Mandatory = $true)][ValidateSet('save', 'restore')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'
$UninstallPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$UninstallKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$manifest = Join-Path $Dir 'keys.txt'

function Get-OurUninstallEntries {
  Get-ItemProperty "$UninstallPath\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'csFreeNote*' }
}

function Remove-OurUninstallEntries {
  Get-OurUninstallEntries | ForEach-Object {
    Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Save-Keys {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  if (Test-Path $manifest) { Remove-Item $manifest -Force }

  $found = @()
  # The Add/Remove entry, found by what it calls itself rather than by key name.
  Get-OurUninstallEntries | ForEach-Object { $found += "$UninstallKey\$($_.PSChildName)" }
  # The install key, found by where it says the program is.
  Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | ForEach-Object {
    $v = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($v.InstallLocation -like '*csfreenote*') { $found += "HKCU\Software\$($_.PSChildName)" }
  }
  $found = @($found | Select-Object -Unique)

  $n = 0
  foreach ($key in $found) {
    $file = Join-Path $Dir ('key' + $n + '.reg')
    & reg.exe export $key $file /y | Out-Null
    Add-Content -Path $manifest -Value $key -Encoding UTF8
    $n += 1
  }
  Write-Output ('saved ' + $n)
}

function Restore-Keys {
  # Whatever is there now may be the check's own leftovers, so clear first.
  Remove-OurUninstallEntries

  if (-not (Test-Path $manifest)) {
    # Nothing was installed before the check, and nothing should be after it.
    Write-Output 'restored 0'
    return
  }

  $n = 0
  $done = 0
  foreach ($key in (Get-Content $manifest -Encoding UTF8)) {
    if (-not $key.Trim()) { continue }
    $file = Join-Path $Dir ('key' + $n + '.reg')
    if (Test-Path $file) {
      # No stderr redirect. Windows PowerShell wraps a native command's stderr
      # in an error record even when it succeeded, and with Stop in force that
      # ended the loop after the first key - leaving the rest unrestored.
      & reg.exe import $file | Out-Null
      $done += 1
    }
    $n += 1
  }
  Write-Output ('restored ' + $done)
}

if ($Action -eq 'save') { Save-Keys } else { Restore-Keys }
