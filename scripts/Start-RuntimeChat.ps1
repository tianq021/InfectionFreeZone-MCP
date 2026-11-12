#requires -Version 7.0
param([ValidateRange(1, 65535)][int]$Port = 8790)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot

. (Join-Path $repo 'scripts\ChatTranscript.ps1')

$window = [Windows.Forms.Form]::new()
$window.Text = 'DSH 游戏聊天'
$window.TopMost = $true
$window.Size = [Drawing.Size]::new(640, 520)
$window.MinimumSize = [Drawing.Size]::new(380, 260)
$window.StartPosition = 'CenterScreen'

$status = [Windows.Forms.Label]::new()
$status.Text = '正在连接 DSH…'
$status.Dock = 'Top'
$status.Height = 24

$transcript = [Windows.Forms.RichTextBox]::new()
$transcript.Dock = 'Fill'
$transcript.ReadOnly = $true
$transcript.DetectUrls = $false

$composer = [Windows.Forms.Panel]::new()
$composer.Dock = 'Bottom'
$composer.Height = 30
$messageBox = [Windows.Forms.TextBox]::new()
$messageBox.Dock = 'Fill'
$messageBox.MaxLength = 4000
$sendButton = [Windows.Forms.Button]::new()
$sendButton.Dock = 'Right'
$sendButton.Text = '发送'
$composer.Controls.Add($messageBox)
$composer.Controls.Add($sendButton)
$window.Controls.Add($transcript)
$window.Controls.Add($composer)
$window.Controls.Add($status)

$pending = @{}

function Add-ChatLine([string]$speaker, [string]$text) {
    Add-ChatEntry $chatHistory $speaker $text
}

function Send-ChatMessage([bool]$interrupt) {
    $text = $messageBox.Text.Trim()
    if (!$text -or !$script:nextLine) { return }

    $requestId = [guid]::NewGuid().ToString()
    foreach ($item in $pending.Values) {
        if ($item.failed -and $item.text -ceq $text -and $item.interrupt -eq $interrupt) {
            $requestId = $item.requestId
            break
        }
    }
    $message = @{ requestId = $requestId; text = $text; interrupt = $interrupt }
    try {
        $worker.StandardInput.WriteLine(($message | ConvertTo-Json -Compress))
        $pending[$requestId] = $message
        $messageBox.Clear()
        Add-ChatLine '我' $text
        $status.Text = '正在投递给 DSH…'
    } catch {
        Add-ChatLine '系统' '消息连接已中断，原文仍在输入框。'
    }
    Update-ChatTranscript $chatHistory $transcript
}

function Show-ChatFrame($frame) {
    switch ($frame.type) {
        'status' { $status.Text = if ($frame.connected) { 'DSH 实时连接' } else { '正在连接 DSH…' } }
        'connected' { $status.Text = 'DSH 实时连接' }
        'disconnected' { Complete-ChatReply $chatHistory; $status.Text = '流式连接中断，正在重连…' }
        'turn/end' { Complete-ChatReply $chatHistory; $status.Text = 'DSH 回合结束' }
        'reply_start' { Complete-ChatReply $chatHistory }
        'reply_end' { Complete-ChatReply $chatHistory }
        'reply_delta' { Add-ChatReplyText $chatHistory ([string]$frame.text) }
        'accepted' {
            if ($pending.ContainsKey([string]$frame.requestId) -or $frame.claimed) {
                $status.Text = if ($frame.claimed) { 'DSH 已读入对话' } else { 'DSH 已收件，等待读入对话' }
            }
            $pending.Remove([string]$frame.requestId)
            if ($frame.interruptError) { Add-ChatLine '系统' '打断未确认，已按优先消息投递。' }
        }
        'message_claimed' {
            $pending.Remove([string]$frame.requestId)
            $status.Text = 'DSH 已读入对话'
        }
        'send_error' {
            $message = $pending[[string]$frame.requestId]
            if ($message) {
                $message.failed = $true
                if (!$messageBox.Text) { $messageBox.Text = $message.text }
                Add-ChatLine '系统' "投递未确认（$($frame.code)）。原文和原快捷键可重试。"
            }
        }
        'action_finished' {
            $outcome = switch ($frame.state) {
                'succeeded' { '完成' }
                'failed' { '失败' }
                'canceled' { '已取消' }
                default { '结果待确认' }
            }
            $reason = if ($frame.reason) { " · $($frame.reason)" } else { '' }
            $remaining = if ($frame.remainingOrders) { ' · 小队仍有其他订单' } else { '' }
            Add-ChatLine '执行器' "小队 $($frame.squadId) · $($frame.command) · $outcome$reason$remaining"
        }
    }
}

$sendButton.Add_Click({ Send-ChatMessage $false })
$messageBox.Add_KeyDown({
    if ($_.KeyCode -eq [Windows.Forms.Keys]::Enter) {
        $_.SuppressKeyPress = $true
        Send-ChatMessage $_.Control
    }
})

$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 50
$timer.Add_Tick({
    for ($i = 0; $i -lt 128 -and $script:nextLine.IsCompleted; $i++) {
        try { $line = $script:nextLine.GetAwaiter().GetResult() } catch { $line = $null }
        if ($null -eq $line) {
            $timer.Stop()
            $script:nextLine = $null
            Complete-ChatReply $chatHistory
            Update-ChatTranscript $chatHistory $transcript
            $status.Text = '实时连接已停止，请重开浮窗'
            return
        }
        $script:nextLine = $worker.StandardOutput.ReadLineAsync()
        Show-ChatFrame ($line | ConvertFrom-Json)
    }
    Update-ChatTranscript $chatHistory $transcript
    if ($chatHistory.LogFailed) { $window.Text = 'DSH 游戏聊天（日志写入失败）' }
})

$info = [Diagnostics.ProcessStartInfo]::new((Get-Command node.exe -CommandType Application -ErrorAction Stop).Source)
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
$info.StandardOutputEncoding = $info.StandardInputEncoding
$info.ArgumentList.Add((Join-Path $repo 'runtime\chat-client.mjs'))
$info.ArgumentList.Add([string]$Port)

try {
    $chatHistory = New-ChatTranscript (Join-Path $repo '.local\logs\chat')
    $worker = [Diagnostics.Process]::Start($info)
    $worker.StandardInput.AutoFlush = $true
    $script:nextLine = $worker.StandardOutput.ReadLineAsync()
    Add-ChatLine '系统' '回车优先插话，Ctrl+回车打断 DSH 回合。'
    Update-ChatTranscript $chatHistory $transcript
    $timer.Start()
    [void]$window.ShowDialog()
} finally {
    $timer.Dispose()
    Close-ChatTranscript $chatHistory
    if ($worker) {
        try { $worker.StandardInput.Dispose() } finally { $worker.Dispose() }
    }
    $window.Dispose()
}
