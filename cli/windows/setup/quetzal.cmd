@echo off
rem Quetzal command line (installed as <Root>\bin\quetzal.cmd; <Root>\bin is on the user PATH):
rem   quetzal status | open | run | logs [-f] | start | stop | restart | rollback | uninstall [--purge]
rem Runs "<node.txt>" <Root>\runtime\<current.txt>\quetzal.mjs. The two pointer files are UTF-8; read them under code page 65001.
setlocal
for %%I in ("%~dp0..") do set "QUETZAL_ROOT=%%~fI"
set "_QZ_CP="
for /f "tokens=2 delims=:." %%a in ('chcp') do set "_QZ_CP=%%a"
chcp 65001 >nul
set "QZ_NODE="
set "QZ_CUR="
set /p QZ_NODE=<"%QUETZAL_ROOT%\node.txt"
set /p QZ_CUR=<"%QUETZAL_ROOT%\runtime\current.txt"
if defined _QZ_CP chcp %_QZ_CP% >nul
if not defined QZ_NODE (echo Quetzal: %QUETZAL_ROOT%\node.txt is missing; rerun the installer. 1>&2 & exit /b 1)
if not exist "%QZ_NODE%" (echo Quetzal: Node.js not found at %QZ_NODE%; rerun the installer. 1>&2 & exit /b 1)
if not exist "%QUETZAL_ROOT%\runtime\%QZ_CUR%\quetzal.mjs" (echo Quetzal: %QUETZAL_ROOT%\runtime\%QZ_CUR%\quetzal.mjs is missing; rerun the installer. 1>&2 & exit /b 1)
"%QZ_NODE%" "%QUETZAL_ROOT%\runtime\%QZ_CUR%\quetzal.mjs" %*
exit /b %ERRORLEVEL%
