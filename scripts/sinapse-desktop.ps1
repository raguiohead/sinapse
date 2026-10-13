$ErrorActionPreference = "Continue"

$Repo = (Resolve-Path "$PSScriptRoot\..").Path
$SinapseDir = Join-Path $env:USERPROFILE ".sinapse"
$Log = Join-Path $SinapseDir "desktop.log"

if (-not (Test-Path $SinapseDir)) {
    New-Item -ItemType Directory -Force -Path $SinapseDir | Out-Null
}

$Timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
"=== $Timestamp ===" | Out-File -FilePath $Log -Append -Encoding utf8

Set-Location (Join-Path $Repo "apps\desktop")

npx electron-vite build *>> $Log
if ($LASTEXITCODE -ne 0) {
    "build falhou; abrindo o último build" | Out-File -FilePath $Log -Append -Encoding utf8
}

npx electron . *>> $Log
