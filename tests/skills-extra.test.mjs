import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent, skillSummary } from '../src/narrator.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false };
const fixed = () => 0.5;
function battle(defs, positions, w = 10, h = 5) {
    return E.createBattle(makeMap({ w, h, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS);
}
const sup = (effects, over = {}) => makeSkill({ name: '辅助', kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 3, effects, ...over });
const hero = (over = {}) => makeUnit({ id: 'h', name: '勇者', hp: 50, atk: 10, mov: 3, ...over });
const orc = (over = {}) => makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 40, atk: 8, mov: 3, ai: 'stationary', ...over });

test('移动消耗可以是小数：0.5 让移动距离翻倍，1 以上照旧', () => {
    const b = battle([hero({ mov: 3 }), orc()], [[0, 2], [9, 0]]);
    const h = b.units[0];
    const far = () => Math.max(...[...E.reachable(b, h).values()].map(n => E.dist(n.x, n.y, h.x, h.y)));
    assert.equal(far(), 3);
    b.terrains.road = { id: 'road', name: '道路', moveCost: 0.5, passable: true, flyable: true, color: '#ccc' };
    for (let x = 0; x < b.w; x++) b.tiles[2 * b.w + x] = 'road';
    assert.ok(E.reachable(b, h).has('6,2'), '0.5 × 6 = 3');
    assert.ok(!E.reachable(b, h).has('7,2'));
    b.terrains.road.moveCost = 0.1;
    assert.ok(E.reachable(b, h).has('9,2'), '浮点累加不会少算一格');
    b.terrains.road.moveCost = 0;
    assert.equal(far(), 3, '0 按 1 计，避免无限移动');
});

test('速攻辅助技能不消耗行动，每回合一次，下个我方阶段恢复', () => {
    const quick = sup([{ type: 'atk_up', value: 30, turns: 2 }], { id: 'q', name: '鼓舞', quick: true });
    const b = battle([hero({ skills: [quick] }), hero({ id: 'a', name: '骑士' }), orc()], [[0, 2], [1, 2], [9, 0]]);
    const [h, a] = b.units;
    const ev = E.doSkill(b, h, h.skills[0], 1, 2, rules, fixed);
    assert.equal(h.acted, false);
    assert.equal(h.moved, false, '用完还能移动');
    assert.ok(E.hasStatus(a, 'atk_up'));
    assert.match(formatEvent(ev), /速攻，不消耗行动/);
    assert.match(skillSummary(h.skills[0]), /速攻/);
    assert.throws(() => E.doSkill(b, h, h.skills[0], 1, 2, rules, fixed), /冷却/);
    E.endPlayerPhase(b, rules, fixed);
    assert.ok(E.skillUsable(h.skills[0]), '新回合可再次使用');
    const nonSupport = makeSkill({ quick: true });
    assert.equal(E.isQuick(nonSupport), false, '只有辅助技能可以速攻');
});

test('传送：移动到射程内的空地，不能落在单位或不可通行的格子上，落脚地形伤害照常', () => {
    const blink = sup([], { id: 't', name: '闪现', target: 'tile', rangeMin: 1, rangeMax: 4 });
    const b = battle([hero({ skills: [blink] }), orc()], [[0, 2], [3, 2]]);
    const [h] = b.units;
    b.tiles[2 * b.w + 2] = 'wall';
    b.terrains.lava = { id: 'lava', name: '熔岩', moveCost: 2, passable: true, enterDamage: 5, color: '#f00' };
    b.tiles[0 * b.w + 2] = 'lava';
    const tiles = E.skillTargetTiles(b, h, h.skills[0]);
    assert.ok(!tiles.some(([x, y]) => x === 3 && y === 2), '有单位的格子不能传送');
    assert.ok(!tiles.some(([x, y]) => x === 2 && y === 2), '城墙不能传送');
    assert.ok(!tiles.some(([x, y]) => x === 0 && y === 2), '不能传送到原地');
    const ev = E.doSkill(b, h, h.skills[0], 2, 0, rules, fixed);
    assert.deepEqual([h.x, h.y], [2, 0]);
    assert.equal(h.hp, 45);
    assert.equal(h.acted, true);
    assert.match(formatEvent(ev), /从 \(1,3\) 瞬间传送到 \(3,1\)熔岩，.*落脚时受到熔岩伤害/);
    assert.throws(() => E.doSkill(b, h, { ...h.skills[0], cdLeft: 0 }, 3, 2, rules, fixed), /范围/);
});

