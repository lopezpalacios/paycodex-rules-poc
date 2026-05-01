#!/usr/bin/env bash
# Snapshot a Besu chain data directory for offsite backup.
# Single-validator chain (besu/) — production replicates this script
# across all 4 validators in the multivalidator/ stack.
#
# Default behaviour: tar.gz of the docker named volume into a timestamped
# archive in besu/backups/. Encryption + offsite-upload are stubs that
# document where production wires its KMS / S3 / GCS path.
#
# Usage:
#   bash besu/backup.sh                          # local snapshot
#   PAYCODEX_BACKUP_DEST=s3://my-bucket/...      # set destination, then run
#   PAYCODEX_BACKUP_KMS=alias/paycodex-backup    # optional encryption key
#   bash besu/backup.sh --restore <archive>      # restore from a snapshot
#
# Production hardening notes:
#   - Schedule via cron / systemd timer / GitHub Actions (every 1h: incremental, every 24h: full)
#   - Encrypt before upload — `aws kms encrypt` or `gcloud kms encrypt` against a customer-managed key
#   - Verify SHA256 + decrypt-test on every snapshot before purging the previous one
#   - 3-2-1 rule: 3 copies, 2 different storage media, 1 offsite
#   - Test restore quarterly into a sandbox chain — restoring untested backups is the same as no backup

set -euo pipefail
cd "$(dirname "$0")/.."

VOLUME="${PAYCODEX_BACKUP_VOLUME:-besu_besu-data}"
DEST_DIR="${PAYCODEX_BACKUP_DIR:-besu/backups}"
DEST_REMOTE="${PAYCODEX_BACKUP_DEST:-}"
KMS_KEY="${PAYCODEX_BACKUP_KMS:-}"

mkdir -p "$DEST_DIR"

if [ "${1:-}" = "--restore" ]; then
  ARCHIVE="${2:-}"
  if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
    echo "usage: $0 --restore <archive.tar.gz>"
    exit 1
  fi
  echo "[backup] restoring $ARCHIVE → volume $VOLUME"
  docker run --rm -v "$VOLUME":/data -v "$(pwd)/$DEST_DIR":/backup alpine \
    sh -c "rm -rf /data/* && tar xzf /backup/$(basename "$ARCHIVE") -C /data"
  echo "[backup] restored. Restart the chain: docker compose -f besu/docker-compose.yml up -d"
  exit 0
fi

# Snapshot
TS=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$DEST_DIR/besu-data-$TS.tar.gz"

echo "[backup] snapshotting volume=$VOLUME → $ARCHIVE"
docker run --rm -v "$VOLUME":/data -v "$(pwd)/$DEST_DIR":/backup alpine \
  tar czf "/backup/besu-data-$TS.tar.gz" -C /data .

SIZE=$(du -h "$ARCHIVE" | cut -f1)
SHA=$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)
echo "[backup] $ARCHIVE size=$SIZE sha256=$SHA"

# Optional encryption (production)
if [ -n "$KMS_KEY" ]; then
  echo "[backup] encrypting under KMS key $KMS_KEY (placeholder — wire your own)"
  # Production:
  # aws kms encrypt --key-id "$KMS_KEY" \
  #   --plaintext fileb://"$ARCHIVE" \
  #   --output text --query CiphertextBlob | base64 -d > "$ARCHIVE.enc"
  # rm "$ARCHIVE"
  # ARCHIVE="$ARCHIVE.enc"
fi

# Optional offsite upload (production)
if [ -n "$DEST_REMOTE" ]; then
  echo "[backup] uploading to $DEST_REMOTE (placeholder — wire your own)"
  # Production:
  # aws s3 cp --sse aws:kms --sse-kms-key-id "$KMS_KEY" "$ARCHIVE" "$DEST_REMOTE/"
  # OR:
  # gcloud storage cp "$ARCHIVE" "$DEST_REMOTE/"
fi

echo "[backup] done. Manifest:"
ls -lh "$DEST_DIR"
