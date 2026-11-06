"""Generate runtime schemas and complete structural dictionary from one source."""
import sys
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
from dependency import BASE
from context_runtime.contracts import SCHEMAS, VERSION


def export():
    folder = ROOT / "schemas"
    folder.mkdir(exist_ok=True)
    lines = ["# 运行合同结构字段字典", "", "自动从 context_runtime/contracts.py 生成；业务语义及写入拥有权见工程规格，继承对象不在本表重新定义。",
             "", "所有本包封装字段由运行层产生/维护；输入字段来自调用方/解释器，不能充当宿主授权。所有对象禁止额外字段，全部列出的属性必填，可空项以联合类型表示。", ""]
    for name, schema in SCHEMAS.items():
        destination = folder / (name + ".schema.json")
        destination.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n")
        lines.extend(["## " + name, "", "| 路径 | 结构约束 |", "|---|---|"])
        def walk(value, path):
            if not isinstance(value, dict):
                return
            if path:
                info = {k: v for k, v in value.items() if k not in ("properties", "$defs", "items", "required")}
                lines.append("| `" + path + "` | `" + json.dumps(info, ensure_ascii=False, separators=(",", ":")).replace("|", "\\|") + "` |")
            for key, child in value.get("properties", {}).items():
                walk(child, path + "/" + key)
            if isinstance(value.get("items"), dict):
                walk(value["items"], path + "/*")
        walk(schema, "")
        for key, definition in schema["$defs"].items():
            walk(definition, "$defs/" + key)
        lines.append("")
    (ROOT / "FIELD_DICTIONARY.md").write_text("\n".join(lines))
    from tripstate.engine import Store
    from tripstate.fixtures import initial_state, NOW
    from tripstate.rules import stamp
    from context_runtime.runtime import Runtime, Principal
    state = initial_state()
    runtime = Runtime(Store(state, clock=lambda: NOW))
    principal = Principal("user-demo", (state["trip_id"],))
    text = "我还不懂两个城市的差别"
    body = dict(runtime_contract_version=VERSION, trip_id=state["trip_id"], expected_revision=0,
        event=dict(event_id="example-event", entry="dialogue", text=text, reference="SYNTHETIC_ONLY", received_at=stamp(NOW)),
        tasks=[dict(task_key="example-explore", question=text, kind="explore", target_ids=["candidate-luxor", "candidate-aswan"],
                    branch="actual", relation="new", related_task_keys=[], certainty="ambiguous",
                    evidence=[dict(start=0, end=len(text), quote=text)], progress="open", progress_evidence=None)],
        focus_keys=["example-explore"])
    turn = runtime.open_turn(body, principal)
    assembly = dict(runtime_contract_version=VERSION, turn_id=turn["turn_id"], task_key="example-explore", body_budget_bytes=2000)
    packet = runtime.assemble(assembly, principal)
    examples = ROOT / "examples"
    examples.mkdir(exist_ok=True)
    (examples / "exploration.json").write_text(json.dumps(dict(disclaimer="合成解释器输出，不证明自然语言模型能力",
        open_turn=body, turn=turn, assemble=assembly, packet=packet), ensure_ascii=False, indent=2) + "\n")
    from tempfile import TemporaryDirectory
    from context_runtime.checkpoints import CheckpointRepository
    with TemporaryDirectory() as temporary:
        db = Path(temporary) / "checkpoint.sqlite"
        writer = Runtime(Store(state, clock=lambda: NOW), CheckpointRepository(db))
        durable_turn = writer.open_turn(body, principal)
        save = dict(runtime_contract_version=VERSION, workspace_key="workspace", expected_checkpoint_revision=1,
            idempotency_key="example-scene", focus_keys=["example-explore"],
            view=dict(entry="comparison", comparison_refs=[dict(id="skeleton-a", version=1)], selected_id="skeleton-a", expanded_task_keys=["example-explore"]),
            drafts=[dict(draft_id="six-night-draft", draft_kind="hypothetical", base_revision=0,
                         target_ids=["constraint-nights"], text="如果六晚呢", source_reference="SYNTHETIC-DRAFT", proposal=None)])
        ack = writer.save_scene(save, principal)
        reader = Runtime(Store(state, clock=lambda: NOW), CheckpointRepository(db))
        restore = dict(runtime_contract_version=VERSION, workspace_key="workspace", body_budget_bytes=2000)
        restored = reader.restore_scene(restore, principal)
        (examples / "recovery.json").write_text(json.dumps(dict(disclaimer="合成示例；生成过程真实保存/重开 SQLite，测试另覆盖独立进程",
            open_turn=body, turn=durable_turn, scene_save=save, scene_ack=ack, scene_restore=restore,
            scene_restored=restored), ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    export()
