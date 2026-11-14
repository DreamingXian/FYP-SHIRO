# =============================================================================
# SHIRO wristband - records the raw pulse signal over USB into a text file.
#
# Needs wristband firmware with SHIRO_PPG_RECORDER (prints "[PPG-REC]" lines).
# Close the Arduino Serial Monitor first: only one program can use the port.
#
#   record_ppg.bat <name> [seconds] [-Led <hex>] [-Port COMx] [-NoCount]
#
#   record_ppg.bat wrist_rest 180
#   record_ppg.bat wrist_led_high 120 -Led 7F
#
# The recording is written to firmware/tools/recordings/<date>-<name>.txt
# =============================================================================
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Name,
  [Parameter(Position = 1)][int]$Seconds = 120,
  [string]$Led = '',
  [string]$Port = '',
  [switch]$NoCount
)

$ErrorActionPreference = 'Stop'

if ($Name -notmatch '^[A-Za-z0-9_-]+$') {
  Write-Host "The name may contain letters, digits, - and _ only (for example wrist_rest)." -ForegroundColor Red
  exit 1
}
if ($Seconds -lt 10 -or $Seconds -gt 600) {
  Write-Host "The duration must be between 10 and 600 seconds." -ForegroundColor Red
  exit 1
}
if ($Led -and $Led -notmatch '^[0-9A-Fa-f]{1,2}$') {
  Write-Host "-Led needs a hex value from 01 to FF (for example 7F)." -ForegroundColor Red
  exit 1
}

# ---- Find the wristband's USB serial port ------------------------------------
if (-not $Port) {
  $usbPorts = @(Get-CimInstance Win32_PnPEntity |
    Where-Object { $_.Name -match '\((COM\d+)\)' -and $_.DeviceID -like 'USB\*' })
  $espressif = @($usbPorts | Where-Object { $_.DeviceID -like '*VID_303A*' })
  $candidates = $usbPorts
  if ($espressif.Count -ge 1) { $candidates = $espressif }

  if ($candidates.Count -eq 1) {
    $null = $candidates[0].Name -match '\((COM\d+)\)'
    $Port = $Matches[1]
  } else {
    if ($candidates.Count -eq 0) {
      Write-Host "No USB serial port found. Plug in the wristband with a data cable." -ForegroundColor Red
    } else {
      Write-Host "More than one USB serial port found. Add  -Port COMx  for the wristband:" -ForegroundColor Red
      foreach ($c in $candidates) { Write-Host ("  " + $c.Name) }
    }
    exit 1
  }
}

# ---- Open the port -----------------------------------------------------------
$serial = New-Object System.IO.Ports.SerialPort($Port, 115200)
$serial.Encoding = [System.Text.Encoding]::UTF8
$serial.DtrEnable = $true
$serial.RtsEnable = $true
$serial.ReadBufferSize = 1048576
try {
  $serial.Open()
} catch {
  Write-Host "Cannot open $Port. Close the Arduino Serial Monitor and try again." -ForegroundColor Red
  Write-Host ("  " + $_.Exception.Message)
  exit 1
}

$outDir = Join-Path $PSScriptRoot 'recordings'
$null = New-Item -ItemType Directory -Force $outDir
$file = Join-Path $outDir ((Get-Date -Format 'yyyyMMdd-HHmmss') + "-$Name.txt")
$writer = $null

function Beep([int]$frequency) {
  try { [console]::Beep($frequency, 350) } catch { }
}

