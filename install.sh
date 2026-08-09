#!/bin/sh
# stats installer — https://git.tinnyterr.com/tinnyterr/stats
#
# Installs the single-file `stats` binary (it embeds the Bun runtime, the API
# and the dashboard, so nothing else is required on the machine) and, on
# request, a hardened systemd unit for either role.
#
#   Hub, on the machine that shows the dashboard — install this one first, it
#   prints the token the nodes need:
#     curl -fsSL .../install.sh | sudo sh -s -- --hub
#
#   Node, on each server you want to watch:
#     curl -fsSL https://git.tinnyterr.com/tinnyterr/stats/raw/branch/main/install.sh | \
#       sudo sh -s -- --node --hub ws://hub.lan:3000 --token <token>
#
#   From a local build (bun run build):
#     sudo ./install.sh --from dist --node --hub ws://hub.lan:3000
#
# Everything it touches:
#   /usr/local/bin/stats            the binary
#   /etc/stats/node.env             hub URL + node token (--node, mode 0600)
#   /etc/stats/projects.json        what the node runs   (--node, if absent)
#   /etc/stats/hub.json             hub config           (--hub)
#   /etc/stats/hub.env              hub secrets          (--hub, mode 0600)
#   /var/lib/stats/                 hub SQLite history   (--hub)
#   /etc/systemd/system/stats-*.service
#
# It is re-runnable: installing over an existing copy upgrades the binary and
# restarts the service, and never overwrites a config or token you already have.

set -eu

REPO="${STATS_REPO:-tinnyterr/stats}"
HOST="${STATS_HOST:-git.tinnyterr.com}"
BASE_URL="${STATS_URL:-}"        # directory holding the release assets
VERSION="${STATS_VERSION:-}"     # release tag, e.g. v0.1.0
FROM=""                          # local dist directory or binary
PREFIX="${STATS_PREFIX:-}"
MODE=""                          # node | hub | "" (binary only)
TOKEN="${STATS_NODE_TOKEN:-}"
HUB_URL="${STATS_HUB:-}"
NODE_ID="${STATS_NODE_ID:-}"
NODE_NAME="${STATS_NODE_NAME:-}"
NO_TERMINAL=0
NO_CONTROL=0
PORT=""
HUB_HOST=""
NO_SERVICE=0
UNINSTALL=0
PURGE=0
ASSUME_YES=0
SERVICE_USER="stats"

BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
fi

log()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
stats installer

Usage: install.sh [options]

Role:
  --node               install a node (dials the hub) + systemd unit
  --hub                install the dashboard hub + systemd unit
  (neither)            install the binary only

Source:
  --from PATH          install from a local dist/ directory or a binary file
  --version TAG        release tag to fetch (default: the latest release)
  --repo OWNER/NAME    repository to fetch from (default: tinnyterr/stats)
  --url BASE           fetch assets straight from this directory URL

Placement:
  --prefix DIR         where the binary goes (default: /usr/local/bin,
                       or ~/.local/bin when not running as root)
  --user NAME          system user the services run as (default: stats)

Service:
  --hub-url URL        (--node) the hub to dial, e.g. ws://hub.lan:3000
  --token VALUE        shared token; generated on --hub, required on --node
  --id ID              (--node) node id (default: /etc/machine-id)
  --name NAME          (--node) display name (default: hostname)
  --no-terminal        (--node) refuse to open shells for the dashboard
  --no-control         (--node) refuse start/stop/restart requests
  --port N             (--hub) port to listen on (default 3000)
  --host ADDR          (--hub) address to bind (default 127.0.0.1)
  --no-service         install the binary and config but no systemd unit

