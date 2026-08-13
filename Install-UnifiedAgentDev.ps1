[CmdletBinding()]
param(
    [string]$Agents = "auto",
    [string]$HomePath = $env:USERPROFILE,
    [switch]$DryRun,
    [switch]$SkipHostCommands
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "Unified Agent Dev 0.1.0 supports Windows only."
}

Push-Location $PSScriptRoot
try {
    $installArguments = @(
        (Join-Path $PSScriptRoot "runtime\cli.mjs"),
        "install",
        "--agents", $Agents,
        "--home", $HomePath,
        "--allow-unsigned-development"
    )
    if ($DryRun) { $installArguments += "--dry-run" }
    if ($SkipHostCommands) { $installArguments += "--skip-host-commands" }
    & node @installArguments
    if ($LASTEXITCODE -ne 0) { throw "installation failed" }
}
finally {
    Pop-Location
}
