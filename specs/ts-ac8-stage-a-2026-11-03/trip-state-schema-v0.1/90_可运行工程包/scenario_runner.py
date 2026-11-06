"""Seven deterministic, synthetic end-to-end state-maintenance walkthroughs."""
import json
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from uuid import UUID
from tripstate.engine import Actor, Store
from tripstate.fixtures import (NOW, AT, initial_state, minimal_state, base, entity, preference,
                                fact, skeleton, candidate, request, adopt, create_command, ingest_command)
from tripstate.rules import index, validate_state

ROOT = Path(__file__).resolve().parent
USER = Actor("user", "scenario-user")
AI = Actor("model", "scenario-ai")
SYSTEM = Actor("system", "scenario-system")
TOOL = Actor("tool", "scenario-provider")


class Story:
    def __init__(self, label, state):
        self.label = label
        self.initial = deepcopy(state)
        self.store = Store(state, clock=lambda: NOW)
        self.steps = []

    def send(self, label, actor, *commands, expected="applied"):
        body = request(self.store, *commands, key=f"{self.label}-{len(self.steps)}", reason=label)
        body["input"]["kind"] = "tool" if actor.role == "tool" else "system" if actor.role == "system" else "dialogue"
        body["input"]["target_ids"] = sorted({c["id"] for c in commands if "id" in c and c["id"] in index(self.store.get_state())})
        response = self.store.submit(body, actor)
        assert response["outcome"] == expected, (self.label, label, response)
        after = self.store.get_state()
        validate_state(after)
        self.steps.append(dict(label=label, actor=dict(role=actor.role, id=actor.id), request=body,
                               response=response, state_after=after))
        return response

    def snapshot(self):
        return dict(scenario=self.label, initial_state=self.initial, steps=self.steps,
                    final_state=self.store.get_state(), audit=self.store.get_history())


def receipt(oid="receipt-luxor", state="confirmed"):
    parameters = [dict(name=k, value=v) for k, v in dict(
        profile="reservation-v0.1", commitment_kind="lodging", confirmation_ref="TEST-HOTEL-1",
        city_id="luxor", check_in="2030-01-12", check_out="2030-01-14",
        commitment_state=state).items()]
    return fact(oid, subject_ids=["luxor"], query=dict(date="2030-01-12", parameters=parameters),
                valid_for=dict(start="2030-01-12", end="2030-01-14"),
                value=dict(kind="condition", value=state == "confirmed", description="合成住宿确认或取消回执"))


def cairo_only(oid, parent=None):
    plan = skeleton(oid)
    plan["stops"] = [dict(entity_id="cairo", nights=4)]
    plan["connections"] = []
    plan["cost_fact_ids"] = []
    plan["parent_id"] = parent
    return plan


def scenario_a():
    s = Story("A-new-destination", minimal_state())
    s.send("系统加入合成国家与陌生城市知识", SYSTEM,
           create_command(entity("new-country", "测试国", "country")),
           create_command(entity("new-city", "陌生城", parent="new-country")))
    goal = base("goal-new", "TripGoal", "draft", destination_ids=["new-country"],
                purpose="探索陌生城市", success_definition="理解候选并作选择", traveler_ids=["traveler-demo"], current_task="explore")
    s.send("用户说明旅行目标", USER, create_command(goal))
    s.send("目标激活", USER, dict(op="transition", id="goal-new", event="activate"))
    pref = preference("pref-new", "inferred")
    pref["subject_ids"] = ["new-city"]
    pref["support"] = "weak"
    pref["scope"] = dict(kind="entity", ids=["new-city"])
    s.send("AI 根据探索行为提出弱推断兴趣", AI, create_command(pref))
    s.send("用户明确表达并纠正兴趣", USER, dict(op="revise", object_type="Preference", id="pref-new",
                                              changes=dict(certainty="explicit", support="supported", expression="我喜欢这座城市的文化体验",
                                                           evidence_refs=["synthetic-dialogue-confirmation"])))
    c = candidate("candidate-new", "new-city")
    c["preference_ids"] = ["pref-new"]
    c["reconsider_when"] = dict(op="always")
    s.send("AI 建立探索候选", AI, create_command(c))
    s.send("用户选择该城市候选", USER, dict(op="decide_candidate", id="candidate-new", value="accept"))
    assert s.store.get_state()["effective_skeleton_id"] is None
    return s.snapshot()


