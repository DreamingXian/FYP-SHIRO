@echo off
rem ============================================================================
rem Starts InfluxDB so that it accepts connections from this PC only
rem (127.0.0.1:8086). The edge server and the InfluxDB web page on this PC work
rem as before; other devices on the network cannot reach it.
rem
rem influxd.exe is looked for in INFLUXD_EXE, otherwise in the folder "influxdb"
rem next to the repository (d:\RSW\FYP\influxdb\influxd.exe for this project).
rem Keep this window open while you work; close it (or press Ctrl+C) to stop.
rem ============================================================================
setlocal
if "%INFLUXD_EXE%"=="" set "INFLUXD_EXE=%~dp0..\..\..\influxdb\influxd.exe"

if not exist "%INFLUXD_EXE%" (
  echo influxd.exe not found at "%INFLUXD_EXE%".
  echo Set INFLUXD_EXE to its full path, for example:
  echo   set INFLUXD_EXE=C:\path\to\influxd.exe
  exit /b 1
)

echo Starting InfluxDB on 127.0.0.1:8086 only...
"%INFLUXD_EXE%" --http-bind-address 127.0.0.1:8086
