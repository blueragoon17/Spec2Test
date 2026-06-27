param(
  [string]$CodexHome,
  [switch]$SkipSkillLinks,
  [switch]$SkipDoctor,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "install.mjs"
$argsList = @($script)
if ($CodexHome) { $argsList += @("--codexHome", $CodexHome) }
if ($SkipSkillLinks) { $argsList += "--skipSkillLinks" }
if ($SkipDoctor) { $argsList += "--skipDoctor" }
if ($DryRun) { $argsList += "--dryRun" }
& node @argsList
exit $LASTEXITCODE
