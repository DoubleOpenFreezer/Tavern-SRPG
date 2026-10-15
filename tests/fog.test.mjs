import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent, composeMessage } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';
import { defaultSettings } from '../src/defaults.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false };
const fixed = () => 0.5;
function battle(defs, positions, { w = 12, h = 5, tiles, fog = { enabled: true, ai: true } } = {}) {
    const map = makeMap({ w, h, fog, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) });
    if (tiles) tiles(map);
    return E.createBattle(map, defs, DEFAULT_TERRAINS);
}
const hero = (over = {}) => makeUnit({ id: 'hero', name: '勇者', hp: 40, atk: 12, def: 4, mov: 5, vision: 3, ...over });
const goblin = (over = {}) => makeUnit({ id: 'gob', name: '哥布林', side: 'enemy', hp: 30, atk: 8, def: 2, mov: 4, vision: 3, ...over });
const set = (m, x, y, t) => { m.tiles[y * m.w + x] = t; };

test('视野：超出视野的敌人看不见，不能攻击；关闭迷雾时一切可见', () => {
    const b = battle([hero({ rangeMax: 6 }), goblin()], [[0, 2], [5, 2]]);
    const [p, g] = b.units;
    assert.ok(!E.visibleTo(b, 'P', g));
    assert.ok(E.hiddenFromPlayer(b, g));
    assert.deepEqual(E.attackTargets(b, p), [], '射程够但看不见');
    p.vision = 5;
    assert.ok(E.visibleTo(b, 'P', g));
    assert.deepEqual(E.attackTargets(b, p), [g]);
    b.fog.enabled = false;
    p.vision = 1;
    assert.ok(E.visibleTo(b, 'P', g));
});

test('视野：城墙挡住视线，隐蔽地形只能在近处发现，高地增加视野', () => {
    const b = battle([hero(), goblin(), goblin({ id: 'g2' })], [[0, 2], [2, 2], [0, 0]], { tiles: m => { set(m, 1, 2, 'wall'); set(m, 0, 0, 'forest'); } });
    const [p, g, hidden] = b.units;
    assert.ok(!E.visibleTo(b, 'P', g), '城墙后面看不到');
    assert.ok(!E.visibleTo(b, 'P', hidden), '森林里 2 格外看不到');
    p.y = 1;
    assert.ok(E.visibleTo(b, 'P', hidden), '靠近到森林隐蔽距离内可以发现');
    assert.ok(E.visibleTo(b, 'P', g), '斜着可以绕过墙角看到');
    const before = E.visionRange(b, p);
    b.tiles[p.y * b.w + p.x] = 'mountain';
    assert.equal(E.visionRange(b, p), before + 2);
});

test('迷雾中的移动：路线穿过看不见的敌人时遭遇伏击，停在前一格，伏击者暴露', () => {
    const b = battle([hero({ vision: 1 }), goblin()], [[0, 2], [3, 2]]);
    const [p, g] = b.units;
    const reach = E.reachable(b, p, undefined, false, true);
    assert.ok(reach.has('3,2'), '玩家眼中敌人所在格是空的');
    assert.ok(!E.reachable(b, p).has('3,2'));
    const ev = E.doMove(b, p, 4, 2, { fogView: true });
    assert.deepEqual([p.x, p.y], [2, 2]);
    assert.equal(ev.ambush.uid, g.uid);
    assert.ok(E.visibleTo(b, 'P', g), '伏击者暴露');
    assert.match(formatEvent(ev), /撞上埋伏的 哥布林/);
});

