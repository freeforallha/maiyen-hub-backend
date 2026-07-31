#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${MAIYEN_SOURCE_DIR:-${SCRIPT_SOURCE_DIR}}"
RUNTIME_DIR="${MAIYEN_RUNTIME_DIR:-/opt/maiyen-hub-backend}"
SERVICE_NAME="${MAIYEN_BACKEND_SERVICE:-maiyen-hub-backend.service}"
SERVICE_GROUP="${MAIYEN_SERVICE_GROUP:-maiyen}"
RUN_USER="${SUDO_USER:-pi}"
RUN_GROUP="$(id -gn "${RUN_USER}")"
INSTALL_ROOT="/usr/local/lib/maiyen-updater"
INSTALLED_CONTRACT="${INSTALL_ROOT}/hub_update_contract.js"
INSTALLED_UPDATER="${INSTALL_ROOT}/scripts/apply_hub_update.js"
INSTALLED_CLEANUP="${INSTALL_ROOT}/scripts/cleanup_maiyen_hub_updater.js"
SOURCE_CONTRACT="${SOURCE_DIR}/hub_update_contract.js"
SOURCE_UPDATER="${SOURCE_DIR}/scripts/apply_hub_update.js"
SOURCE_CLEANUP="${SOURCE_DIR}/scripts/cleanup_maiyen_hub_updater.js"
NEXT_UPDATER="${SOURCE_DIR}/scripts/apply_hub_update.next.js"
SERVICE_UNIT_SOURCE="${SOURCE_DIR}/systemd/maiyen-hub-backend.service"
SERVICE_UNIT_TARGET="/etc/systemd/system/maiyen-hub-backend.service"
CLEANUP_SERVICE_NAME="maiyen-hub-updater-cleanup.service"
CLEANUP_TIMER_NAME="maiyen-hub-updater-cleanup.timer"
CLEANUP_SERVICE_SOURCE="${SOURCE_DIR}/systemd/${CLEANUP_SERVICE_NAME}"
CLEANUP_TIMER_SOURCE="${SOURCE_DIR}/systemd/${CLEANUP_TIMER_NAME}"
CLEANUP_SERVICE_TARGET="/etc/systemd/system/${CLEANUP_SERVICE_NAME}"
CLEANUP_TIMER_TARGET="/etc/systemd/system/${CLEANUP_TIMER_NAME}"
BACKUP_ROOT="${MAIYEN_DEPLOY_BACKUP_ROOT:-/var/backups/maiyen-hub/manual-deploy}"
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
STAGE_DIR="${RUNTIME_DIR}/.deploy-stage-${STAMP}"
FILES=(
  "index.js"
  "backend_localizations.js"
  "system_version.js"
  "hub_update_contract.js"
  "hub_update_bridge.js"
  "hub_update_push.js"
  "hub_update_push_localizations.js"
  "presence_recovery.js"
  "firebase_write_policy.js"
  "domains/hub/hub_identity.js"
  "domains/hub/hub_heartbeat.js"
  "domains/shared/ordered_list_cleanup.js"
  "domains/notifications/fcm_delivery.js"
  "domains/notifications/scheduled_reminder.js"
  "domains/notifications/home_activity.js"
  "domains/system_health/system_health.js"
  "domains/presence/presence_session.js"
  "domains/auto_away/auto_away.js"
  "domains/runtime/local_runtime.js"
  "domains/devices/device_profile.js"
  "domains/alarm/alarm_schedule.js"
  "domains/alarm/alarm_incident.js"
  "domains/alarm/alarm_incident_lifecycle.js"
  "domains/alarm/alarm_incident_persistence.js"
  "domains/alarm/physical_siren.js"
  "domains/alarm/sensor_alarm_engine.js"
  "general_id.js"
  "package.json"
  "package-lock.json"
)
RETIRED_SOURCE_FILES=(
  "scripts/migrate_linux_identity_to_maiyen.sh"
  "scripts/rollback_linux_identity_to_safehome.sh"
  "tests/maiyen_linux_identity_migration.test.js"
)

DEPLOY_STARTED=0
ROLLBACK_RUNNING=0

cleanup_stage() {
  rm -rf "${STAGE_DIR}"
}

restore_file_if_backed_up() {
  local backup_path="$1"
  local destination="$2"

  if [[ -f "${backup_path}" ]]; then
    install -D -m "$(stat -c '%a' "${backup_path}")" \
      -o "$(stat -c '%U' "${backup_path}")" \
      -g "$(stat -c '%G' "${backup_path}")" \
      "${backup_path}" "${destination}"
  fi
}

