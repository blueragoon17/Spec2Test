param(
  [string]$WorkspaceRoot,
  [string]$PerfectOneCli,
  [string]$CodexHome,
  [string]$HostOs,
  [switch]$FailOnDuplicateRegistration
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "doctor.mjs"
$argsList = @($script)
if ($WorkspaceRoot) { $argsList += @("--workspaceRoot", $WorkspaceRoot) }
if ($PerfectOneCli) { $argsList += @("--perfectoneCli", $PerfectOneCli) }
if ($CodexHome) { $argsList += @("--codexHome", $CodexHome) }
if ($HostOs) { $argsList += @("--hostOs", $HostOs) }
if ($FailOnDuplicateRegistration) { $argsList += "--failOnDuplicateRegistration" }
& node @argsList
exit $LASTEXITCODE
