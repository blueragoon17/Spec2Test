param(
  [string]$ImageName = "perfectone/klee-coverage-tools:llvm18-lcov-v1",
  [switch]$PullBase
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dockerfile = Join-Path $root "docker\perfectone-klee-coverage-tools\Dockerfile"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker was not found. Install Docker Desktop first."
}

docker version | Out-Host
if ($PullBase) {
  docker pull klee/klee:v3.2
}
docker build -t $ImageName -f $dockerfile (Split-Path -Parent $dockerfile)
docker image inspect $ImageName | Out-Null
Write-Host "Prepared Docker image: $ImageName"
