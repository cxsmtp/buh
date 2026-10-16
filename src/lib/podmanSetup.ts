/**
 * The one-line commands that turn on automatic updates for a shop that runs as one Podman
 * container (the published updater image's `setup`). Shown on Settings → Versions; the same
 * text is in README.md, HOSTINGER_DEPLOYMENT_GUIDE.md and scripts/podman-autoupdate.bat
 * (test/podman-setup-lines.test.mts keeps them identical).
 *
 * Each one asks Podman for its API socket, drops a leading `unix://` (some Podman versions
 * report the path with it, and a volume needs the bare path), and pulls a newer updater image
 * first (`--pull=newer`), so an old copy on the computer is never the one that runs.
 *
 * The images are private: each line also mounts, read-only, the folder that holds Podman's
 * registry login (auth.json, written by `podman login`). Podman's Docker API does not use that
 * login for the updater's downloads by itself, so the updater sends it (deploy/updater).
 */

const UPDATER = 'ghcr.io/cxsmtp/buh-updater:latest';
const RUN = '--rm --pull=newer --security-opt label=disable';
/** Where the updater finds the login folder (deploy/updater/updater.sh: AUTH_MOUNT). */
const AUTH = '/run/buh/registry-auth';

/**
 * Windows Command Prompt (cmd), not PowerShell. The Go template prints the socket path
 * without `unix://` (47 is "/"); it has no parentheses or inner quotes, which `for /f` cannot take.
 */
export const SETUP_CMD =
  `for /f "delims=" %S in ('podman info --format "{{if index .Host.RemoteSocket.Path 0 | eq 47}}{{.Host.RemoteSocket.Path}}{{else}}{{slice .Host.RemoteSocket.Path 7}}{{end}}"') ` +
  `do podman run ${RUN} -v %S:/var/run/docker.sock -e SOCK=%S -v "%USERPROFILE%\\.config\\containers:${AUTH}:ro" ${UPDATER} setup beautifuluaehome`;

/** Windows PowerShell (or PowerShell 7). */
export const SETUP_POWERSHELL =
  `$S = (podman info --format '{{.Host.RemoteSocket.Path}}') -replace '^unix://', ''; ` +
  `podman run ${RUN} -v "\${S}:/var/run/docker.sock" -e "SOCK=$S" -v "$env:USERPROFILE\\.config\\containers:${AUTH}:ro" ${UPDATER} setup beautifuluaehome`;

/** A Linux shell (the Podman socket must be on: systemctl enable --now podman.socket). */
export const SETUP_LINUX =
  `S=$(podman info --format '{{.Host.RemoteSocket.Path}}'); S=\${S#unix://}; ` +
  `podman run ${RUN} -v "$S:/var/run/docker.sock" -e "SOCK=$S" -v "$HOME/.config/containers:${AUTH}:ro" ${UPDATER} setup beautifuluaehome`;
