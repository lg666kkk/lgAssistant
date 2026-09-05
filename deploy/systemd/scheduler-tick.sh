#!/bin/sh
set -eu

env_file=/home/ubuntu/personal-assistant/.env.production
secret_line=$(/usr/bin/grep -m 1 '^CRON_SECRET=' "$env_file" || true)
secret=${secret_line#CRON_SECRET=}

case "$secret" in
  \"*\") secret=${secret#\"}; secret=${secret%\"} ;;
  \'*\') secret=${secret#\'}; secret=${secret%\'} ;;
esac

if [ -z "$secret" ]; then
  echo "CRON_SECRET is missing" >&2
  exit 1
fi

{
  printf 'fail\n'
  printf 'silent\n'
  printf 'show-error\n'
  printf 'max-time = 300\n'
  printf 'header = "x-cron-secret: %s"\n' "$secret"
  printf 'url = "http://127.0.0.1:3000/api/cron/tick"\n'
} | /usr/bin/curl --config -
