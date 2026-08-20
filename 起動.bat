@echo off
cd /d "%~dp0"
echo Amex明細Excel変換ツールを起動しています...
echo ブラウザが自動で開きます。開かない場合は http://localhost:8765 にアクセスしてください。
start http://localhost:8765
python -m http.server 8765
pause