restore_or_remove_file() {
  local backup_path="$1"
  local destination="$2"

  if [[ -f "${backup_path}" ]]; then
    restore_file_if_backed_up "${backup_path}" "${destination}"
  else
    rm -f "${destination}"
  fi
}

rollback_on_error() {
  local status=$?
  trap - ERR

  if [[ "${ROLLBACK_RUNNING}" -eq 1 ]]; then
    exit "${status}"
  fi
  ROLLBACK_RUNNING=1

  if [[ "${DEPLOY_STARTED}" -eq 1 ]]; then
    echo "Deploy lỗi. Đang rollback production và updater..." >&2

    for file in "${FILES[@]}"; do
      runtime_file="${RUNTIME_DIR}/${file}"
      backup_file="${BACKUP_DIR}/runtime/${file}"
      mkdir -p "$(dirname "${runtime_file}")"

      if [[ -f "${backup_file}" ]]; then
        cp -a "${backup_file}" "${runtime_file}"
      else
        rm -f "${runtime_file}"
      fi
    done

    restore_file_if_backed_up \
      "${BACKUP_DIR}/systemd/maiyen-hub-backend.service" \
      "${SERVICE_UNIT_TARGET}"
    restore_file_if_backed_up \
      "${BACKUP_DIR}/updater/hub_update_contract.js" \
      "${INSTALLED_CONTRACT}"
    restore_file_if_backed_up \
      "${BACKUP_DIR}/updater/apply_hub_update.js" \
      "${INSTALLED_UPDATER}"
    restore_or_remove_file \
      "${BACKUP_DIR}/updater/cleanup_maiyen_hub_updater.js" \
      "${INSTALLED_CLEANUP}"
    restore_or_remove_file \
      "${BACKUP_DIR}/systemd/${CLEANUP_SERVICE_NAME}" \
      "${CLEANUP_SERVICE_TARGET}"
    restore_or_remove_file \
      "${BACKUP_DIR}/systemd/${CLEANUP_TIMER_NAME}" \
      "${CLEANUP_TIMER_TARGET}"

    systemctl daemon-reload || true
    systemctl restart "${SERVICE_NAME}" || true
    sleep 5
    systemctl --no-pager --full status "${SERVICE_NAME}" || true
  fi

  cleanup_stage
  exit "${status}"
}

trap cleanup_stage EXIT
trap rollback_on_error ERR

if [[ "${EUID}" -ne 0 ]]; then
  echo "Lỗi: chạy bằng sudo bash scripts/deploy_backend_production.sh" >&2
  exit 1
fi

if ! getent group "${SERVICE_GROUP}" >/dev/null; then
  echo "Lỗi: chưa có group ${SERVICE_GROUP}." >&2
  exit 1
fi

if ! systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; then
  echo "Lỗi: chưa có service ${SERVICE_NAME}." >&2
  exit 1
fi

for directory in "${SOURCE_DIR}" "${RUNTIME_DIR}" "${INSTALL_ROOT}/scripts"; do
  if [[ ! -d "${directory}" ]]; then
    echo "Lỗi: thiếu thư mục ${directory}." >&2
    exit 1
  fi
done

if [[ ! -f "${RUNTIME_DIR}/serviceAccount.json" ]]; then
  echo "Lỗi: thiếu ${RUNTIME_DIR}/serviceAccount.json" >&2
  exit 1
fi

for file in "${FILES[@]}"; do
  if [[ ! -f "${SOURCE_DIR}/${file}" ]]; then
    echo "Lỗi: thiếu ${SOURCE_DIR}/${file}" >&2
    exit 1
  fi
done

for file in \
  "${SOURCE_CONTRACT}" \
  "${SOURCE_CLEANUP}" \
  "${SERVICE_UNIT_SOURCE}" \
  "${CLEANUP_SERVICE_SOURCE}" \
  "${CLEANUP_TIMER_SOURCE}" \
  "${INSTALLED_CONTRACT}" \
  "${INSTALLED_UPDATER}"; do
  if [[ ! -f "${file}" ]]; then
    echo "Lỗi: thiếu ${file}" >&2
    exit 1
  fi
done

UPDATER_CANDIDATE="${SOURCE_UPDATER}"
if [[ -f "${NEXT_UPDATER}" ]]; then
  UPDATER_CANDIDATE="${NEXT_UPDATER}"
fi

if [[ ! -f "${UPDATER_CANDIDATE}" ]]; then
  echo "Lỗi: thiếu updater candidate ${UPDATER_CANDIDATE}" >&2
  exit 1
fi

