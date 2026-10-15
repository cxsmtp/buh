@echo off
SETLOCAL EnableDelayedExpansion
REM Beautiful UAE Home: automatic updates for a shop that runs as ONE Podman container.
REM
REM   scripts\podman-autoupdate.bat [NAME] [PORT] [DATA-VOLUME] ["KEY=VALUE KEY=VALUE"] [MINUTES]
REM
REM Defaults: beautifuluaehome 443 beautifuluaehome-data "TZ=Asia/Dubai" 15
REM An existing container keeps its own port and its own settings (-e ..., secrets too: they
REM are kept in the updater's own volume, readable only by it); PORT is for a new shop.
REM Plain-http use on this computer (test mode):
REM   scripts\podman-autoupdate.bat beautifuluaehome 443 beautifuluaehome-data "TZ=Asia/Dubai INSECURE_COOKIES=1 OTP_DEV_MODE=true"
REM
REM What it does (run it again any time: to change a setting, or to get a newer updater):
REM   1. finds Podman's API socket inside the Podman machine;
REM   2. pulls the shop image and the updater's image (the docker command-line tool);
REM   3. checks the data volume: the shop keeps the SAME one, never a new, empty one;
REM   4. creates the updater's volumes and copies the updater script out of the shop image;
REM   5. re-creates the shop container with two more volumes (requests from Settings -> Versions,
REM      and the updater's status): same image, data, port and settings. The shop pauses for a
REM      few seconds; if the new container does not answer, the old one is put back. It refuses
REM      (and changes nothing) if the container has something it cannot carry over, such as
REM      another folder mounted, and lists it;
REM   6. starts the updater container (NAME-updater, --restart=always);
REM   7. asks Podman inside the machine to start it again when the machine starts.
REM The updater can control Podman through the socket: see docs\security.md.

SET "IMAGE=ghcr.io/cxsmtp/buh:latest"
SET "UPDATER_IMAGE=docker.io/library/docker:27.3.1-cli"

SET "NAME=%~1"
SET "PORT=%~2"
SET "VOLUME=%~3"
SET "SHOPENV=%~4"
SET "MINUTES=%~5"
if "!NAME!"=="" SET "NAME=beautifuluaehome"
if "!PORT!"=="" SET "PORT=443"
if "!VOLUME!"=="" SET "VOLUME=beautifuluaehome-data"
if "!SHOPENV!"=="" SET "SHOPENV=TZ=Asia/Dubai"
if "!MINUTES!"=="" SET "MINUTES=15"

REM Plain names and numbers only (the updater checks every value again, strictly).
echo(%NAME%| findstr /R /X /C:"[0-9a-zA-Z][0-9a-zA-Z_.-]*" >nul || goto :badargs
echo(%VOLUME%| findstr /R /X /C:"[0-9a-zA-Z][0-9a-zA-Z_.-]*" >nul || goto :badargs
echo(%PORT%| findstr /R /X /C:"[1-9][0-9]*" >nul || goto :badargs
echo(%MINUTES%| findstr /R /X /C:"[0-9][0-9]*" >nul || goto :badargs
echo(%SHOPENV%| findstr /R /X /C:"[0-9a-zA-Z_.,:/@+= -]*" >nul || goto :badargs

SET "CONTROL=%NAME%-updater-control"
SET "STATUS=%NAME%-updater-status"
SET "STATE=%NAME%-updater-state"
SET "CODE=%NAME%-updater-code"
SET "UPDATER=%NAME%-updater"

echo.
echo 1. Finding the Podman socket (podman machine must be running)...
SET "SOCK=%PODMAN_SOCKET%"
if "!SOCK!"=="" for /f "usebackq delims=" %%S in (`podman info --format "{{.Host.RemoteSocket.Path}}"`) do SET "SOCK=%%S"
if "!SOCK!"=="" goto :nosocket
SET "SOCK=!SOCK:unix://=!"
echo    !SOCK!

echo.
echo 2. Pulling the shop image and the updater image...
podman pull %IMAGE%
if errorlevel 1 (
    echo [ERROR] Pull failed. If it says "unauthorized", run: podman login ghcr.io
    goto :end
)
podman pull %UPDATER_IMAGE%
if errorlevel 1 goto :end

echo.
echo 3. Checking the data volume %VOLUME%...
podman container exists %NAME%
if errorlevel 1 goto :nocontainer
SET "MOUNTS="
for /f "usebackq delims=" %%M in (`podman inspect --format "{{range .Mounts}}{{.Destination}}={{.Name}};{{end}}" %NAME%`) do SET "MOUNTS=%%M"
echo %MOUNTS% | findstr /C:"/data=%VOLUME%;" >nul
if errorlevel 1 goto :wrongvolume
echo    %NAME% keeps its data in %VOLUME%: it stays there.
goto :volumes

:nocontainer
podman volume exists %VOLUME%
if errorlevel 1 (
    echo    There is no container %NAME% and no volume %VOLUME%: a NEW, EMPTY shop will be created.
    echo    Containers on this computer:
    podman ps -a --format "     {{.Names}}  {{.Image}}  {{.Ports}}"
    echo    If the shop runs under another name, press Ctrl+C and run this again with that name.
    pause
) else (
    echo    No container %NAME% yet; one is started on the existing volume %VOLUME%.
)

:volumes
REM Two shops must never share one database: no other container may use the data volume.
SET "OTHERS="
for /f "usebackq delims=" %%C in (`podman ps -a --filter volume^=%VOLUME% --format "{{.Names}}"`) do (
    if /I not "%%C"=="%NAME%" if /I not "%%C"=="%NAME%-previous" if /I not "%%C"=="%NAME%-candidate" SET "OTHERS=!OTHERS! %%C"
)
if not "!OTHERS!"=="" goto :othercontainer

echo.
echo 4. Creating the updater's volumes and copying the updater script...
for %%V in (%CONTROL% %STATUS% %STATE% %CODE%) do (
    podman volume exists %%V || podman volume create %%V >nul
)
REM The updater (root in its container) owns both folders; the shop (user 1001) may only
REM drop a request into the first (sticky, not listable) and only read the second.
podman run --rm --user 0 -v %CONTROL%:/c -v %STATUS%:/s --entrypoint /bin/sh %UPDATER_IMAGE% -c "chown 0:0 /c /s && chmod 1733 /c && chmod 755 /s"
if errorlevel 1 goto :end
podman run --rm --user 0 -v %CODE%:/out --entrypoint /bin/sh %IMAGE% -c "test -f /app/updater/updater.sh && rm -rf /out/* && cp -R /app/updater/. /out/ && chmod -R a+rX /out"
if errorlevel 1 (
    REM An image from before BUH-02.04.00 has no updater inside: use this folder's copy.
    podman run --rm --user 0 -v "%~dp0..\deploy\updater:/src:ro" -v %CODE%:/out --entrypoint /bin/sh %UPDATER_IMAGE% -c "rm -rf /out/* && cp -R /src/. /out/ && chmod -R a+rX /out"
    if errorlevel 1 goto :end
)

REM The updater's settings, the same for the set-up step and for the running updater.
SET "UPD=--security-opt label=disable -v !SOCK!:/var/run/docker.sock -v %CODE%:/updater:ro -v %STATE%:/state -v %CONTROL%:/control -v %STATUS%:/public"
SET "UPD=!UPD! -e UPDATER_MODE=single -e SHOP_NAME=%NAME% -e SHOP_PORT=%PORT% -e SHOP_VOLUME=%VOLUME% -e CONTROL_VOLUME=%CONTROL% -e STATUS_VOLUME=%STATUS%"
SET "UPD=!UPD! -e IMAGE=%IMAGE% -e UPDATE_CHECK_MINUTES=%MINUTES% -e HOME=/tmp -e DOCKER_CONFIG=/state/docker-config"
SET "UPD=!UPD! -e PATH=/updater/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
SET "UPD=!UPD! --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --entrypoint /bin/sh"

echo.
echo 5. Re-creating %NAME% with the updater's volumes (same image, same data; a few seconds' pause)...
podman run --rm !UPD! -e "SHOP_ENV=!SHOPENV!" %UPDATER_IMAGE% /updater/updater.sh adopt
if errorlevel 1 (
    echo [ERROR] The shop container was not changed, or was put back as it was. See the lines above.
    goto :end
)

echo.
echo 6. Starting the updater (%UPDATER%)...
REM Up to 10 minutes: a switch under way is finished first (a new one is not started).
podman stop -t 600 %UPDATER% >nul 2>&1
podman rm -f %UPDATER% >nul 2>&1
podman run -d --name %UPDATER% --restart=always --stop-timeout 600 !UPD! -e "SHOP_ENV=!SHOPENV!" %UPDATER_IMAGE% /updater/updater.sh daemon
if errorlevel 1 goto :end

echo.
echo 7. Starting the updater again whenever the Podman machine starts...
REM --restart=always alone does not survive a restart of the machine: podman-restart.service
REM starts such containers at boot. Rootless (the default): a user service, with "linger" so it
REM runs without a login. Rootful: the system service.
SET "ROOTLESS="
for /f "usebackq delims=" %%R in (`podman info --format "{{.Host.Security.Rootless}}"`) do SET "ROOTLESS=%%R"
if /I "!ROOTLESS!"=="false" (
    podman machine ssh "sudo systemctl enable podman-restart.service"
) else (
    podman machine ssh "loginctl enable-linger && systemctl --user enable podman-restart.service"
)
if errorlevel 1 (
    echo [WARNING] This could not be set up. After Windows restarts, run these two lines:
    echo    podman machine start
    echo    podman start %UPDATER%
    echo The updater then starts the shop by itself.
)

echo.
echo Done. Automatic updates are on: checked every %MINUTES% minutes (0 = only when you ask),
echo and Settings - Versions in the Admin Hub can update or switch versions.
echo A switch closes the shop for a few seconds; the database is saved first.
echo   Log:         podman logs -f %UPDATER%
echo   What runs:   podman exec %UPDATER% updater-status
echo   Update now:  podman exec %UPDATER% update-now
echo   Roll back:   podman exec %UPDATER% rollback
echo   Turn off:    podman rm -f %UPDATER%
echo While it runs, update with "Update to the latest" in Settings - Versions (or the line above),
echo not with podman pull/stop/rm/run: stop the updater first if you must do it by hand.
echo The Podman machine itself does not start with Windows: run "podman machine start" after a
echo restart (or let Podman Desktop start it); the updater and the shop then come back.
goto :end

:othercontainer
echo [ERROR] The data volume %VOLUME% is also used by:!OTHERS!
echo Two shops must never share it, so nothing was changed. If that container IS your shop,
echo run this again with its name, for example:
echo    scripts\podman-autoupdate.bat ^<its-name^> %PORT% %VOLUME%
echo Otherwise remove it first: podman rm ^<its-name^>
goto :end

:wrongvolume
echo [ERROR] %NAME% does not keep its data in the volume %VOLUME%. Its mounts (folder=volume):
echo    %MOUNTS%
echo Nothing was changed. Run this again with the volume shown after /data=, for example:
echo    scripts\podman-autoupdate.bat %NAME% %PORT% ^<that-volume^>
goto :end

:nosocket
echo [ERROR] Podman did not answer. Start it with: podman machine start
echo (or set PODMAN_SOCKET to the socket path inside the machine, then run this again).
goto :end

:badargs
echo [ERROR] Use plain names and numbers, for example:
echo    scripts\podman-autoupdate.bat beautifuluaehome 443 beautifuluaehome-data "TZ=Asia/Dubai"

:end
pause
ENDLOCAL
