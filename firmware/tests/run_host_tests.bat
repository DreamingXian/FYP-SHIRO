@echo off
rem =============================================================================
rem  Builds and runs the SHIRO firmware logic tests on this PC (no board needed).
rem  Needs the Visual Studio "Desktop development with C++" tools.
rem  Usage: double-click, or run from any terminal.
rem =============================================================================
setlocal
cd /d "%~dp0"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio was not found. Install it, or build with g++ as described in host_tests.cpp.
  exit /b 2
)

set "VSDIR="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo The Visual Studio C++ tools are not installed.
  exit /b 2
)

call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 exit /b 2

set "OUT=%TEMP%\shiro_host_tests"
if not exist "%OUT%" mkdir "%OUT%"

cl /nologo /EHsc /W4 /WX /std:c++17 /Fo"%OUT%\\" /Fe"%OUT%\host_tests.exe" host_tests.cpp
if errorlevel 1 (
  echo BUILD FAILED
  exit /b 1
)

"%OUT%\host_tests.exe"
exit /b %errorlevel%