Other:
  --uninstall          stop services and remove the binary and units
  --purge              with --uninstall, also delete configs and history
  --yes                don't prompt
  --help               this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --node|--agent) MODE="node" ;;
    --hub)        MODE="hub" ;;
    --hub-url)    HUB_URL="${2:?--hub-url needs a URL}"; shift ;;
    --hub-url=*)  HUB_URL="${1#--hub-url=}" ;;
    --id)         NODE_ID="${2:?--id needs a value}"; shift ;;
    --id=*)       NODE_ID="${1#--id=}" ;;
    --name)       NODE_NAME="${2:?--name needs a value}"; shift ;;
    --name=*)     NODE_NAME="${1#--name=}" ;;
    --no-terminal) NO_TERMINAL=1 ;;
    --no-control)  NO_CONTROL=1 ;;
    --from)       FROM="${2:?--from needs a path}"; shift ;;
    --from=*)     FROM="${1#--from=}" ;;
    --version)    VERSION="${2:?--version needs a tag}"; shift ;;
    --version=*)  VERSION="${1#--version=}" ;;
    --repo)       REPO="${2:?--repo needs owner/name}"; shift ;;
    --repo=*)     REPO="${1#--repo=}" ;;
    --url)        BASE_URL="${2:?--url needs a URL}"; shift ;;
    --url=*)      BASE_URL="${1#--url=}" ;;
    --prefix)     PREFIX="${2:?--prefix needs a directory}"; shift ;;
    --prefix=*)   PREFIX="${1#--prefix=}" ;;
    --user)       SERVICE_USER="${2:?--user needs a name}"; shift ;;
    --user=*)     SERVICE_USER="${1#--user=}" ;;
    --port)       PORT="${2:?--port needs a number}"; shift ;;
    --port=*)     PORT="${1#--port=}" ;;
    --host)       HUB_HOST="${2:?--host needs an address}"; shift ;;
    --host=*)     HUB_HOST="${1#--host=}" ;;
    --token)      TOKEN="${2:?--token needs a value}"; shift ;;
    --token=*)    TOKEN="${1#--token=}" ;;
    --no-service) NO_SERVICE=1 ;;
    --uninstall)  UNINSTALL=1 ;;
    --purge)      PURGE=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --help|-h)    usage; exit 0 ;;
    *)            die "unknown option '$1' (try --help)" ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }

# Only used for irreversible things. Reads from the terminal rather than stdin,
# because stdin is the script itself when this is piped from curl.
confirm() {
  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  [ -r /dev/tty ] || die "$1 Re-run with --yes to confirm (nothing to prompt on here)."
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r reply < /dev/tty || reply=""
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) die "cancelled." ;;
  esac
}

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; fi

if [ -z "$PREFIX" ]; then
  if [ "$IS_ROOT" -eq 1 ]; then PREFIX="/usr/local/bin"; else PREFIX="$HOME/.local/bin"; fi
fi

BIN="$PREFIX/stats"
CONF_DIR="/etc/stats"
STATE_DIR="/var/lib/stats"
UNIT_DIR="/etc/systemd/system"

# ---------------------------------------------------------------- uninstall

uninstall() {
  [ "$IS_ROOT" -eq 1 ] || warn "not root — system services and /etc/stats will be left alone"

  if [ "$IS_ROOT" -eq 1 ] && have systemctl; then
    for unit in stats-node stats-agent stats-hub; do
      if [ -f "$UNIT_DIR/$unit.service" ]; then
        step "removing $unit.service"
        systemctl disable --now "$unit" >/dev/null 2>&1 || true
        rm -f "$UNIT_DIR/$unit.service"
      fi
    done
    systemctl daemon-reload || true
  fi

  if [ -f "$BIN" ]; then step "removing $BIN"; rm -f "$BIN"; fi

  if [ "$PURGE" -eq 1 ] && [ "$IS_ROOT" -eq 1 ]; then
    confirm "Delete $CONF_DIR (tokens, config) and $STATE_DIR (metric history)?"
    step "purging $CONF_DIR and $STATE_DIR"
    rm -rf "$CONF_DIR" "$STATE_DIR"
    if id "$SERVICE_USER" >/dev/null 2>&1 && have userdel; then
      userdel "$SERVICE_USER" >/dev/null 2>&1 || true
    fi
  elif [ -d "$CONF_DIR" ]; then
    log "${DIM}kept $CONF_DIR and $STATE_DIR — pass --purge to delete them.$RESET"
  fi

  log "${GREEN}stats removed.$RESET"
}

if [ "$UNINSTALL" -eq 1 ]; then uninstall; exit 0; fi

# ------------------------------------------------------------ platform pick

