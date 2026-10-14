@echo off
setlocal
set "FIREFOX_NODE_DIR=%USERPROFILE%\.mozbuild\node"
set "PATH=%FIREFOX_NODE_DIR%;%PATH%"
"%FIREFOX_NODE_DIR%\node.exe" "%FIREFOX_NODE_DIR%\node_modules\npm\bin\npx-cli.js" @mozilla/firefox-devtools-mcp-moz %*
exit /b %ERRORLEVEL%
