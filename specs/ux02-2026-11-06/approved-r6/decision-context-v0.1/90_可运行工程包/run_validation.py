"""Run new runtime tests and inherited tests without rebuilding inherited artifacts."""
import sys
import os
import json
import io
from pathlib import Path
from datetime import datetime, timezone
import unittest
import time

ROOT = Path(__file__).resolve().parent
from dependency import BASE
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(ROOT))


class Result(unittest.TextTestResult):
    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.records = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.records.append(dict(id=test.id(), outcome="passed"))

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.records.append(dict(id=test.id(), outcome="failed"))

    def addError(self, test, error):
        super().addError(test, error)
        self.records.append(dict(id=test.id(), outcome="error"))


def run():
    suite = unittest.TestSuite([
        unittest.TestLoader().discover(str(ROOT / "tests")),
        unittest.TestLoader().discover(str(BASE / "tests")),
    ])
    start = time.monotonic()
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=1, resultclass=Result).run(suite)
    seconds = time.monotonic() - start
    core = [r for r in result.records if r["id"].startswith("test_runtime.")]
    recovery = [r for r in result.records if r["id"].startswith("test_recovery.")]
    new = core + recovery
    old = [r for r in result.records if not r["id"].startswith(("test_runtime.", "test_recovery."))]
    report = dict(executed_at_utc=datetime.now(timezone.utc).isoformat(), python=sys.version.split()[0],
                  new_tests=len(new), runtime_core_tests=len(core), recovery_tests=len(recovery), inherited_tests=len(old), tests_run=result.testsRun,
                  failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
                  successful=result.wasSuccessful(), elapsed_seconds=round(seconds, 3),
                  scope="synthetic interpretations + runtime/state integration + real local SQLite + new-process recovery/concurrency/SIGKILL; no live LLM/provider/network HTTP/production DB", tests=result.records)
    (ROOT / "validation-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "validation-output.txt").write_text(stream.getvalue())
    (ROOT / "VALIDATION_REPORT.md").write_text(
        "# 实际运行验证报告\n\n执行 UTC：" + report["executed_at_utc"] +
        f"\n\n新增运行测试 {len(new)}（共用运行 {len(core)}、持久恢复 {len(recovery)}）；继承回归 {len(old)}；合计 {result.testsRun}。失败 {len(result.failures)}；错误 {len(result.errors)}；跳过 {len(result.skipped)}。\n\n" +
        f"结果：{'通过' if result.wasSuccessful() else '未通过'}。耗时 {seconds:.3f} 秒；Python {report['python']}。\n\n" +
        "AC8 累计新增 6 项专项：争议事实按当前 TS 投影受限且旧包失效、非原确认人撤销透传 PERMISSION、歧义原话跨会话只读恢复，以及最近任务事件不伪造旧轮、错误来源区段不覆盖最后成功点、单事件可注册多个 Task。后三项只验证现有 DC 合同与本地恢复边界，不是宿主记录、任务关联或真实语义联测。继承回归使用当前本地阶段 A Trip State 包；本报告不计作 GitHub E03 Runtime 测试。\n\n" +
        "本次确实重新执行继承测试，但未调用原包重写/打包入口。新测试输入为合成的结构化任务解释，证明封装守卫与状态集成，不证明模型能从任意自然语言正确定位任务。搁置提醒测试只证明呈现资格信号，不证明真实模型绝不重复提醒。\n\n" +
        f"持久恢复实际执行 {len(recovery)} 项，覆盖 DC-R01–07：本地 SQLite、独立进程恢复、跨进程 CAS、提交前/后 SIGKILL、丢回执幂等重试、草稿/语义视图/任务关系、当前依据重建、旧授权防重放、删除与保留到期。不是仅重建内存对象。\n\n" +
        "未验证：真实 LLM/工具/用户价值、生产鉴权与授权真实性、网络 HTTP、实际前端自动保存定时/导航、生产分布式数据库/物理断电与介质损坏、负载/SLA、像素级界面恢复。SQLite 文件不应通过 iCloud/网盘多设备同步充当分布式锁；生产客户端应调用中心化服务。测试方法计数，不将子断言膨胀成测试数。\n")
    print(json.dumps({k: v for k, v in report.items() if k != "tests"}, ensure_ascii=False, indent=2))
    if not result.wasSuccessful():
        print(stream.getvalue()[-12000:])
    return result.wasSuccessful()


if __name__ == "__main__":
    raise SystemExit(not run())