test('攻击会暴露位置，直到攻击方阵营的下一阶段开始；迷雾中的敌方行动不发给 LLM', () => {
    const bow = goblin({ id: 'bow', name: '弓手', rangeMin: 2, rangeMax: 4, vision: 4, ai: 'stationary' });
    const b = battle([hero({ vision: 2 }), bow], [[0, 2], [4, 2]]);
    const [p, a] = b.units;
    assert.ok(!E.visibleTo(b, 'P', a));
    assert.ok(E.visibleTo(b, 'E', p), '敌方也有视野（4 格内）');
    E.beginSidePhase(b, 'enemy');
    const events = E.aiAct(b, a, rules, fixed);
    const atk = events.find(e => e.type === 'attack');
    assert.ok(atk && !atk.fog, '攻击我方的行动可见');
    assert.ok(E.visibleTo(b, 'P', a), '开火后暴露');
    E.finishRound(b);
    assert.ok(E.visibleTo(b, 'P', a), '我方阶段仍能看到并反击');
    E.beginSidePhase(b, 'enemy');
    assert.ok(!E.visibleTo(b, 'P', a), '敌方阶段开始时重新隐入迷雾');

    const msg = composeMessage(b, [{ type: 'move', turn: 1, actor: { name: '弓手', side: 'enemy' }, from: { x: 4, y: 2 }, to: { x: 5, y: 2 }, fog: true, fromTerrain: '平原', terrain: '平原' }], defaultSettings());
    assert.doesNotMatch(msg, /弓手/);
});

test('AI 受迷雾限制：看不到敌人时前往最后发现位置搜索，到达后忘掉；不受限制时直接追踪', () => {
    const b = battle([hero({ vision: 1 }), goblin({ vision: 2, mov: 3 })], [[0, 2], [9, 2]]);
    const [p, g] = b.units;
    assert.deepEqual(b.intel.E[p.uid], { x: 0, y: 2, turn: 1 }, '敌方知道我方布阵位置');
    p.x = 0; p.y = 4; // 我方悄悄转移
    E.beginSidePhase(b, 'enemy');
    const goals = E.goalTargets(b, g);
    assert.equal(goals.length, 1);
    assert.ok(goals[0].ghost);
    assert.deepEqual([goals[0].x, goals[0].y], [0, 2]);
    E.aiAct(b, g, rules, fixed);
    assert.ok(g.x < 9, '朝最后发现位置前进');
    g.x = 1; g.y = 2;
    E.updateIntel(b);
    assert.ok(!b.intel.E[p.uid], '到达后发现人已经不在');
    assert.deepEqual(E.goalTargets(b, g), [], '没有情报时原地警戒');
    b.fog.ai = false;
    assert.deepEqual(E.goalTargets(b, g), [p]);
});

test('战场信息只列出我方看得到的敌人，附最后发现位置', () => {
    const b = battle([hero({ vision: 2 }), goblin(), goblin({ id: 'near', name: '近处哥布林' })], [[0, 2], [8, 2], [2, 2]]);
    const near = b.units[2];
    b.intel.P[b.units[1].uid] = { x: 7, y: 2, turn: 1 };
    const text = buildBattleContext(b);
    assert.match(text, /战争迷雾/);
    assert.match(text, /近处哥布林/);
    assert.match(text, /最后发现位置（现在看不到）：哥布林\[E1\] \(8,3\)/);
    assert.doesNotMatch(text, /\[E1\] 哥布林｜/);
    near.hp = 0;
    E.updateIntel(b);
    assert.ok(!b.intel.P[near.uid]);
});

test('范围技能可以打进迷雾，单体技能只能指定看得见的目标', () => {
    const bolt = makeSkill({ id: 'bolt', name: '飞镖', power: 100, rangeMin: 1, rangeMax: 6 });
    const blast = makeSkill({ id: 'blast', name: '炮击', power: 100, rangeMin: 1, rangeMax: 6, attackMode: 'mapArea', radius: 1, mapTargets: 'enemy' });
    const b = battle([hero({ vision: 1, skills: [bolt, blast] }), goblin()], [[0, 2], [4, 2]]);
    const [p, g] = b.units;
    assert.ok(!E.skillTargetTiles(b, p, p.skills[0]).some(([x, y]) => x === 4 && y === 2));
    assert.ok(E.skillTargetTiles(b, p, p.skills[1]).some(([x, y]) => x === 4 && y === 2));
    const ev = E.doSkill(b, p, p.skills[1], 4, 2, rules, fixed);
    assert.equal(ev.results[0].target.uid, g.uid);
    assert.ok(g.hp < 30);
    assert.ok(E.visibleTo(b, 'P', g), '被击中的敌人暴露');
});
