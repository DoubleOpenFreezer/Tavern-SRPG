import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false };
const fixed = () => 0.5;
const types = [
    { id: 'cav', name: '骑兵', desc: '冲锋陷阵', vs: { arc: { dmg: 150, hit: 10, tough: 2 } } },
    { id: 'arc', name: '弓兵', desc: '', vs: { cav: { dmg: 50 } } },
];
function battle(defs, positions, unitTypes = types) {
    return E.createBattle(makeMap({ w: 8, h: 3, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS, unitTypes);
}
const rider = (over = {}) => makeUnit({ id: 'rider', name: '骑士', typeId: 'cav', hp: 40, atk: 12, def: 4, ...over });
const archer = (over = {}) => makeUnit({ id: 'archer', name: '弓手', side: 'enemy', typeId: 'arc', hp: 40, atk: 12, def: 4, ai: 'stationary', ...over });

test('兵种克制：伤害倍率与命中修正按攻防双方兵种计算，反方向使用另一条设置', () => {
    const b = battle([rider(), archer()], [[1, 1], [2, 1]]);
    const [r, a] = b.units;
    const neutral = E.calcDamage({ ...b, unitTypes: {} }, r, a, 'physical', 100, rules, fixed, true);
    assert.equal(E.calcDamage(b, r, a, 'physical', 100, rules, fixed, true), Math.round(neutral * 1.5));
    assert.equal(E.calcDamage(b, a, r, 'physical', 100, rules, fixed, true), Math.round(neutral * 0.5));
    const hitRules = { ...rules, hitEnabled: true };
    assert.equal(E.hitChance(b, r, a, hitRules) - E.hitChance({ ...b, unitTypes: {} }, r, a, hitRules), 10);
    assert.deepEqual(E.matchup(b, a, r), { dmg: 50, hit: 0, tough: 1 });
    assert.equal(E.matchupLabel(E.matchup(b, r, a)), '伤害150%、命中+10%、韧性消耗×2');
    assert.ok(E.isNeutralMatchup(E.matchup(b, r, r)), '没有设置的组合不受影响');
});

test('兵种克制：韧性消耗倍数让一次防御扣除多点韧性，耗尽后只能承受', () => {
    const b = battle([rider(), archer({ tough: 3 })], [[1, 1], [2, 1]]);
    const [r, a] = b.units;
    const ev = E.doAttack(b, r, a, rules, fixed, 'defend');
    assert.deepEqual(ev.tough, [3, 1]);
    assert.equal(ev.matchup.dmg, 150);
    assert.match(formatEvent(ev), /兵种克制：伤害150%/);
    r.acted = false;
    const ev2 = E.doAttack(b, r, a, rules, fixed, 'defend');
    assert.deepEqual(ev2.tough, [1, 0], '剩余韧性不足时扣到 0');
    assert.ok(!E.canBrace(a, rules));
});

test('兵种克制：技能伤害同样受影响；无兵种的旧战斗不变', () => {
    const shot = makeSkill({ id: 'shot', name: '突刺', power: 100, rangeMin: 1, rangeMax: 1 });
    const b = battle([rider({ skills: [shot] }), archer()], [[1, 1], [2, 1]]);
    const [r, a] = b.units;
    const ev = E.doSkill(b, r, r.skills[0], a.x, a.y, rules, fixed, { [a.uid]: 'none' });
    assert.equal(ev.results[0].matchup.dmg, 150);
    assert.match(formatEvent(ev), /兵种克制/);
    const old = battle([rider(), archer()], [[1, 1], [2, 1]], []);
    assert.ok(E.isNeutralMatchup(E.matchup(old, old.units[0], old.units[1])));
});

test('战场信息列出兵种说明和克制关系', () => {
    const b = battle([rider(), archer()], [[1, 1], [2, 1]]);
    const text = buildBattleContext(b);
    assert.match(text, /兵种：骑兵/);
    assert.match(text, /骑兵：冲锋陷阵/);
    assert.match(text, /骑兵 攻击 弓兵：伤害150%、命中\+10%、韧性消耗×2/);
    assert.match(text, /弓兵 攻击 骑兵：伤害50%/);
});

test('旧资料卡升级：补上兵种列表、单位视野、地图迷雾设置和内置地形的视野字段', async () => {
    const { normalizeProfile } = await import('../src/st.js');
    const old = { name: '旧卡', units: [{ id: 'u', name: '兵', skills: [] }, { id: 'g', name: '门', kind: 'object', skills: [] }],
        terrains: [{ id: 'forest', name: '森林' }, { id: 'mountain', name: '山地', visionBonus: 0 }, { id: 'custom', name: '自定义' }], maps: [{ id: 'm', name: '图' }] };
    const p = normalizeProfile(old);
    assert.deepEqual(p.unitTypes, []);
    assert.equal(p.units[0].vision, 4);
    assert.equal(p.units[1].vision, 0);
    assert.equal(p.units[0].typeId, '');
    assert.deepEqual(p.maps[0].fog, { enabled: false, ai: true });
    assert.equal(p.terrains[0].conceal, 1);
    assert.equal(p.terrains[1].visionBonus, 0, '用户改过的值保留');
    assert.equal(p.terrains[2].conceal, undefined);
});
