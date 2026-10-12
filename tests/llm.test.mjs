import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, makeMap, makeUnit } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent } from '../src/narrator.js';
import { extractBlocks, parseCommands, applyCommand, previewCommands, commandGuide, findUnit } from '../src/commands.js';
import { buildCommanderPrompt, parseCommanderReply, describePlan } from '../src/commander.js';

const S = defaultSettings();
const rules = { ...S.rules, variance: 0 };
const opt = { ...S.llm, unitDefs: S.units, terrainDefs: S.terrains, subst: x => x.replace('{{user}}', '小明') };
const sample = () => {
    const units = structuredClone(S.units);
    units[0].aliases = '{{user}}';
    return E.createBattle(S.maps[0], units, S.terrains);
};
const run = (b, text, o = opt) => parseCommands(text).map(c => applyCommand(b, c, o));

test('从回复中取出指令块并清理正文', () => {
    const { clean, blocks } = extractBlocks('落石轰然砸下！\n\n<srpg>\ndamage E1 5 落石\n</srpg>\n');
    assert.equal(clean, '落石轰然砸下！');
    assert.equal(blocks.length, 1);
    const cmds = parseCommands('- damage E1 5 被落石砸中\n移动 小明 (3,4) 被击退\n喵喵 1');
    assert.deepEqual(cmds.map(c => c.cmd), ['damage', 'move', null]);
    assert.deepEqual(cmds[1].args, ['小明', '3', '4', '被击退']);
});

test('按编号、名字、别名找单位', () => {
    const b = sample();
    assert.equal(findUnit(b, 'E2').name, '哥布林B');
    assert.equal(findUnit(b, '法师').name, '法师');
    assert.equal(findUnit(b, '小明', opt.subst).name, '骑士');
    assert.equal(findUnit(b, '龙'), null);
});

test('伤害有上限且默认不能致死；治疗不超过最大 HP', () => {
    const b = sample();
    const g = b.units[2]; // 哥布林A HP 18，上限 9
    const [ev] = run(b, 'damage E1 99 天降陨石');
    assert.equal(ev.amount, 9);
    assert.match(formatEvent(ev), /【剧情】哥布林A 受到 9 点伤害（HP 18→9）（超过上限，按 9 计算）——天降陨石/);
    run(b, 'damage E1 9'); run(b, 'damage E1 9');
    assert.equal(g.hp, 1, '不能直接击败');
    const b2 = sample();
    run(b2, 'damage E1 9', { ...opt, allowKill: true, maxChangePct: 100 });
    run(b2, 'damage E1 9', { ...opt, allowKill: true, maxChangePct: 100 });
    assert.equal(b2.units[2].hp, 0);
    b.units[0].hp = 30;
    const [h] = run(b, 'heal P1 10 喝药');
    assert.equal(h.amount, 2);
});

test('状态、解除、移动、撤退、增援、地形', () => {
    const b = sample();
    const [knight, , g1, g2] = b.units;
    run(b, 'status P1 攻击力上升 50 1 受到鼓舞');
    assert.equal(E.stat(knight, 'atk'), 18);
    run(b, 'status E1 poison 10 2\nunstatus E1 中毒');
    assert.equal(g1.statuses.length, 0);
    run(b, 'move E2 (6,2) 被击退');
    assert.deepEqual([g2.x, g2.y], [5, 1]);
    assert.throws(() => run(b, 'move E2 7 1'), /无法站在 河流/);
    run(b, 'retreat 哥布林弓手 逃跑');
    assert.equal(E.alive(b).some(u => u.name === '哥布林弓手'), false);
    const [sp] = run(b, 'spawn 哥布林 12 1 援军');
    assert.equal(sp.actor.name, '哥布林·1');
    assert.equal(E.unitAt(b, 11, 0).side, 'enemy');
    run(b, 'terrain 7 4 河流 桥被砍断');
    assert.equal(E.terrainAt(b, 6, 3).name, '河流');
    assert.throws(() => run(b, 'end victory'), /不允许/);
    assert.throws(() => run(b, 'status P1 恢复HP'), /立即效果/);
});

test('预演不修改战场，并逐条报告错误', () => {
    const b = sample();
    const res = previewCommands(b, parseCommands('damage E1 3\nmove 龙 1 1\nheal P2 5'), opt);
    assert.deepEqual(res.map(r => r.ok), [true, false, true]);
    assert.match(res[1].error, /找不到单位「龙」/);
    assert.equal(b.units[2].hp, 18);
});

test('指令说明只列出允许的指令', () => {
    const g = commandGuide({ ...opt, allow: { ...opt.allow, spawn: false } });
    assert.match(g, /<srpg>/);
    assert.ok(!g.includes('spawn '));
    assert.match(g, /不能直接击败单位/);
});

test('LLM 指挥官：生成选项、解析回复、按选择行动', () => {
    const b = sample();
    E.beginSidePhase(b, 'enemy');
    const group = E.alive(b).filter(u => u.side === 'enemy');
    const { prompt, options } = buildCommanderPrompt(b, 'enemy', group, rules);
    assert.match(prompt, /E1 哥布林A（HP 18\/18，位于 \(10,4\)）：/);
    assert.match(prompt, /向 骑士\[P1\] 前进/);
    assert.match(prompt, /原地待命/);
    const g1 = group[0];
    const opts = options.get(g1.uid);
    const waitIdx = opts.findIndex(o => o.kind === 'wait') + 1;
    const reply = `E1: ${waitIdx} | 等待援军\nE2：0\n这是多余的话`;
    const picks = parseCommanderReply(b, reply);
    assert.deepEqual(picks.get(g1.uid), { index: waitIdx, intent: '等待援军' });
    assert.equal(picks.get(group[1].uid).index, 0);
    const { events, usedPlan } = E.actWithPlan(b, g1, opts[waitIdx - 1], rules);
    assert.ok(usedPlan);
    assert.equal(events[0].type, 'wait');
    events[0].intent = '等待援军';
    assert.match(formatEvent(events[0]), /哥布林A 在平原原地待命（意图：等待援军）。/);
});

test('LLM 选择的行动失效时交给内置 AI', () => {
    const b = sample();
    const g1 = b.units[2];
    const plan = { kind: 'attack', x: 9, y: 3, target: { uid: b.units[0].uid } }; // 骑士不在射程内
    assert.equal(E.planValid(b, g1, plan), false);
    const { usedPlan } = E.actWithPlan(b, g1, plan, rules);
    assert.equal(usedPlan, false);
    assert.ok(describePlan(b, b.units[3], { kind: 'wait', x: 0, y: 0 }, rules).includes('原地待命'));
});
