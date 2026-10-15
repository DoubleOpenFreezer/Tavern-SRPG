import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { skillSummary } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false };
const fixed = () => 0.5;
function battle(defs, positions, airRule = true) {
    const b = E.createBattle(makeMap({ w: 10, h: 5, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS);
    b.airRule = airRule;
    return b;
}
const wyvern = (over = {}) => makeUnit({ id: 'wyvern', name: '飞龙', side: 'enemy', flying: true, hp: 40, atk: 10, ai: 'stationary', ...over });
const sword = (over = {}) => makeUnit({ id: 'sword', name: '剑士', hp: 40, atk: 10, ...over });
const bow = (over = {}) => makeUnit({ id: 'bow', name: '弓手', hp: 30, atk: 9, rangeMin: 1, rangeMax: 3, antiAir: true, ...over });

test('规则关闭时任何攻击都能打到飞行单位；开启后只有对空的普通攻击或飞行单位可以', () => {
    const off = battle([sword(), wyvern()], [[1, 2], [2, 2]], false);
    assert.deepEqual(E.attackTargets(off, off.units[0]).map(t => t.name), ['飞龙']);

    const b = battle([sword(), bow(), wyvern(), makeUnit({ id: 'peg', name: '天马骑士', flying: true })], [[1, 2], [4, 2], [2, 2], [3, 2]]);
    const [s, a, w, peg] = b.units;
    assert.deepEqual(E.attackTargets(b, s), [], '剑士打不到飞龙');
    assert.throws(() => E.doAttack(b, s, w, rules, fixed), /不能对空/);
    assert.deepEqual(E.attackTargets(b, a).map(t => t.name), ['飞龙'], '弓手可以对空');
    assert.deepEqual(E.attackTargets(b, peg).map(t => t.name), ['飞龙'], '飞行单位之间可以互相攻击');
});

test('反击也受对空限制：飞行单位攻击地面近战不会被反击，攻击对空单位会被反击', () => {
    const b = battle([sword(), bow(), wyvern({ ai: 'aggressive' })], [[1, 2], [5, 2], [2, 2]]);
    const [s, a, w] = b.units;
    assert.ok(!E.canCounter(b, s, w));
    const ev = E.doAttack(b, w, s, rules, fixed, 'counter');
    assert.equal(ev.counter, null);
    assert.notEqual(ev.reaction, 'counter', '不能反击时不消耗韧性去反击');
    w.acted = false; w.x = 4;
    const ev2 = E.doAttack(b, w, a, rules, fixed, 'counter');
    assert.ok(ev2.counter, '弓手对空反击');
});

test('技能：可以对空的技能打得到飞行单位；不能对空的范围技能不波及飞行单位（包括飞行友军），单体技能不能指定它', () => {
    const fire = makeSkill({ id: 'fire', name: '火球术', kind: 'magical', power: 100, rangeMin: 1, rangeMax: 4, radius: 1, antiAir: true });
    const quake = makeSkill({ id: 'quake', name: '地震', power: 100, rangeMin: 1, rangeMax: 4, attackMode: 'mapArea', radius: 1 });
    const stab = makeSkill({ id: 'stab', name: '突刺', power: 100, rangeMin: 1, rangeMax: 2 });
    const mage = makeUnit({ id: 'mage', name: '法师', skills: [fire, quake, stab] });
    const b = battle([mage, wyvern(), makeUnit({ id: 'gob', name: '哥布林', side: 'enemy' }), makeUnit({ id: 'peg', name: '天马', flying: true })], [[0, 2], [3, 2], [3, 1], [4, 2]]);
    const [m, w, g, peg] = b.units;
    assert.deepEqual(E.skillAffected(b, m, m.skills[0], 3, 2).map(t => t.name).sort(), ['哥布林', '飞龙'].sort());
    assert.deepEqual(E.skillAffected(b, m, m.skills[1], 3, 2).map(t => t.name), ['哥布林'], '地震不波及飞龙和天马');
    m.x = 2;
    assert.ok(!E.skillTargetTiles(b, m, m.skills[2]).some(([x, y]) => x === 3 && y === 2), '突刺不能指定飞龙');
    assert.ok(E.skillTargetTiles(b, m, m.skills[2]).some(([x, y]) => x === 3 && y === 1));
    assert.match(skillSummary(fire), /可对空/);
    assert.ok(peg);
});

test('AI：没有对空手段的单位不追击飞行单位；飞行单位逃跑时不把打不到它的敌人算作威胁', () => {
    const b = battle([sword({ side: 'enemy', name: '敌剑士' }), makeUnit({ id: 'p', name: '天马', flying: true, ai: 'flee' }), makeUnit({ id: 'k', name: '骑士' })], [[5, 2], [6, 2], [0, 2]]);
    const [enemy, peg, knight] = b.units;
    assert.deepEqual(E.goalTargets(b, enemy).map(t => t.name), ['骑士']);
    assert.ok(!(E.threatMap(b, peg, rules).get('6,2') > 0), '剑士打不到天马');
    b.airRule = false;
    assert.ok(E.threatMap(b, peg, rules).get('6,2') > 0);
    assert.ok(knight);
});

test('援护：攻击方打不到的飞行单位不能替队友承受攻击', () => {
    const guard = makeSkill({ id: 'g', name: '援护', kind: 'support', target: 'ally', rangeMin: 1, rangeMax: 2, effects: [{ type: 'cover', turns: 1 }] });
    const b = battle([makeUnit({ id: 'peg', name: '天马', flying: true, skills: [guard] }), makeUnit({ id: 'v', name: '村民' }), sword({ side: 'enemy', name: '敌剑士' })], [[1, 2], [2, 2], [3, 2]]);
    const [peg, v, e] = b.units;
    E.doSkill(b, peg, peg.skills[0], 2, 2, rules, fixed);
    assert.equal(E.coverFor(b, e, v), null);
    e.antiAir = true;
    assert.equal(E.coverFor(b, e, v).unit, peg);
});

test('战场信息标出飞行需要对空与对空单位', () => {
    const b = battle([bow(), wyvern()], [[0, 2], [2, 2]]);
    const text = buildBattleContext(b);
    assert.match(text, /飞行（只能被对空攻击打到）/);
    assert.match(text, /普通攻击可对空/);
});
