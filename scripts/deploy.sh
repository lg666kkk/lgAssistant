#!/usr/bin/env bash
set -euo pipefail

SERVER="62.234.44.42"
REMOTE_USER="ubuntu"
REMOTE_DIR="/home/ubuntu/personal-assistant"
LOCAL_DIR="/Users/lg/Desktop/personal-assistant"
MODE="dry-run"
CONFIRMED="false"

usage() {
  cat <<'EOF'
Usage: deploy.sh [options]

Default behavior is a read-only remote preflight plus rsync dry-run.

Options:
  --deploy              Request a real rsync and Docker Compose rollout.
  --yes                 Confirm the reviewed --deploy mutation.
  --verify              Run only remote service verification.
  --server HOST         Override 62.234.44.42.
  --user USER           Override ubuntu.
  --remote-dir PATH     Override /home/ubuntu/personal-assistant.
  --local-dir PATH      Override /Users/lg/Desktop/personal-assistant.
  -h, --help            Show this help.

Examples:
  deploy.sh
  deploy.sh --deploy --yes
  deploy.sh --verify
EOF
}

while (($# > 0)); do
  case "$1" in
    --deploy)
      MODE="deploy"
      shift
      ;;
    --yes)
      CONFIRMED="true"
      shift
      ;;
    --verify)
      MODE="verify"
      shift
      ;;
    --server|--user|--remote-dir|--local-dir)
      if (($# < 2)); then
        echo "Missing value for $1" >&2
        exit 2
      fi
      case "$1" in
        --server) SERVER="$2" ;;
        --user) REMOTE_USER="$2" ;;
        --remote-dir) REMOTE_DIR="$2" ;;
        --local-dir) LOCAL_DIR="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$SERVER" =~ ^[a-zA-Z0-9._:-]+$ ]]; then
  echo "Unsafe server value: $SERVER" >&2
  exit 2
fi
if [[ ! "$REMOTE_USER" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Unsafe user value: $REMOTE_USER" >&2
  exit 2
fi
if [[ ! "$REMOTE_DIR" =~ ^/[a-zA-Z0-9._/-]+$ || "$REMOTE_DIR" == "/" ]]; then
  echo "Unsafe remote directory: $REMOTE_DIR" >&2
  exit 2
fi
if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "Local directory does not exist: $LOCAL_DIR" >&2
  exit 2
fi
for required in Dockerfile docker-compose.yml DEPLOY.md; do
  if [[ ! -f "$LOCAL_DIR/$required" ]]; then
    echo "Missing required file: $LOCAL_DIR/$required" >&2
    exit 2
  fi
done
for command_name in ssh rsync; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command_name" >&2
    exit 2
  fi
done

TARGET="${REMOTE_USER}@${SERVER}"
SSH_ARGS=(-o ConnectTimeout=10 "$TARGET")

remote_preflight() {
  ssh "${SSH_ARGS[@]}" bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
remote_dir="$1"
test -d "$remote_dir"
test -f "$remote_dir/.env.production"
command -v rsync >/dev/null
command -v docker >/dev/null
cd "$remote_dir"
docker compose version
echo "Remote preflight OK: $remote_dir"
REMOTE
}

rsync_source() {
  local dry_run="$1"
  local args=(
    -azv
    --delete-delay
    --itemize-changes
    "--filter=P .env.production"
    "--filter=P data/agent-artifacts/***"
    --exclude='.env*.local'
    --exclude=.env.production
    --exclude=.git/
    --exclude='.next*/'
    --exclude=.memsearch/
    --exclude=.env
    --exclude=.venv/
    --exclude=logs/
    --exclude=output/
    --exclude=node_modules/
    --exclude=data/agent-artifacts/
    --exclude=.agents/
    --exclude=.codex/
    --exclude=.claude/
    --exclude=outputs/
    --exclude=reports/
    --exclude='*.tsbuildinfo'
    --exclude=.DS_Store
  )
  if [[ "$dry_run" == "true" ]]; then
    args+=(-n)
  fi
  rsync "${args[@]}" "$LOCAL_DIR/" "$TARGET:$REMOTE_DIR/"
}

remote_verify() {
  ssh "${SSH_ARGS[@]}" bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
docker compose ps
redis_reply="$(docker compose exec -T redis redis-cli ping </dev/null)"
test "$redis_reply" = "PONG"
curl -fsS http://127.0.0.1:3000 >/dev/null
echo "Redis: $redis_reply"
echo "Application health check: OK"
REMOTE
}

remote_deploy() {
  ssh "${SSH_ARGS[@]}" bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
docker compose config --services
if ! docker compose up -d --build; then
  docker compose logs --tail=200 app redis || true
  exit 1
fi
docker compose ps
redis_reply="$(docker compose exec -T redis redis-cli ping </dev/null)"
test "$redis_reply" = "PONG"
curl -fsS http://127.0.0.1:3000 >/dev/null
echo "Redis: $redis_reply"
echo "Application health check: OK"
REMOTE
}

if [[ "$MODE" == "verify" ]]; then
  remote_verify
  exit 0
fi

echo "Target: $TARGET:$REMOTE_DIR"
echo "Source: $LOCAL_DIR"
remote_preflight

if [[ "$MODE" == "dry-run" ]]; then
  rsync_source "true"
  echo
  echo "Dry-run complete. Review every change before deployment."
  echo "After explicit approval, run: $0 --deploy --yes"
  exit 0
fi

if [[ "$CONFIRMED" != "true" ]]; then
  rsync_source "true"
  echo
  echo "Deployment refused: --deploy requires --yes after reviewing this dry-run." >&2
  exit 2
fi

rsync_source "false"
remote_deploy