# Picks the asset this machine can actually execute: OS, CPU architecture,
# libc, and — on x86-64 — whether the CPU has the AVX2 instructions the fast
# build assumes. Guessing wrong here is the difference between a working
# install and "Illegal instruction (core dumped)".
#
# Everything here goes to stderr: the asset name is this function's stdout.
detect_asset() {
  if [ -n "${STATS_ASSET:-}" ]; then printf '%s\n' "$STATS_ASSET"; return; fi

  os=$(uname -s)
  machine=$(uname -m)

  case "$machine" in
    x86_64|amd64)         arch="x64" ;;
    aarch64|arm64)        arch="arm64" ;;
    armv7l|armv6l|i386|i686)
      die "$machine is not supported — stats ships 64-bit builds only." ;;
    *)                    die "unrecognised architecture '$machine'." ;;
  esac

  case "$os" in
    Linux)  ;;
    Darwin)
      warn "macOS can run the hub, but not a node — every collector is Linux-only."
      printf 'stats-darwin-%s\n' "$arch"; return ;;
    *) die "$os is not supported — stats is Linux-only (macOS runs the hub only)." ;;
  esac

  libc=""
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
    libc="-musl"
  elif have ldd && ldd --version 2>&1 | head -n1 | grep -qi musl; then
    libc="-musl"
  fi

  baseline=""
  if [ "$arch" = "x64" ] && [ -r /proc/cpuinfo ] && ! grep -qm1 ' avx2' /proc/cpuinfo; then
    baseline="-baseline"
    printf '%sCPU has no AVX2 — using the baseline build.%s\n' "$DIM" "$RESET" >&2
  fi

  printf 'stats-linux-%s%s%s\n' "$arch" "$libc" "$baseline"
}

ASSET=$(detect_asset)

# --------------------------------------------------------------- fetching

fetch() { # fetch <url> <dest>; quiet, fails on 404
  url="$1"; dest="$2"
  if have curl; then
    curl -fsSL --retry 3 --connect-timeout 20 -o "$dest" "$url"
  elif have wget; then
    wget -q -O "$dest" "$url"
  else
    die "need curl or wget to download (or use --from with a local build)."
  fi
}

fetch_stdout() {
  if have curl; then curl -fsSL --retry 3 --connect-timeout 20 "$1"
  elif have wget; then wget -qO- "$1"
  else die "need curl or wget."
  fi
}

# Both Gitea and GitHub expose the same shape here, only on different hosts.
resolve_version() {
  if [ "$HOST" = "github.com" ]; then
    api="https://api.github.com/repos/$REPO/releases/latest"
  else
    api="https://$HOST/api/v1/repos/$REPO/releases/latest"
  fi
  tag=$(fetch_stdout "$api" 2>/dev/null | tr ',' '\n' | grep -m1 '"tag_name"' |
        sed 's/.*"tag_name" *: *"\([^"]*\)".*/\1/') || true
  [ -n "${tag:-}" ] || die "couldn't work out the latest release from $api. Pass --version TAG."
  printf '%s\n' "$tag"
}

sha_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else printf ''
  fi
}