def scenario_b():
    s = Story("B-cross-candidate-preference", initial_state())
    pref_before = deepcopy(index(s.initial)["pref-culture"])
    s.send("用户排除启发偏好的城市", USER, dict(op="transition", id="candidate-luxor", event="exclude"))
    assert index(s.store.get_state())["pref-culture"] == pref_before
    assert "pref-culture" in index(s.store.get_state())["candidate-aswan"]["preference_ids"]
    local = preference("pref-luxor-local")
    local["scope"] = dict(kind="entity", ids=["luxor"])
    local["expression"] = "只喜欢卢克索本身"
    s.send("保留局部偏好，不能扩大到阿斯旺", USER, create_command(local))
    assert "aswan" not in index(s.store.get_state())["pref-luxor-local"]["scope"]["ids"]
    s.send("条件成立后系统重新考虑卢克索", SYSTEM,
           dict(op="reconsider", id="candidate-luxor", trigger_id="constraint-nights"))
    assert index(s.store.get_state())["candidate-luxor"]["status"] == "reintroduced"
    return s.snapshot()


def scenario_c():
    s = Story("C-user-corrects-inference", initial_state())
    inferred = preference("pref-walk", "inferred")
    inferred.update(subject_ids=["cairo"], aspect="步行便利", priority="important", support="weak",
                    expression="AI 根据浏览推测重视步行便利", evidence_refs=["synthetic-behavior-1"])
    s.send("AI 根据行为形成弱推断", AI, create_command(inferred))
    c = candidate("candidate-cairo", "cairo")
    c["preference_ids"] = ["pref-walk"]
    s.send("AI 关联城市候选", AI, create_command(c))
    s.send("用户明确说其实没那么在意", USER, dict(op="revise", object_type="Preference", id="pref-walk",
                                           changes=dict(certainty="explicit", priority="ordinary", support="supported",
                                                        expression="步行便利不是这次旅行的重要条件", evidence_refs=["synthetic-behavior-1", "synthetic-correction-1"])))
    assert index(s.store.get_state())["candidate-cairo"]["review_state"] == "stale"
    assert any(d["before"] and d["id"] == "pref-walk" for r in s.store.get_history()["changes"] for d in r["diff"])
    return s.snapshot()


def scenario_d():
    s = Story("D-new-hard-constraint", initial_state())
    s.send("用户采用首版骨架并承认已有未知", USER, adopt())
    limit = base("constraint-new-ceiling", "Constraint", "proposed", hardness="hard", override_policy="user",
                 value=dict(kind="budget", mode="ceiling", minimum_minor=None, maximum_minor=100000,
                            currency="CNY", people=2, categories=["transport"]))
    s.send("用户新增明确交通预算硬上限", USER, create_command(limit))
    s.send("激活硬上限", USER, dict(op="transition", id="constraint-new-ceiling", event="activate"))
    assert index(s.store.get_state())["skeleton-a"]["assessment"]["status"] == "stale"
    s.send("系统按新预算局部重算", SYSTEM, dict(op="recalculate", id="skeleton-a"))
    assert index(s.store.get_state())["skeleton-a"]["assessment"]["status"] == "blocked"
    assert s.store.get_state()["effective_skeleton_id"] == "skeleton-a"
    assert index(s.store.get_state())["pref-culture"]["status"] == "active"
    return s.snapshot()


