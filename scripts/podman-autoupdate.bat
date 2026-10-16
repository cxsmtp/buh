@echo off
SETLOCAL EnableDelayedExpansion
REM Beautiful UAE Home: turn on automatic updates for a shop that runs as ONE Podman container.
REM
REM A thin wrapper: the set-up itself is in the published image ghcr.io/cxsmtp/buh-updater (no
REM code needed on this computer). This file only types the one-line command of the guide:
REM
REM   for /f "delims=" %S in ('podman info --format "{{.Host.RemoteSocket.Path}}"') do podman run --rm --security-opt label=disable -v %S:/var/run/docker.sock -e SOCK=%S ghcr.io/cxsmtp/buh-updater:latest setup beautifuluaehome
REM
REM   scripts\podman-autoupdate.bat [NAME] [PORT] [DATA-VOLUME] ["KEY=VALUE KEY=VALUE"] [MINUTES]
REM
REM Defaults: beautifuluaehome; an existing container keeps its own data volume, port and settings
REM (PORT, DATA-VOLUME and the settings matter only for a new shop, or to add settings).

SET "UPDATER_IMAGE=ghcr.io/cxsmtp/buh-updater:latest"

SET "NAME=%~1"
if "!NAME!"=="" SET "NAME=beautifuluaehome"
SET "OPTS="
if not "%~2"=="" SET "OPTS=!OPTS! --port %~2"
if not "%~3"=="" SET "OPTS=!OPTS! --volume %~3"
if not "%~4"=="" SET "OPTS=!OPTS! --env "%~4""
if not "%~5"=="" SET "OPTS=!OPTS! --minutes %~5"

REM Plain names only here; the updater checks every value again, strictly.
echo(%NAME%| findstr /R /X /C:"[0-9a-zA-Z][0-9a-zA-Z_.-]*" >nul || goto :badargs

echo Finding the Podman socket (podman machine must be running)...
SET "SOCK=%PODMAN_SOCKET%"
if "!SOCK!"=="" for /f "usebackq delims=" %%S in (`podman info --format "{{.Host.RemoteSocket.Path}}"`) do SET "SOCK=%%S"
if "!SOCK!"=="" goto :nosocket
SET "SOCK=!SOCK:unix://=!"

podman pull %UPDATER_IMAGE%
if errorlevel 1 goto :end
podman run --rm --security-opt label=disable -v !SOCK!:/var/run/docker.sock -e SOCK=!SOCK! %UPDATER_IMAGE% setup %NAME% !OPTS!
goto :end

:nosocket
echo [ERROR] Podman did not answer. Start it with: podman machine start
goto :end

:badargs
echo [ERROR] Use the container's name as podman ps shows it, for example:
echo    scripts\podman-autoupdate.bat beautifuluaehome

:end
pause
ENDLOCAL