# The download is a ~100 MB executable that will run as a service, so check it
# against SHA256SUMS when one is published. A missing sums file is a warning,
# not a hard stop — a mismatch is fatal.
verify() { # verify <file> <name> <sums-file-or-empty>
  file="$1"; name="$2"; sums="$3"
  [ -n "$sums" ] && [ -s "$sums" ] || { warn "no SHA256SUMS alongside $name — skipping checksum."; return 0; }
  want=$(grep -m1 "  $name\$" "$sums" | cut -d' ' -f1) || true
  [ -n "${want:-}" ] || { warn "$name is not listed in SHA256SUMS — skipping checksum."; return 0; }
  got=$(sha_of "$file")
  [ -n "$got" ] || { warn "no sha256sum/shasum available — skipping checksum."; return 0; }
  [ "$got" = "$want" ] || die "checksum mismatch for $name.
  expected $want
  got      $got"
  log "${DIM}checksum ok ($name)$RESET"
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/stats-install.XXXXXX")
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# Puts the binary at $TMP/stats, from a local build or a release.
obtain_binary() {
  if [ -n "$FROM" ]; then
    if [ -d "$FROM" ]; then
      src="$FROM/$ASSET"
      [ -f "$src" ] || [ -f "$src.gz" ] ||
        die "$FROM has no $ASSET. Build it with: bun run build --targets ${ASSET#stats-}"
      step "installing $ASSET from $FROM"
      sums=""
      if [ -f "$FROM/SHA256SUMS" ]; then sums="$FROM/SHA256SUMS"; fi
      if [ -f "$src" ]; then
        verify "$src" "$ASSET" "$sums"
        cp "$src" "$TMP/stats"
      else
        verify "$src.gz" "$ASSET.gz" "$sums"
        have gunzip || die "need gunzip to unpack $src.gz"
        gunzip -c "$src.gz" > "$TMP/stats"
      fi
    elif [ -f "$FROM" ]; then
      step "installing $FROM"
      cp "$FROM" "$TMP/stats"
    else
      die "--from path '$FROM' does not exist."
    fi
    chmod +x "$TMP/stats"
    return
  fi

  if [ -z "$BASE_URL" ]; then
    [ -n "$VERSION" ] || { step "looking up the latest release"; VERSION=$(resolve_version); }
    BASE_URL="https://$HOST/$REPO/releases/download/$VERSION"
  fi

  step "downloading $ASSET ${VERSION:+($VERSION) }from $BASE_URL"
  fetch "$BASE_URL/SHA256SUMS" "$TMP/SHA256SUMS" 2>/dev/null || true

  # The gzipped asset is roughly a third of the size; fall back to the raw
  # binary on hosts without gunzip or releases that don't publish one.
  if have gunzip && fetch "$BASE_URL/$ASSET.gz" "$TMP/stats.gz" 2>/dev/null; then
    verify "$TMP/stats.gz" "$ASSET.gz" "$TMP/SHA256SUMS"
    gunzip -c "$TMP/stats.gz" > "$TMP/stats"
  else
    fetch "$BASE_URL/$ASSET" "$TMP/stats" ||
      die "couldn't download $BASE_URL/$ASSET — check the release has an asset for this platform."
    verify "$TMP/stats" "$ASSET" "$TMP/SHA256SUMS"
  fi
  chmod +x "$TMP/stats"
}

obtain_binary

# The binary is useless if the kernel or libc rejects it, and finding that out
# now beats finding out from a systemd restart loop.
if ! "$TMP/stats" version >/dev/null 2>&1; then
  die "the $ASSET build doesn't run on this machine.
  Force a different one and re-run, e.g. the baseline build for an old x86-64 CPU:
    STATS_ASSET=stats-linux-x64-baseline $0 $*"
fi
INSTALLED_VERSION=$("$TMP/stats" version)

mkdir -p "$PREFIX"
# Write beside the target and rename: an upgrade over a running service would
# otherwise fail with ETXTBSY, and rename() swaps the path atomically.
cp "$TMP/stats" "$BIN.new"
chmod 0755 "$BIN.new"
mv -f "$BIN.new" "$BIN"
step "installed $INSTALLED_VERSION → $BIN"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) warn "$PREFIX is not on your PATH — add it to your shell profile." ;;
esac

# --------------------------------------------------------------- services

if [ -z "$MODE" ]; then
  log ""
  log "Next: ${BOLD}stats hub${RESET} on the machine showing the dashboard, then"
  log "${BOLD}stats node --hub ws://that-machine:3000${RESET} on each server."
  log "Re-run with --node or --hub to set one up as a systemd service."
  exit 0
fi

if [ "$NO_SERVICE" -eq 1 ] || ! have systemctl; then
  [ "$NO_SERVICE" -eq 1 ] || warn "no systemd here — skipping the service."
  NO_SERVICE=1
fi

if [ "$IS_ROOT" -ne 1 ]; then
  warn "not root — skipping the systemd unit, config and service user."
  log "Run: ${BOLD}stats $MODE${RESET}"
  exit 0
fi

ensure_user() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then return; fi
  step "creating system user '$SERVICE_USER'"
  if have useradd; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null ||
      useradd --system --no-create-home "$SERVICE_USER"
  elif have adduser; then
    adduser -S -H -D "$SERVICE_USER" 2>/dev/null || adduser --system --no-create-home "$SERVICE_USER"
  else
    die "no useradd/adduser — create the '$SERVICE_USER' user yourself, or pass --user."
  fi
}

# Docker container state and journal logs are readable through group
# membership; without either group those two collectors simply report
# unavailable and everything else carries on.
supplementary_groups() {
  extra=""
  if getent group docker >/dev/null 2>&1; then extra="docker"; fi
  if getent group systemd-journal >/dev/null 2>&1; then
    extra="${extra:+$extra }systemd-journal"
  fi
  printf '%s\n' "$extra"
}

random_token() {
  if have openssl; then openssl rand -hex 32
  elif [ -r /dev/urandom ] && have od; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; printf '\n'
  else
    die "no openssl or /dev/urandom to generate a token — pass --token."
  fi
}

restart_unit() {
  systemctl daemon-reload
  systemctl enable "$1" >/dev/null 2>&1 || true
  systemctl restart "$1"
  sleep 1
  if systemctl is-active --quiet "$1"; then
    log "${GREEN}$1 is running.$RESET"
  else
    warn "$1 didn't come up. Logs:"
    if have journalctl; then journalctl -u "$1" -n 20 --no-pager || true; fi
    exit 1
  fi
}

