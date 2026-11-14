@echo off
rem SHIRO wristband: records the raw pulse signal over USB. See record_ppg.ps1.
rem   record_ppg.bat <name> [seconds] [-Led <hex>] [-Port COMx] [-NoCount]
if "%~1"=="" (
  echo Usage: record_ppg.bat ^<name^> [seconds] [-Led ^<hex^>] [-Port COMx] [-NoCount]
  echo Example: record_ppg.bat wrist_rest 180
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0record_ppg.ps1" %*
