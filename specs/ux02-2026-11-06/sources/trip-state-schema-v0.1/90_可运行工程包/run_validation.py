"""One command: validate delivered contracts/examples, run tests, report, package."""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import time
import unittest
from datetime import datetime, timezone
from package_bundle import source_files, write_bundle, write_reading_copies

ROOT = Path(__file__).resolve().parent
NOT_TESTED = [
    "真实 LLM 状态抽取、否定/范围理解及模型准确率",
    "P03 理解纠错/真实变化分类、P04 真实展示机会与个性化、P05 澄清内容及模糊预算跨会话消费",
    "P01/P15/P16/P19 候选行动覆盖、V/C/E、累计负担、介入时机及行动效果",
    "真实交通、费用、开放条件、许可、库存和可购买性",
    "真实住宿预订／取消回执可信度、入住日期与骨架夜数的完整对齐、订单交易与支付",
    "生产身份认证、旅行访问控制及真实供应商信任链",
    "生产数据库事务、跨进程并发、宕机与断电恢复",
    "后台定时器、真实 HTTP 部署、网络端到端及 UI 交互",
    "完整路线优化、换乘安全裕量、疲劳、个体/局部细粒度约束计算",
    "全程成本、汇率转换、真实用户效果与性能基准",
    "所有状态转换组合的穷举覆盖与代码行覆盖率",
]


class Results(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.rows = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.rows.append(dict(test=test.id(), outcome="passed"))

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.rows.append(dict(test=test.id(), outcome="failed", detail=self._exc_info_to_string(err, test)))

    def addError(self, test, err):
        super().addError(test, err)
        self.rows.append(dict(test=test.id(), outcome="error", detail=self._exc_info_to_string(err, test)))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.rows.append(dict(test=test.id(), outcome="skipped", reason=reason))

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err:
            self.rows.append(dict(test=subtest.id(), outcome="failed_subtest", detail=self._exc_info_to_string(err, test)))


def main():
    started = time.perf_counter()
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
    result = unittest.TextTestRunner(verbosity=2, resultclass=Results).run(suite)
    timestamp = datetime.now(timezone.utc).isoformat()
    dependencies = {line.split("==")[0]: importlib.metadata.version(line.split("==")[0])
                    for line in (ROOT / "requirements.txt").read_text().splitlines() if "==" in line}
    locked = {line.split("==")[0]: line.split("==")[1] for line in (ROOT / "requirements.txt").read_text().splitlines() if "==" in line}
    lock_ok = dependencies == locked
    report = dict(schema_version="0.1.0", executed_at_utc=timestamp, python=platform.python_version(),
                  platform=platform.platform(), dependencies=dependencies, dependency_lock_matches=lock_ok,
                  test_cases_run=result.testsRun, passed=sum(r["outcome"] == "passed" for r in result.rows),
                  failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
                  duration_seconds=round(time.perf_counter() - started, 3),
                  successful=result.wasSuccessful() and lock_ok, tests=result.rows, not_tested=NOT_TESTED)
    (ROOT / "validation-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# 实际验证报告", "", f"执行时间（UTC）：{timestamp}", "", f"结果：{'通过' if report['successful'] else '未通过'}。",
             "", f"运行 {result.testsRun} 个测试方法；通过 {report['passed']}；失败 {len(result.failures)}；错误 {len(result.errors)}；跳过 {len(result.skipped)}。",
             f"耗时 {report['duration_seconds']} 秒。统计以测试方法为单位，参数化 subTest 不虚增总数。", "",
             f"环境：Python {report['python']}；{report['platform']}。固定依赖匹配：{lock_ok}。", "",
             "## 实际验证范围", "", "- 所有交付 Schema 的 2020-12 元规范合法性、与声明源一致性以及离线引用。",
             "- 根状态、12 类对象／记录、请求响应、负例与多轮样例的结构和关系语义。",
             "- 偏好机制 B、假设隔离、权限与确认、预算、事实层级、时效、局部依赖及上下文。",
             "- 内存原子提交、两线程旅行版本冲突、幂等请求、提交前与确认阶段故障注入。",
             "- 有限确定性计算与本地 API 适配器；使用合成数据，不调用真实模型或供应商。", "",
             "- A–G 七条合成旅行场景、31 步状态更新轨迹的独立重跑；受限住宿回执城市冲突及可信取消守卫。", "",
             "- 已确认决定的主体匹配、撤销提案拒绝、争议证据阻断采用、既有决定保留及替代路径。", 
             "- A/C 域 TS 状态层专项：同输入两条局部纠错、P04-S03 三项弱兴趣、P05-S04 未齐口径预算拒绝；真实展示、语义澄清和预算跨会话消费按其他模块联测验收。", "",
             "- UX02 新增恢复编译、预览适配、历史/城市范围、当前约束和事实重查、幂等/故障、体验城市保护；详见 tests/test_ux02.py。", "",
             "## 未测试／未实现范围", ""]
    lines += ["- " + item for item in NOT_TESTED]
    lines += ["", "以上未测项不是跳过的自动化用例，不能以 skipped=0 解释为所有能力已经验证。", "",
              "## 复现和证据", "", "在本目录执行 `.venv/bin/python run_validation.py`。逐项测试结果、错误详情与依赖版本保存在 validation-results.json；需求映射见 TRACEABILITY.md。",
             "文件指纹见 artifact-manifest.json。压缩包根目录的 00_从这里开始.md 与 package-index.json 提供阅读及机器定位；阅读镜像链接与源文件一致性由打包校验。只有 successful=true 且依赖匹配时本包自动更新交付压缩包。测试运行不修改原始项目资料。"]
    (ROOT / "VALIDATION_REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in source_files(ROOT) if p.name != "artifact-manifest.json"}
    (ROOT / "artifact-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if report["successful"]:
        write_reading_copies(ROOT, ROOT.parent)
        write_bundle(ROOT, ROOT.parent / "trip-state-schema-v0.1.zip")
    print(json.dumps({k: report[k] for k in ("test_cases_run", "passed", "failures", "errors", "skipped", "successful")}, ensure_ascii=False))
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    sys.exit(main())
