@echo off
REM ============================================================
REM  Daily job: fetch Fear & Greed + VOO/TQQQ, push to GitHub.
REM  Runs as a Windows Scheduled Task (see setup_task.ps1).
REM  Local fallback to the GitHub Actions cloud updater: pulls
REM  first so it coexists with Actions commits without conflict.
REM ============================================================
setlocal
cd /d "%~dp0"

set LOG=%~dp0run.log
echo. >> "%LOG%"
echo ===== %date% %time% ===== >> "%LOG%"

REM 0) Sync with remote first (Actions may have pushed). Safe if no remote yet.
git rev-parse --is-inside-work-tree >nul 2>&1
if %ERRORLEVEL%==0 (
  git remote get-url origin >nul 2>&1 && git pull --rebase --autostash >> "%LOG%" 2>&1
)

REM 1) Collect data -> docs\data.json (reads existing file and merges history)
node "collector\fetch.mjs" >> "%LOG%" 2>&1
echo node exit=%ERRORLEVEL% >> "%LOG%"

REM 2) Commit & push (skip silently if no git remote configured yet)
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo not a git repo - skipping push >> "%LOG%"
  goto :end
)

git add docs\data.json >> "%LOG%" 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "data: update (local) %date%" >> "%LOG%" 2>&1
  git push >> "%LOG%" 2>&1
  if errorlevel 1 (
    echo push rejected - rebasing and retrying >> "%LOG%"
    git pull --rebase --autostash >> "%LOG%" 2>&1
    git push >> "%LOG%" 2>&1
  )
  echo push done >> "%LOG%"
) else (
  echo no data change - nothing to commit >> "%LOG%"
)

:end
endlocal
