$ErrorActionPreference = 'Stop'
$ifzRoot = Split-Path -Parent $PSScriptRoot
$ifzGame = Join-Path $ifzRoot '.local\game'
$ifzExe = Join-Path $ifzGame 'Infection Free Zone.exe'
$ifzLog = Join-Path $ifzRoot '.local\Player.log'
$ifzPlugin = Join-Path $ifzGame 'BepInEx\plugins\IfzMcp.dll'
if (-not (Test-Path -LiteralPath $ifzPlugin)) { throw 'Build the test plugin first.' }
if (Get-Process -Name 'Infection Free Zone' -ErrorAction SilentlyContinue) {
    throw 'Exit the running IFZ instance from its menu before starting the test copy.'
}

$env:IFZ_MCP_TEST_COPY = '1'
$env:IFZ_MCP_USER_SID = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
    $ifzArgs = '-screen-fullscreen 0', '-screen-width 1280', '-screen-height 720', ('-logFile "' + $ifzLog + '"')
    Start-Process -FilePath $ifzExe -WorkingDirectory $ifzGame -WindowStyle Normal -PassThru -ArgumentList $ifzArgs |
        Select-Object Id, Path
} finally {
    Remove-Item Env:IFZ_MCP_TEST_COPY
    Remove-Item Env:IFZ_MCP_USER_SID
}
