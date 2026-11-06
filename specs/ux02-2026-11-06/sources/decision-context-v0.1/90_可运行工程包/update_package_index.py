"""Refresh package navigation/fingerprints; does not change inherited sources."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT.parent


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def update():
    path = PACKAGE / "package-index.json"
    data = json.loads(path.read_text())
    data["documents"] = [d for d in data["documents"] if (PACKAGE / d["path"]).is_file()]
    data.update(document_revision="R7_ux02_behavior_handoff_gate_candidate", updated_on="2026-11-06", status="ux02_reference_updated_e03_runtime_pending_final_gate",
                runtime_contract_version="0.1.0", validation_report="90_可运行工程包/VALIDATION_REPORT.md")
    data["product_decisions"] = {"O1": dict(status="approved_for_P0", source="U05", date="2026-10-24",
        requirement="精确恢复跨会话暂停现场", engineering_status="reference_implemented_acceptance_passed",
        document_id="DC-RESUME-SCOPE-01"),
        "DC-AC8-PRIVACY-01": dict(status="APPROVED_BY_OWNER", source="Owner 2026-11-05 direct instruction and supplied screenshot", date="2026-11-05",
        requirement="完整原话在活跃规划期间保留；旅行结束30天、相关不活跃180天、单条12个月取最早截止；主动删除立即停读；备份与审计最小化并告知用户",
        engineering_status="host_not_implemented_production_gate_pending", document_id="DC-AC8-PRIVACY-01")}
    data["limits"] = ["Trip State 0.1.0与Decision Context运行合同0.1.0保持原版本标识；20份DC机器Schema未改", "本包包含参考运行实现与可执行验收，不是生产HTTP/鉴权/数据库服务",
                      "任务解释采用合成结构化输入，未验证任意自然语言模型正确性", "O1首版P0已实现本地事务检查点/草稿/语义焦点恢复并通过故障验收；不代表真实前端或生产集成已验收", "P03/P05跨轮未提交解释证据优先由受信宿主记录承载的技术方案已裁决；宿主接口与真实联测待E03，当前不得宣称完整解释证据恢复", "DC-AC8-PRIVACY-01产品策略及期限已获Owner批准；宿主删除/备份/审计工程与安全合规验证未完成，不得据此启用生产原话存储", "不包含完整Policy行动排序；本包供最终Gate审核，不是生产发布证明"]
    additions = [
        ("DC-RUNTIME-SPEC-01", "运行契约与任务定位", "04_工程规格/01_运行契约与任务定位.md", ["任务定位", "双通道", "字段归属", "授权", "生命周期"]),
        ("DC-ASSEMBLY-SPEC-01", "读取组装与有效性规格", "04_工程规格/02_读取组装与有效性规格.md", ["种子", "快照", "Hydration", "分层", "时效", "重建"]),
        ("DC-API-SPEC-01", "接口异常权限与兼容", "04_工程规格/03_接口异常权限与兼容.md", ["接口", "字段拥有权", "错误", "并发", "幂等", "权限", "迁移"]),
        ("DC-ACCEPTANCE-01", "可执行验收与交付评审", "04_工程规格/04_可执行验收与交付评审.md", ["验收映射", "已测", "未测", "开发与发布边界"]),
        ("DC-CLOSURE-01", "工程收口结论与待审核项", "03_评审与工程衔接/09_工程收口结论与待审核项.md", ["四部分收口", "审核", "推荐与代价", "下一步接入"]),
        ("DC-RESUME-SCOPE-01", "首版跨会话恢复范围决策", "03_评审与工程衔接/10_首版跨会话恢复范围决策.md", ["O1已确认", "首版P0", "持久检查点", "草稿与语义焦点", "DC-R01-R07"]),
        ("DC-RECOVERY-SPEC-01", "持久检查点与跨会话恢复规格", "04_工程规格/05_持久检查点与跨会话恢复规格.md", ["持久化", "保存确认", "CAS", "草稿", "恢复重建", "删除", "版本兼容"]),
        ("DC-RECOVERY-CLOSURE-01", "跨会话恢复工程收口报告", "03_评审与工程衔接/11_跨会话恢复工程收口报告.md", ["U06", "O1已实现", "故障验收", "Owner审核", "生产边界"]),
        ("DC-AC8-TRACE-01", "八项机制融合追踪与规格变更", "03_评审与工程衔接/12_DC-AC8机制融合追踪与规格变更.md", ["原机制地图", "八项规则", "真实缺口", "协议裁决", "规格变更"]),
        ("DC-AC8-E03-01", "E03工程能力增量与实施映射", "03_评审与工程衔接/13_DC八项机制融合｜E03工程能力增量与实施映射.md", ["Existing", "Enhancement", "New", "Test Only", "Deferred", "E03阶段"]),
        ("DC-AC8-VALIDATION-01", "AC8验证记录与跨模块交接", "03_评审与工程衔接/14_DC-AC8验证记录与跨模块交接.md", ["测试", "来源摘要", "TS", "NAP", "PR10差异", "技术负责人验收"]),
        ("DC-AC8-PROTOCOL-01", "AC8协议裁决与宿主证据接口交接", "03_评审与工程衔接/15_DC-AC8协议裁决与宿主证据接口交接.md", ["技术方案已裁决", "宿主能力核查", "E03接口", "失败保护", "Gate复核"]),
        ("DC-AC8-E11-CONTRACT-01", "E11宿主交互证据数据契约与验收轨迹", "03_评审与工程衔接/16_E11宿主交互证据数据契约与验收轨迹.md", ["先记录后关联", "受信事件", "任务关联", "有界读取", "R1-R3", "Owner隐私裁决已批准"]),
        ("DC-AC8-PRIVACY-01", "Owner原话保留与删除裁决", "03_评审与工程衔接/17_DC-AC8-PRIVACY-01_Owner裁决与执行边界.md", ["APPROVED_BY_OWNER", "30天", "180天", "12个月", "主动删除", "告知", "工程Gate"]),
    ]
    additions.append(("DC-UX02-E03-01", "UX02行为落实与E03开发验收映射", "03_评审与工程衔接/18_UX02行为落实与E03开发验收映射.md", ["E01-E32", "两种历史恢复", "草稿", "历史焦点", "E03映射", "待技术审核"]))
    known = {d["id"] for d in data["documents"]}
    for ident, title, relative, topics in additions:
        if ident not in known:
            data["documents"].append(dict(id=ident, title=title, path=relative, role="engineering_review_candidate",
                audience=["product_owner", "ai_product_manager", "architect", "developer"], topics=topics))
    for d in data["documents"]:
        d["sha256"] = fingerprint(PACKAGE / d["path"])
        if d["id"] == "DC-AC8-E11-CONTRACT-01":
            d["topics"] = ["先记录后关联", "受信事件", "任务关联", "有界读取", "R1-R3", "Owner隐私裁决已批准"]
        if d["id"] == "DC-SCENARIOS-01":
            d["role"] = "business_scenarios_linked_to_runtime_acceptance"
        if d["id"] == "DC-TRACE-01":
            d["topics"] = ["S01-S15", "U01-U06", "C01-C31", "I01-I22", "来源与执行证据"]
    files = []
    for f in sorted(ROOT.rglob("*")):
        if not f.is_file() or "__pycache__" in f.parts or f.name == "artifact-manifest.json":
            continue
        if f.suffix not in (".py", ".json", ".md", ".txt"):
            continue
        role = ("machine_contract" if f.parent.name == "schemas" else "test" if f.parent.name == "tests" else
                "execution_evidence" if f.name in ("VALIDATION_REPORT.md", "validation-results.json", "validation-output.txt") else
                "synthetic_example" if f.parent.name == "examples" else "source_or_guide")
        files.append(dict(path=str(f.relative_to(PACKAGE)), role=role, sha256=fingerprint(f)))
    data["engineering_files"] = files
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    manifest = {str(f.relative_to(PACKAGE)): fingerprint(f) for f in [*[PACKAGE/d["path"] for d in data["documents"]],
                                                                  *[PACKAGE/d["path"] for d in files], path]}
    (ROOT / "artifact-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    errors = []
    count = 0
    for md in PACKAGE.rglob("*.md"):
        if "旧文件包" in md.relative_to(PACKAGE).parts:
            continue  # Archived redirect copies retain their original relative links.
        for target in re.findall(r"\]\((<[^>]+>|[^)]+)\)", md.read_text()):
            target = target.strip("<>")
            if "://" in target or target.startswith("#") or target.startswith("/"):
                continue
            target = re.sub(r":\d+$", "", target.split("#")[0]); count += 1
            resolved = Path(target) if target.startswith("/") else md.parent / target
            if not resolved.exists():
                errors.append(str(md.relative_to(PACKAGE)) + ": " + target)
    check = dict(canonical_documents=len(data["documents"]), engineering_files=len(files),
                 local_links_checked=count, errors=errors)
    print(json.dumps(check, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    update()
