# Decision Context 宿主实现

本目录包含证据、工作区、Turn/Task、Packet 交付与授权复验等宿主逻辑。当前模块与数据库/恢复/写桥的关系见 [E03 最终工程交接](../../../../docs/E03最终工程交接索引.md)。

- `evidence-host.ts`：真实 Session、旅行成员权限、私有能力、持久记录及执行边界。
- `evidence-event.ts`：将宿主取得的身份与输入整理为事件；数据形状通过不等于来源或授权通过。
- `packet-*.ts`：分页、交付和短事务交接。
- `lifecycle-adapter.ts`、`expiry-maintenance-candidate.ts`：内部生命周期与到期维护接点。
- `sql/`：内部宿主 SQL；正式生产迁移和运维仍有前置事项。

部分文件名保留 `candidate` 以保持既有导入、测试和来源关系。不能只凭文件名判定未实现或可删除。早期切片 README 已移入[历史材料](../../../../docs/archive/e03/host-runtime-early-slices.md)，其中测试数字和缺口属于对应历史时点。

本地网页启动器不自动启动此宿主；生产启用前置事项仍以最终交接索引为准。
