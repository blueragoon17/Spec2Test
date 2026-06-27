param(
  [switch]$InstallDocker,
  [switch]$InstallLLVM,
  [switch]$PrepareDockerImage,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Confirm-Step($Message) {
  if ($Yes) { return $true }
  $answer = Read-Host "$Message [y/N]"
  return $answer -match '^(y|yes)$'
}

if ($InstallDocker) {
  if (Confirm-Step "Install Docker Desktop with winget?") {
    winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
  }
}

if ($InstallLLVM) {
  if (Confirm-Step "Install LLVM for Windows with winget?") {
    winget install --id LLVM.LLVM -e --source winget --accept-package-agreements --accept-source-agreements
  }
}

if ($PrepareDockerImage) {
  if (Confirm-Step "Build the PerfectOne KLEE coverage Docker image?") {
    & (Join-Path $PSScriptRoot "setup-docker-image.ps1") -PullBase
  }
}

& (Join-Path $PSScriptRoot "doctor.ps1")
