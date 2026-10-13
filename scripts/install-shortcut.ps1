$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path "$PSScriptRoot\..").Path
$LauncherScript = Join-Path $Repo "scripts\sinapse-desktop.ps1"
$IconLocation = Join-Path $Repo "apps\desktop\build\icon.ico"

$WshShell = New-Object -ComObject WScript.Shell

$Target = "powershell.exe"
$Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LauncherScript`""

$Destinations = @(
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('Desktop')
)

foreach ($Dest in $Destinations) {
    if (-not [string]::IsNullOrWhiteSpace($Dest) -and (Test-Path $Dest)) {
        $ShortcutPath = Join-Path $Dest "Sinapse.lnk"
        $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
        $Shortcut.TargetPath = $Target
        $Shortcut.Arguments = $Arguments
        $Shortcut.WorkingDirectory = $Repo
        $Shortcut.IconLocation = $IconLocation
        $Shortcut.Save()
        Write-Host "Atalho Sinapse criado com sucesso em: $ShortcutPath"
    }
}
