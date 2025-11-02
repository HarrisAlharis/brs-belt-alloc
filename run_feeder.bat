@echo off
setlocal enabledelayedexpansion

set ROOT=C:\Users\User\Desktop\brs-belt-alloc
set LOG=%ROOT%\feeder.log

cd /d "%ROOT%"
echo [%date% %time%] ---- run start ---- >> "%LOG%"

REM get latest
git fetch origin >> "%LOG%" 2>&1
git switch main >> "%LOG%" 2>&1
git pull --rebase origin main >> "%LOG%" 2>&1

REM run feeder (BRS, no belt 4)
node ".\feeder\fr24_feeder.js" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] feeder failed, aborting >> "%LOG%"
  goto :done
)

REM touch to force GH Pages refresh
echo %date% %time%> "docs\last_update.txt"

REM stage
git add "docs/assignments.json" "docs/last_update.txt" >> "%LOG%" 2>&1

REM commit only if changed
git diff --cached --quiet
if %errorlevel%==0 (
  echo [%date% %time%] no changes to commit >> "%LOG%"
  goto :done
)

git commit -m "auto: update assignments %date% %time%" >> "%LOG%" 2>&1

REM push (3 tries)
set RET=0
:push_try
set /a RET+=1
git push origin main >> "%LOG%" 2>&1
if %errorlevel% neq 0 (
  if %RET% lss 3 (
    echo [%date% %time%] push failed, retry %RET% >> "%LOG%"
    timeout /t 5 >nul
    git pull --rebase origin main >> "%LOG%" 2>&1
    goto :push_try
  ) else (
    echo [%date% %time%] push failed after retries >> "%LOG%"
  )
) else (
  echo [%date% %time%] push ok >> "%LOG%"
)

:done
echo [%date% %time%] ---- run end ---- >> "%LOG%"
endlocal
