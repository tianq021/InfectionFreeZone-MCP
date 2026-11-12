# DSH 游戏聊天浮窗启动器（Windows PowerShell 5.1 兼容版）
#
# 背景：仓库里的 scripts/Start-RuntimeChat.ps1 使用 PowerShell 7 语法
# （$requires -Version 7.0、ProcessStartInfo.ArgumentList、StandardInputEncoding），
# 本机只装了 Windows PowerShell 5.1，直接跑会报错。本脚本是等价实现：
#   - 去掉 #requires 7.0
#   - 用 $info.Arguments 字符串代替 ArgumentList
#   - 只设 StandardOutputEncoding（5.1 没有 StandardInputEncoding）
#   - 发往 node 的 JSON 转成纯 ASCII 的 \uXXXX 转义，规避 5.1 stdin 编码问题
#
# 用法（必须先启动 runtime，默认端口 8790）：
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File .\handover\Start-ChatWindow-ps5.ps1 -Port 8790
#
param([ValidateRange(1, 65535)][int]$Port = 8790)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# handover 目录的上一级就是仓库根目录
$repo = Split-Path -Parent $PSScriptRoot
$chatClient = Join-Path $repo 'runtime\chat-client.mjs'
if (-not (Test-Path $chatClient)) {
    throw "找不到 chat-client: $chatClient"
}

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
$script:replyOpen = $false

function Close-Reply {
    if ($script:replyOpen) {
        $transcript.AppendText("`r`n")
        $script:replyOpen = $false
    }
}

function Add-ChatLine([string]$speaker, [string]$text) {
    Close-Reply
    $stamp = (Get-Date).ToString('HH:mm:ss')
    $transcript.AppendText("[$stamp] ${speaker}：$text`r`n")
    $transcript.ScrollToCaret()
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
        # 纯 ASCII 的 JSON（中文转 \uXXXX），避免 PS 5.1 向 node 写 stdin 时编码错乱
        $json = ($message | ConvertTo-Json -Compress)
        $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
        $worker.StandardInput.WriteLine($json)
        $pending[$requestId] = $message
        $messageBox.Clear()
        Add-ChatLine '我' $text
        $status.Text = '正在投递给 DSH…'
    } catch {
        Add-ChatLine '系统' '消息连接已中断，原文仍在输入框。'
    }
}

function Show-ChatFrame($frame) {
    switch ($frame.type) {
        'status' { $status.Text = if ($frame.connected) { 'DSH 实时连接' } else { '正在连接 DSH…' } }
        'connected' { $status.Text = 'DSH 实时连接' }
        'disconnected' { Close-Reply; $status.Text = '流式连接中断，正在重连…' }
        'turn/end' { Close-Reply; $status.Text = 'DSH 回合结束' }
        'reply_start' { Close-Reply }
        'reply_end' { Close-Reply }
        'reply_delta' {
            if (!$script:replyOpen) {
                Add-ChatLine 'DSH' ''
                $script:replyOpen = $true
            }
            $transcript.AppendText([string]$frame.text)
            $transcript.ScrollToCaret()
        }
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
            Add-ChatLine '执行器' "小队 $($frame.squadId) · $($frame.command) · $outcome"
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
    if ($null -eq $script:nextLine) { $timer.Stop(); return }
    for ($i = 0; $i -lt 128 -and $script:nextLine.IsCompleted; $i++) {
        try { $line = $script:nextLine.GetAwaiter().GetResult() } catch { $line = $null }
        if ($null -eq $line) {
            $timer.Stop()
            $script:nextLine = $null
            $status.Text = '实时连接已停止，请重开浮窗'
            return
        }
        $script:nextLine = $worker.StandardOutput.ReadLineAsync()
        Show-ChatFrame ($line | ConvertFrom-Json)
    }
})

$info = [Diagnostics.ProcessStartInfo]::new((Get-Command node.exe -CommandType Application -ErrorAction Stop).Source)
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$info.Arguments = '"{0}" {1}' -f $chatClient, $Port

try {
    $worker = [Diagnostics.Process]::Start($info)
    $worker.StandardInput.AutoFlush = $true
    $script:nextLine = $worker.StandardOutput.ReadLineAsync()
    Add-ChatLine '系统' '回车优先插话，Ctrl+回车打断 DSH 回合。'
    $timer.Start()
    [void]$window.ShowDialog()
} finally {
    $timer.Dispose()
    if ($worker) {
        try { $worker.StandardInput.Dispose() } finally { $worker.Dispose() }
    }
    $window.Dispose()
}
