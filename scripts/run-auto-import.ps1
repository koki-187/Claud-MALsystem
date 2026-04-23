# =============================================================================
# TERASS-PICKS Auto Import (PowerShell wrapper for Task Scheduler)
# =============================================================================
# 役割:
#   1. Chrome を CDP モードで起動 (既に起動中なら skip)
#   2. CDP エンドポイント (localhost:9222) が応答するまで待機 (最大 30s)
#   3. auto-import-terass.sh を呼び出し (extract → convert → import → fallback)
#   4. このスクリプトで起動した Chrome のみ終了 (既存 Chrome は触らない)
#
# 設計判断:
#   - run-auto-import.bat は extract-terass.mjs を直接呼んでいたため fallback が無効化されていた。
#     こちらは auto-import-terass.sh 経由で fallback ロジックを保持する。
#   - 既存 Chrome を巻き込まないよう、自前で起動した Process.Id のみ Stop-Process する。
#   - Task Scheduler から呼ぶ際は "ログオンしているかどうかにかかわらず実行" + "/RL HIGHEST" 推奨。
# =============================================================================

$ErrorActionPreference = 'Continue'  # 個別エラーで全体停止しないように
$LogFile = 'C:\Users\reale\Downloads\terass_cron.log'
$LogMaxBytes = 5MB                     # 5MB 超で日付付きアーカイブにローテーション
$LogRetainDays = 30                    # 30日以上前のローテーションログを削除
$ProjectDir = 'C:\Users\reale\Downloads\mal-worker'
$BashExe = 'C:\Program Files\Git\bin\bash.exe'
$ChromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$UserDataDir = "$env:APPDATA\Chrome_CDP"
$CdpPort = 9222
$WaitTimeoutSec = 30

# ログローテーション: 起動時に LogFile が閾値超なら日付付きにリネーム + 古いものを削除
function Invoke-LogRotation {
    if (Test-Path $LogFile) {
        $size = (Get-Item $LogFile).Length
        if ($size -ge $LogMaxBytes) {
            $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
            $rotated = "$LogFile.$stamp"
            Move-Item -Path $LogFile -Destination $rotated -Force
        }
    }
    # 古いローテーションログを削除
    $logDir = Split-Path -Parent $LogFile
    $logBase = Split-Path -Leaf $LogFile
    Get-ChildItem -Path $logDir -Filter "$logBase.*" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LogRetainDays) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
Invoke-LogRotation

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$timestamp] [run-auto-import.ps1] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Test-CdpReady {
    try {
        # IPv4 固定: localhost だと IPv6 (::1) を試して Chrome の IPv4 リスナーに届かずタイムアウトする
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

Write-Log '======================================================================'
Write-Log 'TERASS auto-import 開始'

# Step 1: Chrome CDP 起動チェック
$ownChromeProcId = $null
if (Test-CdpReady) {
    Write-Log "Chrome CDP は既に :$CdpPort で起動中。既存セッションを利用します。"
} else {
    Write-Log "Chrome CDP 未起動。新規起動します (--user-data-dir=$UserDataDir)"
    if (-not (Test-Path $ChromeExe)) {
        Write-Log "ERROR: Chrome が見つかりません: $ChromeExe"
        exit 2
    }
    $proc = Start-Process -FilePath $ChromeExe -ArgumentList @(
        "--remote-debugging-port=$CdpPort",
        "--user-data-dir=$UserDataDir",
        'https://picks-agent.terass.com/search/mansion'
    ) -PassThru -WindowStyle Minimized
    $ownChromeProcId = $proc.Id
    Write-Log "Chrome 起動: PID=$ownChromeProcId"

    # Step 2: CDP 応答待ち
    $waited = 0
    while (-not (Test-CdpReady) -and $waited -lt $WaitTimeoutSec) {
        Start-Sleep -Seconds 2
        $waited += 2
    }
    if (-not (Test-CdpReady)) {
        Write-Log "ERROR: $WaitTimeoutSec 秒待っても CDP が応答しません。中止。"
        if ($ownChromeProcId) {
            Stop-Process -Id $ownChromeProcId -Force -ErrorAction SilentlyContinue
        }
        exit 3
    }
    Write-Log "CDP 応答 OK (待機 ${waited}s)"
}

# Step 2.5: .env から ADMIN_SECRET をプロセス環境に注入 (converter の Bearer 認証用)
$EnvFile = Join-Path $ProjectDir '.env'
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$') {
            $name = $matches[1]
            $value = $matches[2] -replace '^["'']|["'']$', ''
            [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
            Write-Log ".env から $name を注入 (length=$($value.Length))"
        }
    }
} else {
    Write-Log "WARNING: .env が見つかりません ($EnvFile) — ADMIN_SECRET 未設定の可能性"
}

# Step 3: auto-import-terass.sh 実行 (fallback ロジックを含む)
Write-Log 'auto-import-terass.sh を実行中...'
$bashCmd = "cd '$($ProjectDir -replace '\\', '/')' && export `$(grep -v '^#' .env 2>/dev/null | xargs) ; ./scripts/auto-import-terass.sh"
& $BashExe -lc $bashCmd 2>&1 | ForEach-Object {
    Add-Content -Path $LogFile -Value $_ -Encoding UTF8
}
$importExitCode = $LASTEXITCODE
Write-Log "auto-import-terass.sh 終了コード: $importExitCode"

# Step 4: 自前で起動した Chrome のみクリーンアップ (グレースフル終了でセッション永続化)
# 重要: Stop-Process -Force だと Chrome が Cookies SQLite を書き出す前に殺され、
#       次回起動時にログインセッションが失われる。CloseMainWindow で WM_CLOSE を送り、
#       Chrome に正常終了させてから (最大 15 秒待機)、それでも残っていたら force kill する。
if ($ownChromeProcId) {
    Write-Log "起動した Chrome (PID=$ownChromeProcId) をグレースフル終了します (セッション永続化)"
    try {
        $proc = Get-Process -Id $ownChromeProcId -ErrorAction Stop
        $closed = $proc.CloseMainWindow()
        if ($closed) {
            Write-Log "WM_CLOSE 送信成功。Chrome の正常終了を待機 (最大 15 秒)..."
            $waited = 0
            while (-not $proc.HasExited -and $waited -lt 15) {
                Start-Sleep -Milliseconds 500
                $waited += 0.5
                $proc.Refresh()
            }
            if ($proc.HasExited) {
                Write-Log "Chrome 正常終了 (待機 ${waited}s) — セッション永続化完了"
            } else {
                Write-Log "WARNING: 15 秒経っても Chrome が終了しないため force kill します"
                Stop-Process -Id $ownChromeProcId -Force -ErrorAction SilentlyContinue
            }
        } else {
            Write-Log "WARNING: CloseMainWindow が false を返しました (メインウィンドウなし?)。force kill します"
            Stop-Process -Id $ownChromeProcId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Log "WARNING: グレースフル終了に失敗 ($($_.Exception.Message))。force kill にフォールバック"
        Stop-Process -Id $ownChromeProcId -Force -ErrorAction SilentlyContinue
    }
    # 子プロセス (renderer 等) も終了させるため少し待つ
    Start-Sleep -Seconds 2
}

Write-Log "TERASS auto-import 終了 (exit=$importExitCode)"
Write-Log '======================================================================'
exit $importExitCode
