@ECHO off
SETLOCAL
SET "DIR=%~dp0"

IF EXIST "%DIR%..\app.asar.unpacked\node_modules\@sinapse\cli\dist\main.js" (
  SET "MAIN=%DIR%..\app.asar.unpacked\node_modules\@sinapse\cli\dist\main.js"
) ELSE IF EXIST "%DIR%app.asar.unpacked\node_modules\@sinapse\cli\dist\main.js" (
  SET "MAIN=%DIR%app.asar.unpacked\node_modules\@sinapse\cli\dist\main.js"
) ELSE IF EXIST "%DIR%..\..\packages\cli\dist\main.js" (
  SET "MAIN=%DIR%..\..\packages\cli\dist\main.js"
) ELSE (
  ECHO Erro: ponto de entrada do Sinapse CLI nao encontrado. >&2
  EXIT /B 1
)

node "%MAIN%" %*