ensure_user
mkdir -p "$CONF_DIR"
chmod 0755 "$CONF_DIR"
GROUPS_LINE=$(supplementary_groups)

if [ "$MODE" = "node" ]; then
  ENV_FILE="$CONF_DIR/node.env"

  # A node is useless without a hub to dial, and guessing one would be worse
  # than asking: it would sit there retrying an address nobody meant.
  if [ -z "$HUB_URL" ] && [ -f "$ENV_FILE" ]; then
    HUB_URL=$(sed -n 's/^STATS_HUB=//p' "$ENV_FILE" | head -n1)
  fi
  [ -n "$HUB_URL" ] || die "a node needs its hub: --hub-url ws://hub.lan:3000 (or set STATS_HUB)."

  if [ -f "$ENV_FILE" ]; then
    log "${DIM}keeping the existing $ENV_FILE$RESET"
    [ -n "$TOKEN" ] || TOKEN=$(sed -n 's/^STATS_NODE_TOKEN=//p' "$ENV_FILE" | head -n1)
  else
    [ -n "$TOKEN" ] ||
      warn "no --token given — the hub will only accept this node if it has no nodeToken set."
    step "writing $ENV_FILE"
    # Create it empty and lock it down before the token is ever in the file.
    : > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    cat > "$ENV_FILE" <<EOF
# Where the hub is. The node dials out; nothing listens on this machine.
STATS_HUB=$HUB_URL

# Must match the hub's nodeToken.
STATS_NODE_TOKEN=$TOKEN
${NODE_ID:+
# Stable identity. Changing it makes the hub treat this as a new machine.
STATS_NODE_ID=$NODE_ID}${NODE_NAME:+
STATS_NODE_NAME=$NODE_NAME}

# Extra directories readable through the kind=file log source (colon-separated).
#STATS_LOG_DIRS=/var/log:/srv/myapp/logs

# Non-standard docker socket, e.g. rootless docker.
#DOCKER_SOCKET=/run/user/1000/docker.sock
EOF
  fi

  # A starter projects file, so the projects tab explains itself instead of
  # being empty. It declares nothing, so installing it changes no behaviour.
  PROJECTS="$CONF_DIR/projects.json"
  if [ ! -f "$PROJECTS" ]; then
    step "writing $PROJECTS"
    HUB_HTTP=$(printf '%s' "$HUB_URL" | sed -e 's|^ws://|http://|' -e 's|^wss://|https://|' -e 's|/node$||')
    cat > "$PROJECTS" <<EOF
{
  "\$schema": "$HUB_HTTP/schema/projects.schema.json",
  "version": 1,
  "projects": []
}
EOF
    chmod 0644 "$PROJECTS"
  fi

  EXEC_FLAGS=""
  [ "$NO_TERMINAL" -eq 1 ] && EXEC_FLAGS="$EXEC_FLAGS --no-terminal"
  [ "$NO_CONTROL" -eq 1 ] && EXEC_FLAGS="$EXEC_FLAGS --no-control"

  if [ "$NO_SERVICE" -eq 0 ]; then
    step "writing $UNIT_DIR/stats-node.service"
    cat > "$UNIT_DIR/stats-node.service" <<EOF
# Written by install.sh. Mirrors deploy/stats-node.service in the repo.
[Unit]
Description=stats node (telemetry, projects and control for one host)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN node$EXEC_FLAGS
Restart=always
RestartSec=5
EnvironmentFile=$ENV_FILE

User=$SERVICE_USER
Group=$SERVICE_USER
${GROUPS_LINE:+SupplementaryGroups=$GROUPS_LINE}

# Supervised project processes are children of this unit.
TasksMax=512
LimitNOFILE=8192
TimeoutStopSec=30

NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
    restart_unit stats-node
  fi

  log ""
  log "Node is dialling ${BOLD}$HUB_URL${RESET} — it should appear on the dashboard within seconds."
  log "Identity:  ${DIM}${NODE_ID:-/etc/machine-id}  (${NODE_NAME:-$(hostname)})$RESET"
  log "Projects:  $PROJECTS   ${DIM}(declare what this host runs; stats check validates it)$RESET"
  if [ "$NO_TERMINAL" -eq 0 ] || [ "$NO_CONTROL" -eq 0 ]; then
    log ""
    log "${YELLOW}This node accepts${RESET}${BOLD}$([ "$NO_TERMINAL" -eq 0 ] && printf ' shells')$([ "$NO_CONTROL" -eq 0 ] && printf ' start/stop')${RESET}${YELLOW} from the hub,"
    log "as the '$SERVICE_USER' user. Re-run with --no-terminal / --no-control to refuse.$RESET"
  fi
  exit 0