echo "=== MAIYEN DEPLOY TARGET ==="
echo "Source   : ${SOURCE_DIR}"
echo "Runtime  : ${RUNTIME_DIR}"
echo "Service  : ${SERVICE_NAME}"
echo "Group    : ${SERVICE_GROUP}"
echo "Updater  : ${UPDATER_CANDIDATE}"
echo "Cleanup  : ${SOURCE_CLEANUP}"

echo "=== 1/6 TEST BACKEND ==="
runuser -u "${RUN_USER}" -- bash -lc "cd '${SOURCE_DIR}' && npm test"
/usr/bin/node --check "${UPDATER_CANDIDATE}"
/usr/bin/node --check "${SOURCE_CLEANUP}"
/usr/bin/node --check "${SOURCE_CONTRACT}"

echo "=== 2/6 BACKUP PRODUCTION + SYSTEM ASSETS ==="
install -d -m 0700 -o root -g root \
  "${BACKUP_DIR}/runtime" \
  "${BACKUP_DIR}/systemd" \
  "${BACKUP_DIR}/updater"

for file in "${FILES[@]}"; do
  runtime_file="${RUNTIME_DIR}/${file}"
  backup_file="${BACKUP_DIR}/runtime/${file}"

  if [[ -f "${runtime_file}" ]]; then
    mkdir -p "$(dirname "${backup_file}")"
    cp -a "${runtime_file}" "${backup_file}"
  fi
done

cp -a "${SERVICE_UNIT_TARGET}" \
  "${BACKUP_DIR}/systemd/maiyen-hub-backend.service"
cp -a "${INSTALLED_CONTRACT}" \
  "${BACKUP_DIR}/updater/hub_update_contract.js"
cp -a "${INSTALLED_UPDATER}" \
  "${BACKUP_DIR}/updater/apply_hub_update.js"

for optional_pair in \
  "${INSTALLED_CLEANUP}|${BACKUP_DIR}/updater/cleanup_maiyen_hub_updater.js" \
  "${CLEANUP_SERVICE_TARGET}|${BACKUP_DIR}/systemd/${CLEANUP_SERVICE_NAME}" \
  "${CLEANUP_TIMER_TARGET}|${BACKUP_DIR}/systemd/${CLEANUP_TIMER_NAME}"; do
  source_path="${optional_pair%%|*}"
  backup_path="${optional_pair#*|}"
  if [[ -f "${source_path}" ]]; then
    cp -a "${source_path}" "${backup_path}"
  fi
done

echo "Backup: ${BACKUP_DIR}"

echo "=== 3/6 STAGE + VALIDATE FILES ==="
mkdir -p "${STAGE_DIR}"
for file in "${FILES[@]}"; do
  staged="${STAGE_DIR}/${file}"
  mkdir -p "$(dirname "${staged}")"
  cp "${SOURCE_DIR}/${file}" "${staged}"

  if [[ -f "${BACKUP_DIR}/runtime/${file}" ]]; then
    chown --reference="${BACKUP_DIR}/runtime/${file}" "${staged}"
    chmod --reference="${BACKUP_DIR}/runtime/${file}" "${staged}"
  else
    chown root:"${SERVICE_GROUP}" "${staged}"
    chmod 0640 "${staged}"
  fi
done

/usr/bin/node --check "${STAGE_DIR}/index.js"
/usr/bin/node --check "${STAGE_DIR}/backend_localizations.js"
/usr/bin/node --check "${STAGE_DIR}/system_version.js"
/usr/bin/node --check "${STAGE_DIR}/hub_update_contract.js"
/usr/bin/node --check "${STAGE_DIR}/hub_update_bridge.js"
/usr/bin/node --check "${STAGE_DIR}/hub_update_push.js"
/usr/bin/node --check "${STAGE_DIR}/hub_update_push_localizations.js"
/usr/bin/node --check "${STAGE_DIR}/presence_recovery.js"
/usr/bin/node --check "${STAGE_DIR}/firebase_write_policy.js"
/usr/bin/node --check "${STAGE_DIR}/domains/hub/hub_identity.js"
/usr/bin/node --check "${STAGE_DIR}/domains/hub/hub_heartbeat.js"
/usr/bin/node --check "${STAGE_DIR}/domains/shared/ordered_list_cleanup.js"
/usr/bin/node --check "${STAGE_DIR}/domains/notifications/fcm_delivery.js"
/usr/bin/node --check "${STAGE_DIR}/domains/notifications/scheduled_reminder.js"
/usr/bin/node --check "${STAGE_DIR}/domains/notifications/home_activity.js"
/usr/bin/node --check "${STAGE_DIR}/domains/system_health/system_health.js"
/usr/bin/node --check "${STAGE_DIR}/domains/presence/presence_session.js"
/usr/bin/node --check "${STAGE_DIR}/domains/auto_away/auto_away.js"
/usr/bin/node --check "${STAGE_DIR}/domains/runtime/local_runtime.js"
/usr/bin/node --check "${STAGE_DIR}/domains/devices/device_profile.js"
/usr/bin/node --check "${STAGE_DIR}/domains/alarm/alarm_schedule.js"
/usr/bin/node --check "${STAGE_DIR}/domains/alarm/alarm_incident.js"
/usr/bin/node --check "${STAGE_DIR}/domains/alarm/alarm_incident_lifecycle.js"
/usr/bin/node --check "${STAGE_DIR}/domains/alarm/alarm_incident_persistence.js"
/usr/bin/node --check "${STAGE_DIR}/domains/alarm/physical_siren.js"
/usr/bin/node --check "${STAGE_DIR}/domains/alarm/sensor_alarm_engine.js"
/usr/bin/node --check "${STAGE_DIR}/general_id.js"
/usr/bin/node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${STAGE_DIR}/package.json"
/usr/bin/node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${STAGE_DIR}/package-lock.json"

