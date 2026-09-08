# Drop csFreeNote's entry from the uninstall list.
#
# Deleting the install folder is not enough to get back to never-installed:
# the entry left behind points at an uninstaller that is no longer there, and
# the next install aborts before it starts.
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'csFreeNote*' } |
  ForEach-Object { Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
