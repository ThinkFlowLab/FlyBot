#!/bin/sh

port=${DSH_LISTEN_PORT:-8080}
case "$port" in
  ''|*[!0-9]*) exit 1 ;;
esac

test_listener() {
  code=$(curl --silent --noproxy '*' --proto '=http' --max-time 1 \
    --output /dev/null --write-out '%{http_code}' "http://$1:$port/") || return 1
  case "$code" in
    200|401) return 0 ;;
    *) return 1 ;;
  esac
}

host=$(hostname -i 2>/dev/null) || host=''
host=${host%%[[:space:]]*}
case "$host" in
  ''|127.0.0.1|*[!0-9.]*) ;;
  *) test_listener "$host" && exit 0 ;;
esac
test_listener 127.0.0.1