try {
  # ---- Start the recording on the wristband -----------------------------------
  Write-Host "Port $Port open. Asking the wristband to record $Seconds s ..."
  $text = ''
  $started = $false
  $deadline = (Get-Date).AddSeconds(25)
  $nextSend = Get-Date
  while (-not $started -and (Get-Date) -lt $deadline) {
    if ((Get-Date) -ge $nextSend) {
      if ($Led) {
        $serial.Write("led $Led`n")
        Start-Sleep -Milliseconds 200
      }
      $serial.Write("rec $Seconds`n")
      $nextSend = (Get-Date).AddSeconds(4)
    }
    Start-Sleep -Milliseconds 50
    $text += $serial.ReadExisting()
    if ($text.Contains('[PPG-REC] error')) {
      Write-Host "The wristband refused the recording (see its message in the Serial Monitor)." -ForegroundColor Red
      exit 1
    }
    $at = $text.IndexOf('[PPG-REC] start')
    if ($at -ge 0) {
      $started = $true
      $text = $text.Substring($at)
    } elseif ($text.Length -gt 20000) {
      $text = $text.Substring($text.Length - 200)
    }
  }
  if (-not $started) {
    Write-Host "The wristband did not answer." -ForegroundColor Red
    Write-Host "  Check: is the firmware with the recorder flashed? Is the Serial Monitor closed?"
    exit 1
  }

  # ---- Pulse-count window ------------------------------------------------------
  $countFrom = 0
  $countLength = 0
  if (-not $NoCount) {
    if ($Seconds -ge 90) { $countFrom = 20; $countLength = 60 }
    elseif ($Seconds -ge 55) { $countFrom = 15; $countLength = 30 }
  }

  $writer = New-Object System.IO.StreamWriter($file, $false, (New-Object System.Text.UTF8Encoding($false)))
  $writer.WriteLine("# SHIRO pulse recording")
  $writer.WriteLine("# name=$Name")
  $writer.WriteLine("# date=" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  $writer.WriteLine("# seconds=$Seconds")
  if ($Led) { $writer.WriteLine("# led_requested=0x$Led") }

  Write-Host "Recording. Keep still unless the step says otherwise." -ForegroundColor Green
  if ($countLength -gt 0) {
    Write-Host "A high beep means START counting your pulse, a low beep means STOP ($countLength s)."
  }

  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $carry = $text
  $samples = 0
  $contact = 0
  $lastIr = 0
  $done = $false
  $nextProgress = 10
  $countState = 0   # 0 = before, 1 = counting, 2 = finished

  while (-not $done) {
    $chunk = $serial.ReadExisting()
    if ($chunk.Length -gt 0) { $carry += $chunk }

    $cut = $carry.LastIndexOf("`n")
    if ($cut -ge 0) {
      $block = $carry.Substring(0, $cut + 1)
      $carry = $carry.Substring($cut + 1)
      $writer.Write($block)
      foreach ($m in [regex]::Matches($block, '(?m)^P,\d+,(\d+),')) {
        $samples++
        $lastIr = [int]$m.Groups[1].Value
        if ($lastIr -gt 50000) { $contact++ }
      }
      if ($block.Contains('[PPG-REC] end')) { $done = $true }
    }

    $elapsed = $clock.Elapsed.TotalSeconds
    if ($countLength -gt 0) {
      if ($countState -eq 0 -and $elapsed -ge $countFrom) {
        $countState = 1
        Beep 1200
        Write-Host ">>> START counting your pulse now" -ForegroundColor Yellow
      } elseif ($countState -eq 1 -and $elapsed -ge ($countFrom + $countLength)) {
        $countState = 2
        Beep 600
        Write-Host ">>> STOP counting. Remember the number." -ForegroundColor Yellow
      }
    }
    if ($elapsed -ge $nextProgress) {
      Write-Host ("{0,4:N0} s   {1,6} samples   infrared {2}" -f $elapsed, $samples, $lastIr)
      $nextProgress += 10
    }
    if ($elapsed -gt ($Seconds + 8)) {
      Write-Host "No end message from the wristband; stopping." -ForegroundColor Yellow
      break
    }
    Start-Sleep -Milliseconds 30
  }
  if ($carry.Length -gt 0) { $writer.WriteLine($carry) }

  # ---- Reference value and summary --------------------------------------------
  if ($countLength -gt 0) {
    $answer = Read-Host "How many beats did you count in the $countLength s? (Enter = not counted)"
    $beats = 0
    if ([int]::TryParse($answer, [ref]$beats) -and $beats -gt 0) {
      $bpm = [math]::Round($beats * 60 / $countLength)
      $writer.WriteLine("# pulse_count=$beats")
      $writer.WriteLine("# count_window_s=$countFrom-" + ($countFrom + $countLength))
      $writer.WriteLine("# reference_bpm=$bpm")
      Write-Host "Reference: $bpm BPM"
    } else {
      $writer.WriteLine("# pulse_count=not counted")
    }
  }

  $expected = $Seconds * 100
  Write-Host ""
  Write-Host ("Samples received: {0} of about {1}" -f $samples, $expected)
  if ($samples -lt 0.95 * $expected) {
    Write-Host "  Fewer samples than expected: mention this when you send the results." -ForegroundColor Yellow
  }
  if ($samples -gt 0) {
    $share = [math]::Round(100 * $contact / $samples)
    Write-Host "Samples with skin contact (infrared above 50000): $share %"
    if ($share -lt 90) {
      Write-Host "  The sensor did not see skin all the time: mention this when you send the results." -ForegroundColor Yellow
    }
  }
  Write-Host "Saved: $file" -ForegroundColor Green
} finally {
  if ($writer) { $writer.Dispose() }
  if ($serial.IsOpen) { $serial.Close() }
}
