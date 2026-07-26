#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_KEY_SOURCE="${1:-}"
INSTALL_DIR="/usr/local/lib/maiyen-updater"
CONFIG_DIR="/etc/maiyen-updater"
STATE_DIR="/var/lib/maiyen-updater"
SERVICE_GROUP="${MAIYEN_UPDATE_SERVICE_GROUP:-maiyen}"
BACKEND_SERVICE="${MAIYEN_BACKEND_SERVICE:-maiyen-hub-backend.service}"
BACKEND_SOURCE_DIR="${MAIYEN_SOURCE_DIR:-/home/pi/maiyen_hub_backend}"
BACKEND_RUNTIME_DIR="${MAIYEN_RUNTIME_DIR:-/opt/maiyen-hub-backend}"
BACKUP_ROOT="${MAIYEN_UPDATE_BACKUP_ROOT:-/var/backups/maiyen-hub}"
FIRMWARE_VERSION="1.1.0"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Lỗi: chạy bằng sudo bash scripts/install_maiyen_hub_updater.sh <release-public-key.pem>" >&2
  exit 1
fi

if [[ -z "${PUBLIC_KEY_SOURCE}" || ! -f "${PUBLIC_KEY_SOURCE}" ]]; then
  echo "Lỗi: cần truyền đường dẫn public key Ed25519." >&2
  echo "Ví dụ: sudo bash scripts/install_maiyen_hub_updater.sh /home/pi/release-public-key.pem" >&2
  exit 1
fi


if ! getent group "${SERVICE_GROUP}" >/dev/null; then
  echo "Lỗi: chưa có group ${SERVICE_GROUP}." >&2
  exit 1
fi

for file in \
  "${SOURCE_DIR}/hub_update_contract.js" \
  "${SOURCE_DIR}/scripts/apply_hub_update.js" \
  "${SOURCE_DIR}/systemd/maiyen-hub-update.path" \
  "${SOURCE_DIR}/systemd/maiyen-hub-update.service"; do
  if [[ ! -f "${file}" ]]; then
    echo "Lỗi: thiếu ${file}" >&2
    exit 1
  fi
done

install -d -m 0755 -o root -g root "${INSTALL_DIR}"
install -d -m 0755 -o root -g root "${INSTALL_DIR}/scripts"
install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${CONFIG_DIR}"
install -d -m 2770 -o root -g "${SERVICE_GROUP}" \
  "${STATE_DIR}/inbox" \
  "${STATE_DIR}/outbox" \
  "${STATE_DIR}/archive"
install -d -m 0711 -o root -g root "${STATE_DIR}/work"

install -m 0644 -o root -g root \
  "${SOURCE_DIR}/hub_update_contract.js" \
  "${INSTALL_DIR}/hub_update_contract.js"
install -m 0755 -o root -g root \
  "${SOURCE_DIR}/scripts/apply_hub_update.js" \
  "${INSTALL_DIR}/scripts/apply_hub_update.js"
install -m 0640 -o root -g "${SERVICE_GROUP}" \
  "${PUBLIC_KEY_SOURCE}" \
  "${CONFIG_DIR}/release-public-key.pem"

if [[ ! -f "${CONFIG_DIR}/firmware-version" ]]; then
  printf '%s\n' "${FIRMWARE_VERSION}" > "${CONFIG_DIR}/firmware-version"
fi
chown root:"${SERVICE_GROUP}" "${CONFIG_DIR}/firmware-version"
chmod 0640 "${CONFIG_DIR}/firmware-version"

/usr/bin/node -e '
const fs = require("fs");
const crypto = require("crypto");
const key = fs.readFileSync(process.argv[1], "utf8");
const parsed = crypto.createPublicKey(key);
if (parsed.asymmetricKeyType !== "ed25519") {
  throw new Error("Public key phải là Ed25519");
}
' "${CONFIG_DIR}/release-public-key.pem"

install -m 0644 -o root -g root \
  "${SOURCE_DIR}/systemd/maiyen-hub-update.path" \
  "/etc/systemd/system/maiyen-hub-update.path"

sed "s/@MAIYEN_SERVICE_GROUP@/${SERVICE_GROUP}/g" \
  "${SOURCE_DIR}/systemd/maiyen-hub-update.service" \
  > /tmp/maiyen-hub-update.service
install -m 0644 -o root -g root \
  /tmp/maiyen-hub-update.service \
  /etc/systemd/system/maiyen-hub-update.service
rm -f /tmp/maiyen-hub-update.service

cat > "${CONFIG_DIR}/updater.env" <<ENV
MAIYEN_SOURCE_DIR=${BACKEND_SOURCE_DIR}
MAIYEN_RUNTIME_DIR=${BACKEND_RUNTIME_DIR}
MAIYEN_UPDATE_BACKUP_ROOT=${BACKUP_ROOT}
MAIYEN_BACKEND_SERVICE=${BACKEND_SERVICE}
MAIYEN_UPDATE_SERVICE_GROUP=${SERVICE_GROUP}
ENV
chown root:"${SERVICE_GROUP}" "${CONFIG_DIR}/updater.env"
chmod 0640 "${CONFIG_DIR}/updater.env"

systemctl daemon-reload
systemctl enable --now maiyen-hub-update.path
systemctl restart "${BACKEND_SERVICE}"

echo "=== MAIYEN HUB UPDATER ==="
echo "Group  : ${SERVICE_GROUP}"
echo "Backend: ${BACKEND_SERVICE}"
systemctl --no-pager --full status maiyen-hub-update.path
systemctl --no-pager --full status "${BACKEND_SERVICE}"

echo "MAIYEN HUB UPDATER INSTALLED SUCCESSFULLY"
