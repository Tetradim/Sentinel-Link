param(
    [string]$ExtensionId = "bfnjhgnbompdhdakmfohoahoohalkhpi",
    [string]$HostName = "com.tetradim.discord_copy_repost",
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
    $RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
} else {
    $RepoRoot = Resolve-Path $RepoRoot
}

function Write-Step {
    param([string]$Message)
    Write-Host "[copy-repost-native-host] $Message"
}

function ConvertTo-JsonEscaped {
    param([string]$Value)
    return $Value.Replace("\", "\\")
}

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    $node = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $node) {
    throw "Node.js was not found on PATH. Install Node.js, then rerun this installer."
}

$hostScript = Join-Path $RepoRoot "apps\native-host\src\main.js"
if (-not (Test-Path -LiteralPath $hostScript)) {
    throw "Native host script not found: $hostScript"
}

$binDir = Join-Path $RepoRoot "apps\native-host\bin"
$manifestDir = Join-Path $RepoRoot "apps\native-host\native-messaging"
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null

$wrapperPath = Join-Path $binDir "copy-repost-native-host.cmd"
$manifestPath = Join-Path $manifestDir "$HostName.json"

$wrapper = @"
@echo off
setlocal
"$($node.Source)" "$hostScript"
"@
Set-Content -Path $wrapperPath -Value $wrapper -Encoding ASCII

$manifest = @"
{
  "name": "$HostName",
  "description": "Discord Copy Repost native lifecycle host",
  "path": "$(ConvertTo-JsonEscaped $wrapperPath)",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@
Set-Content -Path $manifestPath -Value $manifest -Encoding ASCII

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Step "Registered $HostName for Chrome extension $ExtensionId"
Write-Step "Manifest: $manifestPath"
Write-Step "Wrapper:  $wrapperPath"
Write-Step "Reload the unpacked Copy/Repost extension in chrome://extensions."
