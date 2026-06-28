#!/usr/bin/env bash
set -euo pipefail

command="${1:-}"
state_dir="${OBSERVABILITY_PROXY_STATE_DIR:-.runtime/observability-proxy}"

prometheus_name="prometheus"
prometheus_listen_port="${OBSERVABILITY_PROMETHEUS_PORT:-30090}"
prometheus_node_port="30090"
usage() {
  cat >&2 <<USAGE
usage: $0 <start|stop|status|urls>

Environment overrides:
  OBSERVABILITY_PROXY_STATE_DIR   default: .runtime/observability-proxy
  OBSERVABILITY_PROMETHEUS_PORT   default: 30090
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

minikube_node_ip() {
  minikube ip
}

host_lan_ip() {
  local ip=""

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  fi

  if [[ -z "${ip}" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  if [[ -z "${ip}" ]]; then
    ip="127.0.0.1"
  fi

  printf '%s\n' "${ip}"
}

pid_file() {
  local name="$1"
  printf '%s/%s.pid\n' "${state_dir}" "${name}"
}

log_file() {
  local name="$1"
  printf '%s/%s.log\n' "${state_dir}" "${name}"
}

is_running() {
  local name="$1"
  local file
  file="$(pid_file "${name}")"

  [[ -f "${file}" ]] || return 1

  local pid
  pid="$(cat "${file}")"

  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" >/dev/null 2>&1
}

start_proxy() {
  local name="$1"
  local listen_port="$2"
  local target_ip="$3"
  local target_port="$4"

  mkdir -p "${state_dir}"

  if is_running "${name}"; then
    echo "${name}: already running pid=$(cat "$(pid_file "${name}")")"
    return 0
  fi

  rm -f "$(pid_file "${name}")"

  nohup socat \
    "TCP4-LISTEN:${listen_port},bind=0.0.0.0,reuseaddr,fork" \
    "TCP4:${target_ip}:${target_port}" \
    >"$(log_file "${name}")" 2>&1 &

  echo "$!" >"$(pid_file "${name}")"
  echo "${name}: 0.0.0.0:${listen_port} -> ${target_ip}:${target_port} pid=$!"
}

stop_proxy() {
  local name="$1"
  local file
  file="$(pid_file "${name}")"

  if [[ ! -f "${file}" ]]; then
    echo "${name}: stopped"
    return 0
  fi

  local pid
  pid="$(cat "${file}")"

  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}"
    echo "${name}: stopped pid=${pid}"
  else
    echo "${name}: stale pid=${pid}"
  fi

  rm -f "${file}"
}

status_proxy() {
  local name="$1"

  if is_running "${name}"; then
    echo "${name}: running pid=$(cat "$(pid_file "${name}")")"
  else
    echo "${name}: stopped"
  fi
}

print_urls() {
  local ip
  ip="$(host_lan_ip)"

  echo "Prometheus  http://${ip}:${prometheus_listen_port}"
}

case "${command}" in
  start)
    require_cmd minikube
    require_cmd socat
    node_ip="$(minikube_node_ip)"
    start_proxy "${prometheus_name}" "${prometheus_listen_port}" "${node_ip}" "${prometheus_node_port}"
    print_urls
    ;;

  stop)
    stop_proxy "${prometheus_name}"
    ;;

  status)
    status_proxy "${prometheus_name}"
    ;;

  urls)
    print_urls
    ;;

  *)
    usage
    exit 2
    ;;
esac
