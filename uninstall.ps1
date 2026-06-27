param(
  [string]$CodexHome,
  [switch]$ForceSkillRemoval,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "uninstall.mjs"
$argsList = @($script)
if ($CodexHome) { $argsList += @("--codexHome", $CodexHome) }
if ($ForceSkillRemoval) { $argsList += "--forceSkillRemoval" }
if ($DryRun) { $argsList += "--dryRun" }
& node @argsList
exit $LASTEXITCODE
