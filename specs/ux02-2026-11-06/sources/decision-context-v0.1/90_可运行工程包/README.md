# 决策上下文｜可运行参考包

2026-11-05/AC8：原 0.1.0 的 20 份机器合同与 Checkpoint 格式 1 不变；`runtime.py` 的事实注释遵循 TS 当前 `stale_fact_ids`。AC8 累计六项参考专项，实际数量见[本次报告](VALIDATION_REPORT.md)。跨轮未提交原话由受信宿主记录承载，**可信事件先记录、Task 后关联**；当前参考 Runtime 没有宿主日志接口，相关联测待 E03。追踪、能力、验证和宿主数据契约见上层 `03_评审与工程衔接/12_`～`16_` 文件；本地参考测试不代替真实工程验收。

2026-10-24/R4：首版 P0 跨会话精确恢复已实现并通过本地 SQLite、新进程、并发及强制终止验收。任务、草稿、比较版本和语义焦点可恢复；依据按当前状态重建，旧授权不复活。最新结果见 VALIDATION_REPORT.md。

状态：Decision Context 首版运行协议 0.1.0 的本地参考实现，工程候选待审核；跨会话恢复属于同一首版合同。不是已上线的 HTTP/鉴权/前端/LLM 服务。产品说明从上层 `00_从这里开始.md` 进入。

## 1. 接入顺序

1. 阅读 `../04_工程规格/01_运行契约与任务定位.md` 至 `05_持久检查点与跨会话恢复规格.md`。
2. 从 `schemas/` 选接口合同；完整结构查 FIELD_DICTIONARY.md。
3. 用 context_runtime/contracts.py 核对声明源，runtime.py 核对规则，api.py 核对 HTTP 行为合同。
4. 运行 tests/test_runtime.py、tests/test_recovery.py 与继承回归；实际结果以 VALIDATION_REPORT.md、validation-results.json 为准。

## 2. 依赖与运行

需要相邻的 `../../trip-state-schema-v0.1/` 源包（schema_version=0.1.0），或该包中的 `90_可运行工程包/`；dependency.py 自动识别两种已知布局，来源指纹见上层追溯矩阵。这里没有复制第二份 Trip State 实现。单独复制本目录时必须同时提供该固定依赖目录。

实际测试使用 Python 3.13.5 和已固定的 requirements.txt；没有安装新网络依赖。在本目录、使用已安装这些依赖的 Python 环境执行（下方 python3 可替换为相应环境的 Python 绝对路径）：

```sh
python3 -B export_contracts.py
python3 -B run_validation.py
python3 -B update_package_index.py
```

导出只写本目录的 schemas/、examples/ 和 FIELD_DICTIONARY.md。验证只写本目录报告，并在临时目录执行原有生成对账与 SQLite 测试；不调用原包会更新报告/压缩包的验证入口。`-B` 和验证器的设置避免修改继承代码缓存。

核心 Python 接口：Runtime(store, checkpoints=CheckpointRepository(db_path), workspace_key="workspace")；原 open_turn / assemble / page / submit_change / confirm，以及 save_scene / restore_scene / delete_scene / list_scenes / scene_status / retry_scene_save。Principal 与 WriteGrant 只由宿主注入。`api.dispatch` 是同进程入口，不监听网络。未配置后端的旧用法 Runtime(store) 仅供共用逻辑隔离测试，恢复状态明确返回不可用，不能作为 P0 产品配置。

db_path 必须是宿主控制的本机应用数据目录，不能放在本工程包或 iCloud 同步目录。生产多设备经中心服务访问事务存储，不同步数据库文件。客户端负责按契约自动提交语义视图/草稿并处理保存状态；本包不包含真实前端。

## 3. 工程包里有什么

| 位置 | 用途 |
|---|---|
| context_runtime/contracts.py | 二十份当前运行 Schema 的唯一声明源，离线引用原业务合同 |
| schemas/ | 20 份首版 0.1.0 合同，包含跨会话恢复接口；禁止额外字段 |
| FIELD_DICTIONARY.md | 自动生成的全路径结构字典；业务语义在工程规格 |
| context_runtime/runtime.py | 任务关联、双通道、快照/分层/时效、授权及原状态写入适配 |
| context_runtime/checkpoints.py / recovery.py / errors.py | 本地 SQLite 事务/CAS/回执；现场保存恢复与当前状态重建；稳定错误 |
| context_runtime/api.py | 本地 HTTP 行为调度与稳定错误映射 |
| tests/test_runtime.py | 新的可执行验收与反例；不是自然语言模型测试 |
| tests/test_recovery.py | DC-R01–07、新进程/跨进程并发、提交前后强制终止、回执丢失、授权隔离等 |
| export_contracts.py | 从声明源生成合同/字典，不维护重复字段 |
| run_validation.py | 新增与继承测试统一复跑、分别计数，生成结果 |
| update_package_index.py | 按当前文件刷新开发索引/指纹并校验本地链接；运行报告更新后再执行 |
| VALIDATION_REPORT.md / validation-results.json | 实际执行结果、范围和逐测试记录 |
| validation-output.txt | 原始执行日志，不包含真实用户或提供方数据 |
| examples/exploration.json | 可校验的合成请求/响应/分层包样例，不是实际模型输出 |
| examples/recovery.json | 真实临时 SQLite 生成的合成保存/恢复请求与回执；不交付用户数据库 |

## 4. 不能省略的信任边界

解释器提供的 task.kind/目标/因果语义需要独立验证；字符区段一致不是语义正确证明。Grant 绑定检查不是生产授权系统；同版引用不是现实事实有效性；分页发送不是模型已经理解；未知承认不是核验。本次数据库进程故障验收不是物理断电、生产分布式容灾或真实界面验收。

O1 已落实为持久运行检查点，与业务权威状态分离。恢复以最后成功保存回执为准，保存失败不能假报成功；恢复会重置授权代次，不重放原业务写入。生产实例隔离/释放、真实登录、保留策略、加密/备份与前端自动保存接入仍由宿主落实，本包未测负载和资源回收压力。

DC-AC8-PRIVACY-01 的宿主原话保留/删除产品策略已获 Owner 批准，详见[裁决记录](../03_评审与工程衔接/17_DC-AC8-PRIVACY-01_Owner裁决与执行边界.md)；它不改变本参考 Runtime 的 Checkpoint 格式或默认保留配置。宿主自动清理、主动删除、备份恢复、最小审计和用户告知须在 E03 原阶段实施并真实验收，不能以本包测试代替。

## 2026-11-06 UX02修订候选 R7

本轮规则、参考实现、验证与DC后续GitHub开发清单见[UX02工程映射](../03_评审与工程衔接/18_UX02行为落实与E03开发验收映射.md)；20份机器Schema/运行0.1.0/Checkpoint格式1不变。当前Gate仍待技术负责人审核，不启动生产Runtime、不修改NAP。
