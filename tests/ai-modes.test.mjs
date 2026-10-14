import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { buildCommanderPrompt } from '../src/commander.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false };
const fixed = () => 0.5;
function battle(defs, positions, w = 12, h = 5) {
    return E.createBattle(makeMap({ w, h, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS);
}
const civilian = (over = {}) => makeUnit({ id: 'civ', name: '村民', side: 'ally', hp: 20, atk: 5, mov: 3, ai: 'flee', ...over });
const raider = (over = {}) => makeUnit({ id: 'r', name: '强盗', side: 'enemy', hp: 30, atk: 10, mov: 3, ...over });

test('逃跑：敌人下回合打不到时原地不动', () => {
    const b = battle([civilian(), raider(), makeUnit({ id: 'hero', name: '勇者', hp: 50 })], [[0, 2], [11, 2], [0, 4]]);
    const civ = b.units[0];
    assert.equal(E.threatMap(b, civ, rules).get('0,2'), undefined);
    const ev = E.aiAct(b, civ, rules, fixed);
    assert.equal(ev.length, 0);
    assert.deepEqual([civ.x, civ.y], [0, 2]);
});

test('逃跑：敌人接近后逃到威胁范围外，不攻击，也不会踩进熔岩', () => {
    const b = battle([civilian(), raider(), makeUnit({ id: 'hero', name: '勇者', hp: 50 })], [[6, 2], [9, 2], [0, 0]]);
    const [civ, r] = b.units;
    assert.ok(E.threatMap(b, civ, rules).get('6,2') > 0, '强盗移动3格+射程1可以打到');
    const lavaTiles = [[3, 2], [4, 1], [4, 3]];
    b.terrains.lava = { id: 'lava', name: '熔岩', moveCost: 1, enterDamage: 99, color: '#f00' };
    for (const [x, y] of lavaTiles) b.tiles[y * b.w + x] = 'lava';
    const ev = E.aiAct(b, civ, rules, fixed);
    assert.ok(ev.some(e => e.type === 'move'));
    assert.ok(!ev.some(e => e.type === 'attack' || e.type === 'skill'));
    assert.equal(E.threatMap(b, civ, rules).get(`${civ.x},${civ.y}`), undefined, '逃到安全位置');
    assert.ok(!lavaTiles.some(([x, y]) => x === civ.x && y === civ.y));
    assert.equal(civ.hp, 20);
    assert.equal(r.hp, 30);
});

test('逃跑：即使相邻也不反手攻击，跑不掉时去危险最小的地方', () => {
    const b = battle([civilian({ mov: 1 }), raider(), raider({ id: 'r2' })], [[5, 2], [6, 2], [2, 2]], 9, 5);
    const civ = b.units[0];
    const before = E.threatMap(b, civ, rules);
    E.aiAct(b, civ, rules, fixed);
    assert.ok(b.units.slice(1).every(r => r.hp === 30));
    assert.ok((before.get(`${civ.x},${civ.y}`) || 0) <= before.get('5,2'));
});

test('远程游击：从敌人打不到的位置射击，而不是贴近', () => {
    const bow = makeUnit({ id: 'bow', name: '弓手', side: 'enemy', hp: 20, atk: 12, mov: 4, rangeMin: 2, rangeMax: 3, ai: 'ranged' });
    const knight = makeUnit({ id: 'k', name: '骑士', hp: 40, atk: 15, mov: 1 });
    const b = battle([bow, knight], [[9, 2], [3, 2]]);
    const [archer, k] = b.units;
    const ev = E.aiAct(b, archer, rules, fixed);
    assert.ok(ev.some(e => e.type === 'attack'), '仍然会攻击');
    assert.ok(k.hp < 40);
    assert.ok(E.dist(archer.x, archer.y, k.x, k.y) === 3, '保持最远射程');
    const threat = E.threatMap(b, archer, rules);
    assert.equal(threat.get(`${archer.x},${archer.y}`) || 0, 0, '骑士移动1+射程1打不到');

    // 已经贴近时：主动出击原地就射，停在骑士的反扑范围里；远程游击先拉开到安全距离再射
    for (const [ai, safe] of [['aggressive', false], ['ranged', true]]) {
        const b0 = battle([{ ...bow, ai }, knight], [[5, 2], [3, 2]]);
        const a0 = b0.units[0];
        assert.ok(E.aiAct(b0, a0, rules, fixed).some(e => e.type === 'attack'));
        assert.equal(!(E.threatMap(b0, a0, rules).get(`${a0.x},${a0.y}`) > 0), safe, ai);
    }
});

test('远程游击：打不到目标时停在敌人威胁范围边缘，身处危险时后撤', () => {
    const mk = (ai, mov = 2) => makeUnit({ id: 'bow', name: '弓手', side: 'enemy', hp: 20, atk: 12, mov, rangeMin: 2, rangeMax: 2, ai });
    const knight = makeUnit({ id: 'k', name: '骑士', hp: 40, atk: 15, mov: 3 });
    const b = battle([mk('ranged'), knight], [[11, 2], [2, 2]]);
    const [archer, k] = b.units;
    const ev = E.aiAct(b, archer, rules, fixed);
    assert.ok(ev.some(e => e.type === 'move'), '会前进');
    assert.ok(archer.x < 11);
    assert.equal(E.threatMap(b, archer, rules).get(`${archer.x},${archer.y}`) || 0, 0, '没有踏入骑士的威胁范围');
    assert.equal(k.hp, 40);

    // 已经身处危险又打不到人时后撤（距离4：骑士移动3+射程1可达，弓手移动1+射程2打不到）
    const b2 = battle([mk('ranged', 1), knight], [[6, 2], [2, 2]]);
    const a2 = b2.units[0];
    assert.ok(E.threatMap(b2, a2, rules).get('6,2') > 0);
    E.aiAct(b2, a2, rules, fixed);
    assert.ok(a2.x > 6, '后撤');
});

test('LLM指挥官：逃跑单位只有逃离 / 待命选项，远程游击有保持距离前进', () => {
    const b = battle([civilian(), raider(), makeUnit({ id: 'bow', name: '弓手', side: 'enemy', mov: 2, rangeMin: 2, rangeMax: 2, ai: 'ranged' }), makeUnit({ id: 'k', name: '骑士', hp: 40, mov: 3 })],
        [[6, 2], [9, 2], [11, 0], [2, 0]]);
    const [civ, , bow] = b.units;
    const civOpts = E.aiOptions(b, civ, rules);
    assert.deepEqual(civOpts.map(o => o.kind), ['move', 'wait']);
    assert.ok(civOpts[0].flee);
    const { prompt } = buildCommanderPrompt(b, 'ally', [civ], rules);
    assert.match(prompt, /逃离敌人，移动到/);
    const bowOpts = E.aiOptions(b, bow, rules);
    assert.ok(bowOpts.some(o => o.cautious));
    assert.match(buildCommanderPrompt(b, 'enemy', [bow], rules).prompt, /保持距离前进/);
    const res = E.actWithPlan(b, civ, civOpts[0], rules, fixed);
    assert.ok(res.usedPlan);
    assert.deepEqual([civ.x, civ.y], [civOpts[0].x, civOpts[0].y]);
});
