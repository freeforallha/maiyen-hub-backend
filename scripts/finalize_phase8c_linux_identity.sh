#!/usr/bin/env bash
set -Eeuo pipefail

MIN_BACKEND_VERSION="1.2.4"
SOURCE_DIR="/home/pi/maiyen_hub_backend"
RUNTIME_DIR="/opt/maiyen-hub-backend"
BACKEND_SERVICE="maiyen-hub-backend.service"
WATCHER_SERVICE="maiyen-hub-update.path"
LEGACY_SERVICE="safehome-node.service"
LEGACY_SOURCE="/home/pi/safehome_nodejs"
LEGACY_RUNTIME="/opt/safehome-node"
LEGACY_GROUP="safehome"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="/var/backups/maiyen-hub/phase8c-finalize-${STAMP}"

version_ge() {
  dpkg --compare-versions "$1" ge "$2"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Lỗi: chạy bằng sudo bash scripts/finalize_phase8c_linux_identity.sh" >&2
  exit 1
fi

if systemctl is-active --quiet maiyen-hub-update.service; then
  echo "Lỗi: updater đang chạy." >&2
  exit 1
fi

if [[ -e /var/lib/maiyen-updater/inbox/update-request.json ]]; then
  echo "Lỗi: còn update-request.json trong inbox." >&2
  exit 1
fi

for service in "${BACKEND_SERVICE}" "${WATCHER_SERVICE}"; do
  if ! systemctl is-active --quiet "${service}"; then
    echo "Lỗi: ${service} không active." >&2
    exit 1
  fi
done

INSTALLED_VERSION="$(
  node -e 'console.log(require("/opt/maiyen-hub-backend/package.json").version)'
)"
if ! version_ge "${INSTALLED_VERSION}" "${MIN_BACKEND_VERSION}"; then
  echo "Lỗi: production ${INSTALLED_VERSION}, cần tối thiểu ${MIN_BACKEND_VERSION}." >&2
  exit 1
fi

install -d -m 0700 -o root -g root "${BACKUP_DIR}"
{
  echo "createdAt=$(date --iso-8601=seconds)"
  echo "installedVersion=${INSTALLED_VERSION}"
  echo "legacyService=$(systemctl is-enabled "${LEGACY_SERVICE}" 2>/dev/null || true)"
  echo "legacySource=$(readlink "${LEGACY_SOURCE}" 2>/dev/null || true)"
  echo "legacyRuntime=$(readlink "${LEGACY_RUNTIME}" 2>/dev/null || true)"
  getent group "${LEGACY_GROUP}" || true
} > "${BACKUP_DIR}/metadata.txt"

if [[ -f /etc/systemd/system/${LEGACY_SERVICE} ]]; then
  cp -a /etc/systemd/system/${LEGACY_SERVICE} "${BACKUP_DIR}/"
fi
if [[ -d /etc/systemd/system/${LEGACY_SERVICE}.d ]]; then
  cp -a /etc/systemd/system/${LEGACY_SERVICE}.d "${BACKUP_DIR}/"
fi

systemctl disable --now "${LEGACY_SERVICE}" >/dev/null 2>&1 || true
rm -f "/etc/systemd/system/${LEGACY_SERVICE}"
rm -rf "/etc/systemd/system/${LEGACY_SERVICE}.d"
rm -f "${LEGACY_SOURCE}" "${LEGACY_RUNTIME}"
rm -f "${RUNTIME_DIR}/.safehome_runtime" "${SOURCE_DIR}/.safehome_runtime"

systemctl daemon-reload
systemctl reset-failed "${LEGACY_SERVICE}" >/dev/null 2>&1 || true

if getent group "${LEGACY_GROUP}" >/dev/null; then
  if getent group "${LEGACY_GROUP}" | awk -F: '{exit ($4 == "" ? 0 : 1)}'; then
    if ! ps -eo group= | awk '{$1=$1};1' | grep -Fxq "${LEGACY_GROUP}"; then
      groupdel safehome
    fi
  fi
fi

echo "=== PHASE 8C VERIFY ==="
printf "backend : %s\n" "$(systemctl is-active "${BACKEND_SERVICE}")"
printf "watcher : %s\n" "$(systemctl is-active "${WATCHER_SERVICE}")"
printf "hostname: %s\n" "$(hostnamectl --static)"

for item in \
  "/etc/systemd/system/${LEGACY_SERVICE}" \
  "/etc/systemd/system/${LEGACY_SERVICE}.d" \
  "${LEGACY_SOURCE}" \
  "${LEGACY_RUNTIME}"; do
  if [[ -e "${item}" || -L "${item}" ]]; then
    echo "LỖI CÒN LEGACY: ${item}" >&2
    exit 1
  fi
done

echo "BACKUP: ${BACKUP_DIR}"
echo "PHASE 8C LINUX IDENTITY ĐÃ HOÀN TẤT"
