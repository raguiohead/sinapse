$ErrorActionPreference = "Stop"

$Repo = (Resolve-Path "$PSScriptRoot\..").Path
$Source = Join-Path $Repo "skill\sinapse"
$ClaudeSkillsDir = Join-Path $env:USERPROFILE ".claude\skills"
$Target = Join-Path $ClaudeSkillsDir "sinapse"

if (-not (Test-Path $ClaudeSkillsDir)) {
    New-Item -ItemType Directory -Force -Path $ClaudeSkillsDir | Out-Null
}

if (Test-Path $Target) {
    $item = Get-Item $Target -Force
    if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
        $cleanCurrent = ($item.Target -join "").TrimEnd("\", "/")
        $cleanSource = $Source.TrimEnd("\", "/")
        if ($cleanCurrent -ieq $cleanSource) {
            Write-Host "O skill sinapse já está vinculado corretamente ($Target -> $Source)."
            exit 0
        } else {
            Write-Error "Erro: $Target já existe como $($item.LinkType) apontando para outro destino ($($item.Target)). Operação cancelada."
            exit 1
        }
    } else {
        Write-Error "Erro: $Target já existe e não é uma junção ou link simbólico para este repositório. Operação cancelada."
        exit 1
    }
}

New-Item -ItemType Junction -Path $Target -Target $Source | Out-Null
Write-Host "Skill sinapse vinculado com sucesso: $Target -> $Source"
