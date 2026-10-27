# Trip State Schema V0.1 工程交付包

本包是正式工程契约与可运行参考实现，面向后续 Demo 开发。当前有效旅行状态、用户价值选择和外部事实核验独立维护。

本轮 V1 评审收口请从 [Final Candidate 总索引](FINAL_CANDIDATE.md) 阅读；此前 0.1.0 的 9 域、10 对象、2 记录与机制 B 保持为基线。

给非工程读者的分层压缩包导览见 [从这里开始](PACKAGE_GUIDE.md)。压缩包根目录另有 `package-index.json`，供后续开发系统按主题和文件指纹定位；`90_可运行工程包` 保留本目录原结构，其他主题目录是自动生成的阅读镜像。

- [正式工程规格](SPECIFICATION.md)：范围、权威来源、维护机制、接口、兼容及边界。
- [字段字典](FIELD_DICTIONARY.md)、[正式状态转换表](STATE_TRANSITIONS.md)。
- [共享与嵌套字段规范](SHARED_TYPES.md)、[全局一致性终检](CONSISTENCY_REVIEW.md)。
- [最终字段字典](FIELD_DICTIONARY_FINAL.md)、[枚举词典](ENUM_GLOSSARY.md)、[关系规格](OBJECT_RELATIONSHIPS_FINAL.md)、[生命周期](LIFECYCLE_FINAL.md)、[状态转换矩阵](STATE_TRANSITIONS_FINAL.md)。
- [跨对象传播](PROPAGATION_FINAL.md)、[写入权限与来源](AUTHORITY_FINAL.md)、[历史与审计](HISTORY_FINAL.md)、[不变量](INVARIANTS_FINAL.md)、[七场景验证](SCENARIO_VALIDATION.md)、[V1 评审判断](V1_READINESS.md)。
- [实际验证报告](VALIDATION_REPORT.md)：以本次真实运行结果为准。
- [需求与测试追踪](TRACEABILITY.md)：来源、规则、测试及未实现能力。
- `schemas/`：离线可解析的 JSON Schema Draft 2020-12。
- `examples/`：完整埃及测试状态、12 类实例、请求响应、反例和多轮变化。
- `tripstate/`、`tests/`：参考实现及自动化测试。

## 重现验证

在本目录执行，使用 Python 3.13：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run_validation.py
```

安装依赖需要网络；安装后验证不调用网络、模型或旅行服务。`run_validation.py` 不自动重新生成契约，以免掩盖文件不一致；它核对已交付 JSON 与声明源、运行测试、检查样例，然后更新报告和交付压缩包。

若修改声明源或需要重新生成合成样例，先运行 `.venv/bin/python build.py`，再运行验证。生成过程仅写入本交付目录。

## 接入约定

`tripstate.api.dispatch(store, method, path, body, actor)` 是 HTTP 契约的本地适配器，不监听网络端口。`Actor` 必须由宿主完成身份认证、旅行访问授权后注入；绝不能取自请求 JSON。示例 Actor 只是测试桩。

金额使用最小币种单位整数，例如 CNY 120000 表示测试分项人民币 1200 元；无汇率转换。样例中全部地理内容、时刻、价格和来源仅用于测试，不代表真实班次、费用或覆盖。

本包没有完整路线优化器、真实 LLM 抽取、生产持久化、后台调度或界面。测试通过只证明报告所列输入下的本地规则行为。隐私留存、实际供应商、模型和部署选型另行接入。
