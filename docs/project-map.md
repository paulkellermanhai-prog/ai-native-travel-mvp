# 项目地图

## 目录

```text
仓库根目录/
├── README.md                  日常阅读入口、启动与验证
├── AGENTS.md                  当前工程规则
├── 启动安途.command           macOS 一键打开本地网页
├── prototypes/egypt-trip/     原有 HTML 网页、JS 交互和素材
├── src/                       Next.js 和 TypeScript 业务后端
├── prisma/                    认证/旅行状态数据库结构和迁移
├── scripts/                   启动、合同生成、参考对照、数据库工具
├── tests/                     自动化测试和测试夹具
├── specs/                     不可变产品/合同/参考快照；运行和测试依赖
├── docs/                      当前说明、进度维护源
│   ├── development/           使用和环境配置
│   └── archive/               旧阶段报告、Gate 回执和治理记录
├── handoff/                   当前工程交接和独立候选补丁
├── .github/workflows/         CI
└── package*.json / 配置文件    保留根目录，供框架和工具使用
```

## 本地网页实际运行链路

`启动安途.command` → [serve-prototype.py](../scripts/serve-prototype.py) → [index.html](../prototypes/egypt-trip/index.html) → 配套 JavaScript → 浏览器 localStorage。

- [index.html](../prototypes/egypt-trip/index.html)：聊天框、地图、城市卡片和按钮的页面结构。
- [app.js](../prototypes/egypt-trip/app.js)：城市及基础体验资料、聊天分支、页面切换、记录读写。`send()` 处理输入，`say()` 添加回答，`save()` 保存当前记录。
- [exploration.js](../prototypes/egypt-trip/exploration.js)：城市/日期识别、兴趣和顾虑、城市预设问答及下一步建议。
- [skeleton.js](../prototypes/egypt-trip/skeleton.js)：按原型规则构建和显示旅行方案。
- [timeline.js](../prototypes/egypt-trip/timeline.js)：顺序、停留和草稿编辑。
- [hypothesis.js](../prototypes/egypt-trip/hypothesis.js)：假设预览和采用。
- [transport-fixtures.js](../prototypes/egypt-trip/transport-fixtures.js)：交通示例数据；[transport-connection.js](../prototypes/egypt-trip/transport-connection.js)负责展示。
- [assets/](../prototypes/egypt-trip/assets/)：图片、地理位置、地图及扩展体验。来源见[素材说明](../prototypes/egypt-trip/地图与照片来源.md)。

Python 启动器是本轮新增；原型主体和模板是原项目已有内容，聊天持久化是本轮修复。该启动链没有接 PostgreSQL 或真实模型。

## 业务后端

- [src/app/](../src/app/)：Next 页面及路由；首页目前仍是工程占位页。
- [trip-state/](../src/server/trip-state/)：权威旅行状态、命令、确认、事实和存储。
- [decision-context/](../src/server/decision-context/)：选择当前上下文、Packet、交付、检查点和恢复。
- [next-action-policy/](../src/server/next-action-policy/)：校验行动候选、选择行动、记录步骤及工具结果。
- [auth/](../src/server/auth/)及[http/](../src/server/http/)：会话、成员权限和 HTTP 边界。
- [schema.prisma](../prisma/schema.prisma)：基础数据库结构。DC/NAP 还依赖模块内 SQL，不能只看 Prisma 文件就认为包含全部数据库部署。

## 其他 Python 为什么存在

`scripts/*oracle.py`、`e03-01-reference.py` 等是对照和验证工具；`specs/` 深层目录中的 `tripstate/`、`context_runtime/` 是冻结参考实现。它们被测试引用，不能因网页没有执行就删除。完整用途见[脚本说明](../scripts/README.md)。
