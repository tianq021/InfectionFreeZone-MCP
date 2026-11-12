function New-ChatTranscript([string]$logDirectory) {
    [void][IO.Directory]::CreateDirectory($logDirectory)
    $fileName = 'chat-{0:yyyyMMdd-HHmmss-fff}-{1}.log' -f (Get-Date), $PID
    $path = Join-Path $logDirectory $fileName
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $log = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    $log.AutoFlush = $true
    [pscustomobject]@{
        Messages = [Collections.Generic.Queue[object]]::new()
        Reply = $null
        Dirty = $false
        Log = $log
        LogPath = $path
        LogFailed = $false
    }
}

function New-ChatEntry($history, [string]$speaker, [string]$text) {
    $entry = [pscustomobject]@{
        Timestamp = Get-Date
        Speaker = $speaker
        Text = [Text.StringBuilder]::new($text)
    }
    $history.Messages.Enqueue($entry)
    if ($history.Messages.Count -gt 50) { [void]$history.Messages.Dequeue() }
    $history.Dirty = $true
    $entry
}

function Write-ChatEntry($history, $entry) {
    try {
        $history.Log.WriteLine(('[{0:yyyy-MM-dd HH:mm:ss.fff zzz}] {1}: {2}' -f $entry.Timestamp, $entry.Speaker, $entry.Text))
    } catch {
        if (!$history.LogFailed) {
            Write-Warning "Could not write chat log: $($history.LogPath)"
        }
        $history.LogFailed = $true
    }
}

function Add-ChatEntry($history, [string]$speaker, [string]$text) {
    $entry = New-ChatEntry $history $speaker $text
    Write-ChatEntry $history $entry
}

function Add-ChatReplyText($history, [string]$text) {
    if (!$text) { return }
    if (!$history.Reply) { $history.Reply = New-ChatEntry $history 'DSH' '' }
    [void]$history.Reply.Text.Append($text)
    $history.Dirty = $true
}

function Complete-ChatReply($history) {
    if ($history.Reply) {
        Write-ChatEntry $history $history.Reply
        $history.Reply = $null
    }
}

function Close-ChatTranscript($history) {
    if (!$history) { return }
    Complete-ChatReply $history
    try {
        $history.Log.Dispose()
    } catch {
        Write-Warning "Could not close chat log: $($history.LogPath)"
    }
}

function Update-ChatTranscript($history, $view) {
    if (!$history.Dirty) { return }
    $text = [Text.StringBuilder]::new()
    foreach ($entry in $history.Messages) {
        [void]$text.AppendLine(('[{0:HH:mm:ss}] {1}: {2}' -f $entry.Timestamp, $entry.Speaker, $entry.Text))
    }
    $view.Text = $text.ToString()
    $view.SelectionStart = $view.TextLength
    $view.ScrollToCaret()
    $history.Dirty = $false
}
