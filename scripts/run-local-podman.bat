@echo off
SETLOCAL
REM Beautiful UAE Home: pull the published image and run it on this computer for testing.
REM Open http://localhost:3000 afterwards. Data stays in the "buhome-data" volume between runs.
REM Test mode: SMS codes are shown on screen and cookies work over plain http. Not for the live shop.

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
echo Removing the previous container, if any (the data volume is kept)...
podman rm -f %NAME% >nul 2>&1

echo.
echo Starting new container...
podman run -d --name %NAME% -p 3000:3000 -v buhome-data:/data -e TZ=Asia/Dubai -e OTP_DEV_MODE=true -e INSECURE_COOKIES=1 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true %IMAGE%
if errorlevel 1 (
    echo [ERROR] The container did not start. Is port 3000 already in use?
    goto :end
)

echo.
echo Waiting for the shop to start...
timeout /t 8 /nobreak >nul

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
