param(
    [Parameter(Mandatory)]
    [string]$GameRoot
)

$ErrorActionPreference = 'Stop'
$ifzRoot = Split-Path -Parent $PSScriptRoot
$ifzGame = (Resolve-Path -LiteralPath $GameRoot).Path
$ifzExe = Join-Path $ifzGame 'Infection Free Zone.exe'
$ifzSteamApps = Split-Path -Parent (Split-Path -Parent $ifzGame)
$ifzAssembly = Join-Path $ifzGame 'Infection Free Zone_Data\Managed\Ifz.dll'
$ifzHash = '56464F9C355C350D3EB274CA2E56455CA629A00A7DC02774F4E99A125009DB8F'
if (-not (Test-Path -LiteralPath $ifzExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $ifzSteamApps 'appmanifest_1465460.acf') -PathType Leaf)) {
    throw 'Pass the Steam installation directory for Infection Free Zone.'
}
if ((Get-FileHash -LiteralPath $ifzAssembly).Hash -ne $ifzHash) {
    throw 'Unsupported game assembly. This plugin targets Steam build 26104777.'
}
if (Get-Process -Name 'Infection Free Zone' -ErrorAction SilentlyContinue | Where-Object Path -eq $ifzExe) {
    throw 'Exit the Steam game before installing or upgrading the plugin.'
}

$ifzPlugin = Join-Path $ifzRoot 'plugin\bin\Release\netstandard2.1\IfzMcp.dll'
if (-not (Test-Path -LiteralPath $ifzPlugin -PathType Leaf)) {
    throw 'Build the plugin before installing it.'
}
$ifzArchive = Join-Path $ifzRoot '.local\tools\BepInEx_win_x64_5.4.23.2.zip'
$ifzStage = Join-Path $ifzRoot '.local\steam-bepinex'
if (Test-Path -LiteralPath $ifzStage) {
    Remove-Item -LiteralPath $ifzStage -Recurse -Force
}
Expand-Archive -LiteralPath $ifzArchive -DestinationPath $ifzStage -Force

$ifzLoader = 'winhttp.dll'
$ifzLoaderFiles = @('.doorstop_version', 'doorstop_config.ini') + @(
    Get-ChildItem -LiteralPath (Join-Path $ifzStage 'BepInEx\core') -File |
        ForEach-Object { Join-Path 'BepInEx\core' $_.Name }
)
foreach ($ifzRelativePath in $ifzLoaderFiles + $ifzLoader) {
    $ifzSource = Join-Path $ifzStage $ifzRelativePath
    $ifzTarget = Join-Path $ifzGame $ifzRelativePath
    if ((Test-Path -LiteralPath $ifzTarget) -and
        (Get-FileHash -LiteralPath $ifzTarget).Hash -ne (Get-FileHash -LiteralPath $ifzSource).Hash) {
        throw "Existing loader file differs: $ifzTarget"
    }
}

$ifzSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ifzMarker = Join-Path $ifzGame 'BepInEx\config\ifz-mcp-steam.sid'
$ifzDestination = Join-Path $ifzGame 'BepInEx\plugins\IfzMcp.dll'
$ifzManagedInstall = Test-Path -LiteralPath $ifzMarker -PathType Leaf
if ($ifzManagedInstall -and (Get-Content -Raw -LiteralPath $ifzMarker).Trim() -ne $ifzSid) {
    throw 'The existing IFZ MCP Steam installation belongs to a different Windows user.'
}
if ((Test-Path -LiteralPath $ifzDestination) -and -not $ifzManagedInstall -and
    (Get-FileHash -LiteralPath $ifzDestination).Hash -ne (Get-FileHash -LiteralPath $ifzPlugin).Hash) {
    throw "Existing unmanaged plugin differs: $ifzDestination"
}

foreach ($ifzRelativePath in $ifzLoaderFiles) {
    $ifzTarget = Join-Path $ifzGame $ifzRelativePath
    if (-not (Test-Path -LiteralPath $ifzTarget)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $ifzTarget) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $ifzStage $ifzRelativePath) -Destination $ifzTarget
    }
}
New-Item -ItemType Directory -Path (Split-Path -Parent $ifzDestination), (Split-Path -Parent $ifzMarker) -Force | Out-Null
Copy-Item -LiteralPath $ifzPlugin -Destination $ifzDestination
if (-not $ifzManagedInstall) {
    [IO.File]::WriteAllText($ifzMarker, $ifzSid)
}
$ifzLoaderTarget = Join-Path $ifzGame $ifzLoader
if (-not (Test-Path -LiteralPath $ifzLoaderTarget)) {
    Copy-Item -LiteralPath (Join-Path $ifzStage $ifzLoader) -Destination $ifzLoaderTarget
}

[pscustomobject]@{
    GameRoot = $ifzGame
    Plugin = $ifzDestination
    Mode = 'steam'
    Build = 26104777
}
