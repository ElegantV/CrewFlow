#!/usr/bin/env bash
# 生产数据库定时备份:pg_dump 导出 + gzip 压缩,自动清理超过保留期的旧备份。
#
# crontab 示例(每天 02:30 自动备份,crontab -e 添加):
#   30 2 * * * cd /部署目录/server && ./scripts/backup-database.sh >> backups/backup.log 2>&1
#
# 恢复示例:
#   gunzip -c backups/crewflow-20260906-023001.sql.gz | \
#     docker compose exec -T db psql --username crewflow --dbname crewflow
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/crewflow-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
# 容器内已有 POSTGRES_USER/POSTGRES_DB 环境变量,直接复用,宿主机无需解析 .env。
docker compose exec -T db sh -c 'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' | gzip > "$FILE"

# 完整性自检:压缩流必须可解且非空,防止磁盘写满等静默失败。
gzip -t "$FILE"
[ -s "$FILE" ]

find "$BACKUP_DIR" -name 'crewflow-*.sql.gz' -mtime "+$RETAIN_DAYS" -delete
echo "$(date '+%F %T') 备份完成: $FILE"
