@echo off
SETLOCAL
REM Beautiful UAE Home: pull the published image and run it on this computer for testing.
REM Open http://localhost:3000 afterwards. Data stays in the "buhome-data" volume between runs.
REM Test mode: SMS codes are shown on screen and cookies work over plain http. Not for the live shop.
REM One container only (the live server uses blue/green copies and the updater instead).
REM The previous container is kept aside as buhome-previous until the new one answers,
REM and put back if the new one does not start.

SET IMAGE=ghcr.io/cxsmtp/buh:latest
SET NAME=buhome

echo.
echo Pulling latest image...
podman pull %IMAGE%
if errorlevel 1 (
    echo [ERROR] Pull failed. If it says "unauthorized", run: podman login ghcr.io
    goto :end
)

echo.
echo Setting the previous container aside, if any (the data volume is kept)...
podman rm -f %NAME%-previous >nul 2>&1
podman container exists %NAME%
if errorlevel 1 goto :start
podman stop -t 20 %NAME% >nul
podman rename %NAME% %NAME%-previous

:start
echo.
echo Starting new container...
podman run -d --name %NAME% -p 3000:3000 -v buhome-data:/data -e TZ=Asia/Dubai -e OTP_DEV_MODE=true -e INSECURE_COOKIES=1 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true %IMAGE%
if errorlevel 1 (
    echo [ERROR] The container did not start. Is port 3000 already in use?
    goto :rollback
)

echo.
echo Waiting for the shop to answer...
where curl >nul 2>&1
if errorlevel 1 (
    timeout /t 8 /nobreak >nul
    goto :healthy
)
SET /A TRIES=0
:wait
SET /A TRIES+=1
curl -sf http://localhost:3000/api/health >nul 2>&1
if not errorlevel 1 goto :healthy
if %TRIES% GEQ 60 goto :unhealthy
timeout /t 2 /nobreak >nul
goto :wait

:unhealthy
echo [ERROR] The new version did not answer within 2 minutes. Its log:
podman logs --tail 30 %NAME%

:rollback
podman rm -f %NAME% >nul 2>&1
podman container exists %NAME%-previous
if errorlevel 1 goto :end
echo Putting the previous version back...
podman rename %NAME%-previous %NAME%
podman start %NAME%
echo Rolled back: http://localhost:3000 runs the previous version.
goto :end

:healthy
podman rm -f %NAME%-previous >nul 2>&1

echo.
echo Fetching container logs (the first admin password is printed on the very first start only)...
podman logs %NAME%

echo.
echo Done. Open http://localhost:3000
echo Stop:   podman stop %NAME%
echo Reset:  podman rm -f %NAME% ^&^& podman volume rm buhome-data
:end
pause
ENDLOCAL