DEPLOY_STARTED=1

echo "=== 4/6 INSTALL UPDATER + SYSTEMD UNITS ==="
install -D -m 0644 -o root -g root \
  "${SOURCE_CONTRACT}" \
  "${INSTALLED_CONTRACT}.new"
mv "${INSTALLED_CONTRACT}.new" "${INSTALLED_CONTRACT}"

install -D -m 0755 -o root -g root \
  "${SOURCE_CLEANUP}" \
  "${INSTALLED_CLEANUP}.new"
mv "${INSTALLED_CLEANUP}.new" "${INSTALLED_CLEANUP}"

install -D -m 0755 -o root -g root \
  "${UPDATER_CANDIDATE}" \
  "${INSTALLED_UPDATER}.new"
mv "${INSTALLED_UPDATER}.new" "${INSTALLED_UPDATER}"

install -m 0644 -o root -g root \
  "${SERVICE_UNIT_SOURCE}" \
  "${SERVICE_UNIT_TARGET}"
install -m 0644 -o root -g root \
  "${CLEANUP_SERVICE_SOURCE}" \
  "${CLEANUP_SERVICE_TARGET}"
install -m 0644 -o root -g root \
  "${CLEANUP_TIMER_SOURCE}" \
  "${CLEANUP_TIMER_TARGET}"
systemctl daemon-reload

echo "=== 5/6 ACTIVATE + RESTART BACKEND ==="
for file in "${FILES[@]}"; do
  runtime_file="${RUNTIME_DIR}/${file}"
  mkdir -p "$(dirname "${runtime_file}")"
  mv "${STAGE_DIR}/${file}" "${runtime_file}"
done

systemctl restart "${SERVICE_NAME}"
sleep 8

if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "Backend không active sau deploy." >&2
  false
fi

echo "=== 6/6 VERIFY + FINALIZE SOURCE ==="
for file in "${FILES[@]}"; do
  source_hash="$(sha256sum "${SOURCE_DIR}/${file}" | awk '{print $1}')"
  runtime_hash="$(sha256sum "${RUNTIME_DIR}/${file}" | awk '{print $1}')"
  echo "${file}: source=${source_hash} runtime=${runtime_hash}"

  if [[ "${source_hash}" != "${runtime_hash}" ]]; then
    echo "Hash không khớp cho ${file}." >&2
    false
  fi
done

install -m 0755 -o "${RUN_USER}" -g "${RUN_GROUP}" \
  "${UPDATER_CANDIDATE}" \
  "${SOURCE_UPDATER}.new"
mv "${SOURCE_UPDATER}.new" "${SOURCE_UPDATER}"
rm -f "${NEXT_UPDATER}"

for relative_path in "${RETIRED_SOURCE_FILES[@]}"; do
  rm -f "${SOURCE_DIR}/${relative_path}"
done

systemctl enable --now "${CLEANUP_TIMER_NAME}"

if ! /usr/bin/node "${INSTALLED_CLEANUP}"; then
  echo "Cảnh báo: cleanup sau deploy chưa chạy thành công; timer vẫn đã được cài." >&2
fi

systemctl --no-pager --full status "${SERVICE_NAME}"
systemctl --no-pager --full status "${CLEANUP_TIMER_NAME}"
journalctl -u "${SERVICE_NAME}" -n 60 --no-pager

DEPLOY_STARTED=0
trap - ERR

echo "MAIYEN BACKEND DEPLOYED SUCCESSFULLY"
