# ANTU · 安途旅行

埃及旅行探索原型与旅行决策后端。

## 在线体验

### [打开安途 · 埃及旅行](https://antu-travel.paulkellermanhai.chatgpt.site/)

**手机、电脑浏览器直接打开，无需下载代码或启动本地服务。**

进入网页后，点击 **“我想去埃及”**，即可开始探索城市、查看体验并尝试规划行程。

> 交通和费用为示例，不能作为实时预订依据。浏览器记录不跨设备同步。

[网页源代码](prototypes/egypt-trip/) · [本地运行与网站更新说明](docs/development/local-preview.md) · [项目地图](docs/project-map.md)

## 启动本地网页

macOS 双击根目录 **`启动安途.command`**；也可以在工程根目录运行：

```sh
python3 scripts/serve-prototype.py
```

浏览器打开 <http://localhost:8080/>。需要 Python 3，无需先安装 Node、数据库或模型密钥。保持启动终端打开，按 Ctrl+C 停止。

网页会加载已有城市、体验、地图和交通示例。聊天、兴趣、旅行条件及行程保存在当前浏览器；刷新可以恢复。浏览器、主机名和端口必须保持一致。详见[本地网页说明](docs/development/local-preview.md)。

## 从哪里改代码

| 工作 | 入口 |
|---|---|
| 网页结构、样式和交互 | [prototypes/egypt-trip/](prototypes/egypt-trip/) |
| 聊天交互、城市资料、浏览器记录 | [app.js](prototypes/egypt-trip/app.js) |
| 城市预设问答与探索建议 | [exploration.js](prototypes/egypt-trip/exploration.js) |
| 旅行状态与修改确认 | [src/server/trip-state/](src/server/trip-state/) |
| 当前任务的上下文、保存恢复 | [src/server/decision-context/](src/server/decision-context/) |
| 下一步行动与工具执行 | [src/server/next-action-policy/](src/server/next-action-policy/) |
| 身份、权限、业务接口 | [src/server/auth/](src/server/auth/)、[src/server/http/](src/server/http/) |
| 数据库结构及迁移 | [prisma/](prisma/)及各模块 SQL |
| 自动化测试 | [tests/](tests/) |

完整文件导览见[项目地图](docs/project-map.md)，其他命令见[脚本目录说明](scripts/README.md)。

## 后端开发

后端使用仓库指定的 Node 24.22.1、npm 11.19.1、PostgreSQL 17。进入根目录后：

```sh
nvm install
nvm use
npm ci
cp .env.example .env
docker compose up -d db
npm run dev
```

上述命令启动 Next.js 工程（默认 3000 端口），其首页仍是工程占位页；数据库身份、认证和测试库需要继续按[后端环境说明](docs/development/backend-environment.md)及[工程交接](handoff/README.md)配置。E03/E04 SQL 当前也不能仅靠普通 Prisma 迁移就视为生产配置完成。

## 验证

```sh
npm run project:check     # 文件位置、当前文档链接和归档回执完整性
npm run test:prototype   # 聊天保存与旧记录兼容，不需要安装 npm 依赖
npm run specs:verify     # 冻结来源完整性
npm run check            # 合同、Prisma、类型、Lint、测试与构建；需要完整开发环境
npm run db:check         # 需要数据库配置
```

## 文档导航

[文档入口](docs/README.md)区分当前说明与历史记录。[历史归档](docs/archive/README.md)保留验收、来源和独立候选，不参与网页启动。`specs/` 包含运行合同与测试依赖，不是可直接删除的杂项。[文件管理规则](docs/file-management.md)说明后续内容如何归位。
