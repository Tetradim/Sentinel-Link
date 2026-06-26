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

function ConvertTo-CSharpStringLiteral {
    param([string]$Value)
    return '@"' + $Value.Replace('"', '""') + '"'
}

function Find-CSharpCompiler {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    $command = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw "C# compiler csc.exe was not found. Install .NET Framework developer tools, then rerun this installer."
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

$launcherSourcePath = Join-Path $binDir "copy-repost-native-host-launcher.cs"
$launcherExePath = Join-Path $binDir "copy-repost-native-host.exe"
$oldWrapperPath = Join-Path $binDir "copy-repost-native-host.cmd"
$manifestPath = Join-Path $manifestDir "$HostName.json"

$launcherSource = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class NativeHostLauncher
{
    private const string NodePath = $(ConvertTo-CSharpStringLiteral $node.Source);
    private const string HostScript = $(ConvertTo-CSharpStringLiteral $hostScript);
    private const string RepoRoot = $(ConvertTo-CSharpStringLiteral $RepoRoot);

    private static int Main()
    {
        var startInfo = new ProcessStartInfo();
        startInfo.FileName = NodePath;
        startInfo.Arguments = QuoteArgument(HostScript);
        startInfo.WorkingDirectory = RepoRoot;
        startInfo.UseShellExecute = false;
        startInfo.RedirectStandardInput = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.CreateNoWindow = true;

        using (var process = new Process())
        {
            process.StartInfo = startInfo;
            process.Start();

            var inputThread = StartCopyThread(Console.OpenStandardInput(), process.StandardInput.BaseStream, true);
            var outputThread = StartCopyThread(process.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
            var errorThread = StartCopyThread(process.StandardError.BaseStream, Console.OpenStandardError(), false);

            process.WaitForExit();
            outputThread.Join(1000);
            errorThread.Join(1000);
            return process.ExitCode;
        }
    }

    private static Thread StartCopyThread(Stream input, Stream output, bool closeOutput)
    {
        var thread = new Thread(() => CopyStream(input, output, closeOutput));
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static void CopyStream(Stream input, Stream output, bool closeOutput)
    {
        var buffer = new byte[81920];
        try
        {
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, read);
                output.Flush();
            }
        }
        catch (IOException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
        finally
        {
            if (closeOutput)
            {
                try { output.Close(); } catch { }
            }
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
"@
Set-Content -Path $launcherSourcePath -Value $launcherSource -Encoding ASCII

$csc = Find-CSharpCompiler
$compilerArgs = @(
    "/nologo",
    "/target:exe",
    "/optimize+",
    "/out:$launcherExePath",
    $launcherSourcePath
)
& $csc @compilerArgs
if ($LASTEXITCODE -ne 0) {
    throw "Failed to compile native host launcher with $csc"
}

Remove-Item -LiteralPath $oldWrapperPath -Force -ErrorAction SilentlyContinue

$manifest = @"
{
  "name": "$HostName",
  "description": "Discord Copy Repost native lifecycle host",
  "path": "$(ConvertTo-JsonEscaped $launcherExePath)",
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
Write-Step "Launcher: $launcherExePath"
Write-Step "Reload the unpacked Copy/Repost extension in chrome://extensions."