test('再行动：已行动的同阵营目标可以再行动一次；对自己、未行动、本回合已再行动的目标无效', () => {
    const dance = sup([{ type: 'refresh' }], { id: 'r', name: '舞蹈', rangeMin: 1, rangeMax: 1 });
    const b = battle([hero({ skills: [dance] }), hero({ id: 'a', name: '骑士' }), orc()], [[0, 2], [1, 2], [9, 0]]);
    const [h, a] = b.units;
    let ev = E.doSkill(b, h, h.skills[0], 1, 2, rules, fixed);
    assert.match(formatEvent(ev), /再行动无效（尚未行动）/);
    a.acted = true; a.moved = true; h.acted = false;
    ev = E.doSkill(b, h, h.skills[0], 1, 2, rules, fixed);
    assert.equal(a.acted, false);
    assert.equal(a.moved, false);
    assert.match(formatEvent(ev), /获得再次行动的机会/);
    a.acted = true; h.acted = false;
    ev = E.doSkill(b, h, h.skills[0], 1, 2, rules, fixed);
    assert.equal(a.acted, true);
    assert.match(formatEvent(ev), /本回合已再行动过/);
});

test('敌方 AI：使用再行动让已出手的同伴再攻击一次，被再行动的单位排到队尾', () => {
    const dance = sup([{ type: 'refresh' }], { id: 'r', name: '战鼓', rangeMin: 1, rangeMax: 1 });
    const b = battle([hero({ hp: 100, def: 0 }), orc({ id: 'brute', name: '蛮兵', atk: 20, rangeMin: 1, rangeMax: 1 }), orc({ id: 'drum', name: '鼓手', skills: [dance], atk: 1 })],
        [[4, 2], [5, 2], [6, 2]]);
    const [h] = b.units;
    const ev = E.endPlayerPhase(b, rules, fixed);
    const attacks = ev.filter(e => e.type === 'attack' && e.actor.name === '蛮兵');
    assert.equal(attacks.length, 2, '蛮兵攻击了两次');
    assert.ok(ev.some(e => e.type === 'skill' && e.skill.name === '战鼓'));
    assert.ok(h.hp < 100);
});

test('召回：目标瞬间移动到施法者身边离它最近的空格；建筑不受影响', () => {
    const call = sup([{ type: 'recall' }], { id: 'c', name: '召回', rangeMin: 1, rangeMax: 8 });
    const wall = makeUnit({ id: 'gate', name: '城门', kind: 'object', hp: 30 });
    const b = battle([hero({ skills: [call] }), makeUnit({ id: 'civ', name: '村民', side: 'ally', hp: 10 }), orc(), wall], [[0, 2], [6, 2], [7, 2], [2, 2]]);
    const [h, civ, , gate] = b.units;
    const ev = E.doSkill(b, h, h.skills[0], 6, 2, rules, fixed);
    assert.deepEqual([civ.x, civ.y], [1, 2]);
    assert.match(formatEvent(ev), /被召回到 \(2,3\)/);
    h.acted = false; h.skills[0].cdLeft = 0;
    E.doSkill(b, h, h.skills[0], 2, 2, rules, fixed);
    assert.deepEqual([gate.x, gate.y], [2, 2]);
});

test('敌方 AI 行动前先用速攻增益再攻击；传送技能不会被 AI 乱用', () => {
    const rage = sup([{ type: 'atk_up', value: 50, turns: 2 }], { id: 'q', name: '狂怒', target: 'self', quick: true });
    const blink = sup([], { id: 't', name: '闪现', target: 'tile', rangeMin: 1, rangeMax: 5 });
    const b = battle([hero({ hp: 100 }), orc({ skills: [rage, blink], rangeMin: 1, rangeMax: 1 })], [[4, 2], [5, 2]]);
    const [, o] = b.units;
    const ev = E.aiAct(b, o, rules, fixed);
    assert.deepEqual(ev.filter(e => ['skill', 'attack'].includes(e.type)).map(e => e.type === 'skill' ? e.skill.name : 'attack'), ['狂怒', 'attack']);
    assert.ok(!E.aiOptions(b, o, rules, 30).some(p => p.skill?.id === 't'));
});
