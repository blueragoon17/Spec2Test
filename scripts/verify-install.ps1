param(
  [string]$WorkspaceRoot
)

$ErrorActionPreference = "Stop"
$root = if ($WorkspaceRoot) { $WorkspaceRoot } else { Split-Path -Parent $PSScriptRoot }

node --check (Join-Path $root "mcp-server\src\server.js")
& (Join-Path $root "scripts\doctor.ps1") -WorkspaceRoot $root
node (Join-Path $root "scripts\check-release.mjs")
Write-Host "Spec2Test install verification completed."