def scenario_e():
    s = Story("E-external-booking-fact", initial_state())
    s.send("可信提供方导入合成住宿确认", TOOL, ingest_command(receipt()))
    s.send("用户欲排除已订住宿城市，整笔拒绝", USER,
           dict(op="decide_candidate", id="candidate-luxor", value="reject"), expected="rejected")
    s.send("建立不含预订城市的暂定骨架", AI, create_command(cairo_only("skeleton-booking-conflict")))
    s.send("尝试采用冲突骨架，已知冲突阻止", USER, adopt("skeleton-booking-conflict"), expected="rejected")
    s.send("可信提供方证实取消并替代旧回执", TOOL,
           dict(op="transition", id="receipt-luxor", event="supersede"),
           ingest_command(receipt("receipt-luxor-cancelled", "cancelled")))
    s.send("用户在当前事实下采用新骨架", USER, adopt("skeleton-booking-conflict"))
    assert index(s.store.get_state())["receipt-luxor"]["status"] == "superseded"
    return s.snapshot()


def scenario_f():
    s = Story("F-external-change-replan", initial_state())
    s.send("用户采用初始骨架", USER, adopt())
    no_service = fact("fact-no-service", query_status="no_service",
                      value=dict(kind="transport", from_id="cairo", to_id="luxor", departure=None,
                                 arrival=None, duration_minutes=None, service_exists=False))
    s.send("提供方明确证实原连接无服务并替换旧证据", TOOL,
           dict(op="transition", id="fact-cairo-luxor", event="supersede"), ingest_command(no_service))
    assert index(s.store.get_state())["skeleton-a"]["assessment"]["status"] == "stale"
    blocked = skeleton("skeleton-no-service")
    blocked["parent_id"] = "skeleton-a"
    blocked["connections"][0]["fact_ids"] = ["fact-no-service"]
    blocked["cost_fact_ids"] = []
    s.send("AI 建立保留原路线的比较版本", AI, create_command(blocked))
    s.send("系统算出该路线已知硬冲突", SYSTEM, dict(op="recalculate", id="skeleton-no-service"))
    assert index(s.store.get_state())["skeleton-no-service"]["assessment"]["status"] == "blocked"
    s.send("AI 建立可讨论的替代城市骨架", AI, create_command(cairo_only("skeleton-alternative", "skeleton-a")))
    s.send("用户确认替代方案和仍存未知", USER, adopt("skeleton-alternative"))
    assert s.store.get_state()["effective_skeleton_id"] == "skeleton-alternative"
    assert index(s.store.get_state())["pref-culture"]["status"] == "active"
    return s.snapshot()


def scenario_g():
    s = Story("G-user-reverses-decision", initial_state())
    s.send("用户接受卢克索候选", USER, dict(op="decide_candidate", id="candidate-luxor", value="accept"))
    first = next(o["id"] for o in s.store.get_state()["objects"] if o["type"] == "Decision")
    s.send("用户改变主意并明确拒绝", USER, dict(op="decide_candidate", id="candidate-luxor", value="reject"))
    objects = index(s.store.get_state())
    assert objects[first]["status"] == "revised"
    assert any(o["type"] == "Decision" and o["status"] == "confirmed" and o["supersedes"] == first for o in objects.values())
    assert objects["skeleton-a"]["assessment"]["status"] == "stale"
    assert objects["pref-culture"]["status"] == "active"
    return s.snapshot()


def run_scenarios():
    counter = iter(range(1000, 100000))
    with patch("tripstate.engine.uuid4", side_effect=lambda: UUID(int=next(counter))):
        return [fn() for fn in (scenario_a, scenario_b, scenario_c, scenario_d, scenario_e, scenario_f, scenario_g)]


if __name__ == "__main__":
    result = run_scenarios()
    path = ROOT / "examples" / "scenario-traces.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Scenarios:", len(result), "steps:", sum(len(item["steps"]) for item in result))
