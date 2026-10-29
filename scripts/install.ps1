param([string]$CodexCommand = 'codex.cmd')
$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $pluginRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    & npm.cmd run package:plugin
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
    & $CodexCommand plugin marketplace add $pluginRoot
    if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed' }
    & $CodexCommand plugin add codex-qqbot@qqbot-local
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed' }
    & $CodexCommand plugin list
} finally { Pop-Location }
