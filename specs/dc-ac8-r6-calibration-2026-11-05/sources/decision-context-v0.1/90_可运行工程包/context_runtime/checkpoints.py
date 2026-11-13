"""Durable, owner/trip-scoped runtime checkpoints; never a Trip State database.

SQLite transaction + CAS + receipt makes a lost acknowledgement safely retryable.
Each call opens its own connection: distinct instances/processes share no Python lock.
"""
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
import json
import os
import sqlite3
from tripstate.engine import digest
from tripstate.rules import instant, stamp
from .errors import RuntimeFault, check


class CheckpointRepository:
    def __init__(self, path, retention_seconds=None):
        self.path = Path(path).absolute()
        check(not self.path.is_symlink(), "CHECKPOINT_STORAGE", "检查点路径不能是符号链接")
        check(retention_seconds is None or type(retention_seconds) is int and retention_seconds > 0,
              "CHECKPOINT_POLICY", "保留期限须由宿主明确配置正整数或无自动到期")
        self.retention_seconds = retention_seconds
        self.failpoint = None  # test-only seam; never accepted from request JSON
        if not self.path.exists():
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
            except FileExistsError:
                pass  # another process initialized this host-controlled path first
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                version = db.execute("PRAGMA user_version").fetchone()[0]
                tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                check(version in (0, 1) and (version == 1 or not tables),
                      "CHECKPOINT_DB_VERSION", "不是支持的检查点数据库；禁止隐式覆盖/降级")
                db.execute("""CREATE TABLE IF NOT EXISTS checkpoints (
                    owner TEXT NOT NULL, trip TEXT NOT NULL, workspace TEXT NOT NULL,
                    revision INTEGER NOT NULL, payload TEXT, payload_digest TEXT,
                    saved_at TEXT NOT NULL, expires_at TEXT, deleted INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(owner, trip, workspace))""")
                db.execute("""CREATE TABLE IF NOT EXISTS receipts (
                    owner TEXT NOT NULL, trip TEXT NOT NULL, workspace TEXT NOT NULL,
                    operation_key TEXT NOT NULL, request_digest TEXT NOT NULL, ack TEXT NOT NULL,
                    PRIMARY KEY(owner, trip, workspace, operation_key))""")
                db.execute("PRAGMA user_version=1")
                db.execute("COMMIT")
            except BaseException:
                if db.in_transaction: db.execute("ROLLBACK")
                raise

    @contextmanager
    def _connection(self):
        db = None
        try:
            db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA secure_delete=ON")
            yield db
        except sqlite3.Error as exc:
            raise RuntimeFault("CHECKPOINT_STORAGE", "检查点存储不可用；未确认保存，请使用相同请求重试", True) from exc
        finally:
            if db is not None:
                db.close()

    def _live(self, row, now):
        check(row is not None and not row["deleted"], "CHECKPOINT_NOT_FOUND", "没有可恢复的工作现场")
        check(row["expires_at"] is None or instant(row["expires_at"]) > now,
              "CHECKPOINT_EXPIRED", "工作现场已按宿主保留策略到期")

    def _head(self, db, identity):
        return db.execute("SELECT * FROM checkpoints WHERE owner=? AND trip=? AND workspace=?", identity).fetchone()

    def load(self, owner, trip, workspace, now):
        with self._connection() as db:
            row = self._head(db, (owner, trip, workspace))
            self._live(row, now)
            try:
                payload = json.loads(row["payload"])
            except (TypeError, ValueError) as exc:
                raise RuntimeFault("CHECKPOINT_CORRUPT", "检查点内容损坏，不能伪造恢复") from exc
            check(digest(payload) == row["payload_digest"], "CHECKPOINT_CORRUPT", "检查点摘要不一致")
            return dict(revision=row["revision"], saved_at=row["saved_at"], expires_at=row["expires_at"],
                        payload_digest=row["payload_digest"], payload=payload)

    def revision(self, owner, trip, workspace):
        with self._connection() as db:
            row = self._head(db, (owner, trip, workspace))
            return row["revision"] if row else 0

    def list(self, owner, trip, now):
        with self._connection() as db:
            rows = db.execute("SELECT workspace,revision,saved_at,expires_at,deleted FROM checkpoints WHERE owner=? AND trip=? ORDER BY workspace", (owner, trip)).fetchall()
            return [dict(workspace_key=r["workspace"], checkpoint_revision=r["revision"], saved_at=r["saved_at"],
                         expires_at=r["expires_at"], available=not r["deleted"] and (r["expires_at"] is None or instant(r["expires_at"]) > now))
                    for r in rows]

    def save(self, owner, trip, workspace, expected_revision, key, payload, now):
        return self._write(owner, trip, workspace, expected_revision, key, payload, now, False)

    def delete(self, owner, trip, workspace, expected_revision, key, now):
        return self._write(owner, trip, workspace, expected_revision, key, None, now, True)

    def _write(self, owner, trip, workspace, expected_revision, key, payload, now, deleted):
        identity = (owner, trip, workspace)
        request_digest = digest(dict(expected_revision=expected_revision, payload=payload, deleted=deleted))
        with self._connection() as db:
            committed = False
            try:
                db.execute("BEGIN IMMEDIATE")
                row = self._head(db, identity)
                revision = row["revision"] if row else 0
                receipt = db.execute("SELECT request_digest,ack FROM receipts WHERE owner=? AND trip=? AND workspace=? AND operation_key=?", (*identity, key)).fetchone()
                if receipt:
                    check(receipt["request_digest"] == request_digest, "CHECKPOINT_IDEMPOTENCY", "同一保存键不能对应不同内容")
                    ack = json.loads(receipt["ack"])
                    check(revision == ack["checkpoint_revision"], "CHECKPOINT_SUPERSEDED", "此保存回执已被较新检查点覆盖，先读取当前版本", True)
                    db.execute("COMMIT")
                    return ack
                check(revision == expected_revision, "CHECKPOINT_CONFLICT", "其他会话已更新现场；禁止静默覆盖", True)
                check(not deleted or row is not None and not row["deleted"], "CHECKPOINT_NOT_FOUND", "没有可删除的现场")
                if not deleted and row and not row["deleted"]:
                    self._live(row, now)
                saved_at = stamp(now)
                expires_at = stamp(now + timedelta(seconds=self.retention_seconds)) if self.retention_seconds is not None and not deleted else None
                payload_digest = digest(payload) if payload is not None else None
                ack = dict(workspace_key=workspace, checkpoint_revision=revision+1, saved_at=saved_at,
                           expires_at=expires_at, payload_digest=payload_digest, durable=True, deleted=deleted)
                db.execute("INSERT INTO checkpoints VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,trip,workspace) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,payload_digest=excluded.payload_digest,saved_at=excluded.saved_at,expires_at=excluded.expires_at,deleted=excluded.deleted",
                           (*identity, revision+1, json.dumps(payload, ensure_ascii=False, sort_keys=True) if payload is not None else None,
                            payload_digest, saved_at, expires_at, int(deleted)))
                if deleted:
                    # Remove all earlier receipts; no old successful save may resurrect deleted data.
                    db.execute("DELETE FROM receipts WHERE owner=? AND trip=? AND workspace=?", identity)
                db.execute("INSERT INTO receipts VALUES(?,?,?,?,?,?)", (*identity, key, request_digest, json.dumps(ack)))
                if self.failpoint:
                    self.failpoint("before_commit")
                db.execute("COMMIT")
                committed = True
                if self.failpoint:
                    self.failpoint("after_commit")
                return ack
            except BaseException as exc:
                if not committed and db.in_transaction:
                    db.execute("ROLLBACK")
                if committed:
                    raise RuntimeFault("CHECKPOINT_ACK_UNKNOWN", "提交后回执未确认；使用原键原内容重试，不要假报保存失败或成功", True) from exc
                raise