fi

# ------------------------------------------------------------------- hub

PORT="${PORT:-3000}"
BIND="${HUB_HOST:-127.0.0.1}"
CONFIG="$CONF_DIR/hub.json"
HUB_ENV="$CONF_DIR/hub.env"

mkdir -p "$STATE_DIR"
chown "$SERVICE_USER" "$STATE_DIR" 2>/dev/null || true

if [ -f "$CONFIG" ]; then
  log "${DIM}keeping the existing $CONFIG$RESET"
  # It, not the flags, decides where the hub listens on an upgrade — so read the
  # address back out rather than reporting one the hub isn't going to use.
  existing_port=$(sed -n 's/.*"port" *: *\([0-9][0-9]*\).*/\1/p' "$CONFIG" | head -n1)
  existing_host=$(sed -n 's/.*"host" *: *"\([^"]*\)".*/\1/p' "$CONFIG" | head -n1)
  PORT="${existing_port:-$PORT}"
  BIND="${existing_host:-$BIND}"
else
  step "writing $CONFIG"
  cat > "$CONFIG" <<EOF
{
  "port": $PORT,
  "host": "$BIND",
  "token": null,
  "nodeToken": "env:STATS_NODE_TOKEN",
  "allowUnknownNodes": true,
  "retentionHours": 24,
  "telemetryIntervalMs": 3000,
  "dbPath": "$STATE_DIR/stats.db",
  "terminal": true,
  "embeddedNode": true,
  "nodes": []
}
EOF
  chmod 0644 "$CONFIG"
fi

# The token every node will need. Generated once and kept, because rotating it
# on an upgrade would lock out every node already using it.
if [ -f "$HUB_ENV" ]; then
  log "${DIM}keeping the existing node token in $HUB_ENV$RESET"
  TOKEN=$(sed -n 's/^STATS_NODE_TOKEN=//p' "$HUB_ENV" | head -n1)
else
  [ -n "$TOKEN" ] || TOKEN=$(random_token)
  step "writing $HUB_ENV"
  : > "$HUB_ENV"
  chmod 0600 "$HUB_ENV"
  cat > "$HUB_ENV" <<EOF
# Nodes must present this token in their Hello. hub.json refers to it as
# "env:STATS_NODE_TOKEN" so the config itself stays free of secrets.
STATS_NODE_TOKEN=$TOKEN
EOF
fi

if [ "$NO_SERVICE" -eq 0 ]; then
  step "writing $UNIT_DIR/stats-hub.service"
  cat > "$UNIT_DIR/stats-hub.service" <<EOF
# Written by install.sh. Mirrors deploy/stats-hub.service in the repo.
[Unit]
Description=stats hub (dashboard and node registry)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN hub --config $CONFIG
Restart=on-failure
RestartSec=5
# Tokens referenced as "env:NAME" in hub.json live here.
EnvironmentFile=-$HUB_ENV

User=$SERVICE_USER
Group=$SERVICE_USER
${GROUPS_LINE:+SupplementaryGroups=$GROUPS_LINE}

# The SQLite history is the only thing it writes; systemd creates and owns it.
StateDirectory=stats
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
  restart_unit stats-hub
fi

ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$ADDR" ] || ADDR="$BIND"

log ""
log "Dashboard: ${BOLD}http://$BIND:$PORT${RESET}"
log "Config:    $CONFIG"
log ""
log "Install a node on each server you want to watch:"
log ""
log "  ${BOLD}curl -fsSL https://$HOST/$REPO/raw/branch/main/install.sh | \\$RESET"
log "  ${BOLD}    sudo sh -s -- --node --hub-url ws://$ADDR:$PORT --token $TOKEN${RESET}"
log ""
log "${DIM}(that token is also in $HUB_ENV, root-only)$RESET"
if [ "$BIND" = "127.0.0.1" ]; then
  log ""
  log "${YELLOW}Bound to localhost, so no node can reach it.$RESET Re-run with ${BOLD}--host 0.0.0.0${RESET}"
  log "${DIM}to accept nodes, and set \"token\" in $CONFIG to protect the dashboard.$RESET"
fi
