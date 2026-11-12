param([string]$Dotnet = 'dotnet')
$ErrorActionPreference = 'Stop'
$ifzRoot = Split-Path -Parent $PSScriptRoot
$ifzLocal = Join-Path $ifzRoot '.local'
$ifzGame = Join-Path $ifzLocal 'game'
$ifzAssembly = Join-Path $ifzGame 'Infection Free Zone_Data\Managed\Ifz.dll'
$ifzHash = '56464F9C355C350D3EB274CA2E56455CA629A00A7DC02774F4E99A125009DB8F'
if ((Get-FileHash -LiteralPath $ifzAssembly).Hash -ne $ifzHash) {
    throw 'Unexpected Ifz.dll. This plugin targets Steam build 26104777.'
}

$env:DOTNET_CLI_HOME = Join-Path $ifzLocal 'dotnet-home'
$env:NUGET_PACKAGES = Join-Path $ifzLocal 'nuget'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& $Dotnet build (Join-Path $ifzRoot 'plugin\IfzMcp.csproj') -c Release -p:NuGetAudit=false
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ifzPlugins = Join-Path $ifzGame 'BepInEx\plugins'
New-Item -ItemType Directory -Path $ifzPlugins -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ifzRoot 'plugin\bin\Release\netstandard2.1\IfzMcp.dll') -Destination $ifzPlugins
