import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMap, makeUnit, defaultRules, DEFAULT_TERRAINS, makeProfile } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { applyManualChange } from '../src/manual.js';
import { formatEvent } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';
import { upgradeCombatRules } from '../src/st.js';

function fixture() {
    const data = makeProfile({ units: [makeUnit({ id: 'hero', name: '勇者', hp: 20, mov: 4 }), makeUnit({ id: 'foe', name: '兽人', side: 'enemy', hp: 20, ai: 'stationary' })] });
    const map = makeMap({ w: 5, h: 1, tiles: ['plain', 'lava', 'plain', 'plain', 'plain'], placements: [{ unitId: 'hero', x: 0, y: 0 }, { unitId: 'foe', x: 4, y: 0 }] });
    return { data, b: E.createBattle(map, data.units, DEFAULT_TERRAINS), rules: { ...defaultRules(), variance: 0, hitEnabled: false, counter: false } };
}

test('落脚伤害固定值与百分比相加，原地和飞行免疫，报告与图例说明伤害', () => {
    const { b } = fixture();
    const hero = b.units[0];
    b.terrains.lava.enterDamagePct = 10;
    const ev = E.doMove(b, hero, 1, 0);
    assert.equal(hero.hp, 13);
    assert.equal(ev.terrainDamage.damage, 7);
    assert.match(formatEvent(ev), /熔岩伤害.*HP 20→13/);
    assert.match(buildBattleContext(b), /落脚伤害5.*最大HP的10%/);
    E.doMove(b, hero, 1, 0);
    assert.equal(hero.hp, 13, '原地不再次触发');
    E.doMove(b, hero, 0, 0);
    hero.flying = true;
    E.doMove(b, hero, 1, 0);
    assert.equal(hero.hp, 13);
    E.doMove(b, hero, 0, 0);
    b.terrains.lava.damageFlying = true;
    E.doMove(b, hero, 1, 0);
    assert.equal(hero.hp, 6);
});

test('地形可致死，玩家落脚后判负，敌方回合伤害致死后不继续攻击', () => {
    const { b, rules } = fixture();
    b.units[0].hp = 3;
    E.doMove(b, b.units[0], 1, 0);
    assert.equal(b.units[0].hp, 0);
    assert.equal(E.commit(b, null)[0].result, 'defeat');
    const other = fixture().b;
    other.units[1].x = 1;
    other.units[1].hp = 1;
    const events = E.endPlayerPhase(other, rules);
    assert.equal(other.result, 'victory');
    assert.ok(events.some(e => e.type === 'terrainDamage' && e.killed));
    assert.ok(!events.some(e => e.type === 'attack'));
});

test('内置AI和指定行动在移动地形致死后不再攻击', () => {
    for (const planned of [false, true]) {
        const { b, rules } = fixture();
        const [hero, foe] = b.units;
        hero.x = 2;
        foe.x = 0; foe.hp = 2; foe.ai = 'aggressive';
        const events = planned ? E.actWithPlan(b, foe, { kind: 'attack', x: 1, y: 0, target: { uid: hero.uid } }, rules).events : E.aiAct(b, foe, rules);
        assert.equal(foe.hp, 0);
        assert.equal(b.result, 'victory');
        assert.ok(!events.some(e => e.type === 'attack'));
        assert.equal(hero.hp, hero.maxHp);
    }
});

test('手动放置、撤除、复活、修改HP和数值只影响战场，并重算胜负', () => {
    const { b, data } = fixture();
    const before = structuredClone(data);
    const hero = b.units[0];
    applyManualChange(b, { type: 'stat', uid: hero.uid, key: 'maxHp', value: 50 }, data);
    applyManualChange(b, { type: 'stat', uid: hero.uid, key: 'hp', value: 40 }, data);
    applyManualChange(b, { type: 'stat', uid: hero.uid, key: 'atk', value: 99 }, data);
    assert.equal(hero.hp, 40);
    assert.equal(hero.atk, 99);
    applyManualChange(b, { type: 'move', uid: hero.uid, x: 1, y: 0 }, data);
    assert.equal(hero.hp, 40, '手动移动不触发伤害');
    applyManualChange(b, { type: 'spawn', defId: 'hero', x: 2, y: 0 }, data);
    assert.equal(b.units.length, 3);
    applyManualChange(b, { type: 'defeatEnemies' }, data);
    assert.equal(b.result, 'victory');
    const enemy = b.units[1];
    applyManualChange(b, { type: 'restore', uid: enemy.uid }, data);
    assert.equal(b.result, null);
    assert.equal(enemy.hp, enemy.maxHp);
    applyManualChange(b, { type: 'remove', uid: enemy.uid }, data);
    assert.equal(enemy.retreated, true);
    assert.equal(b.result, 'victory');
    assert.deepEqual(data, before);
});

test('无效手动修改不能部分写入，坐标冲突不能复活或放置', () => {
    const { b, data } = fixture();
    for (const change of [
        { type: 'spawn', defId: 'foe', x: 0, y: 0 },
        { type: 'move', uid: b.units[0].uid, x: 5, y: 0 },
        { type: 'stat', uid: b.units[0].uid, key: 'hp', value: 999 },
        { type: 'stat', uid: b.units[0].uid, key: 'maxHp', value: 0 },
        { type: 'stat', uid: b.units[0].uid, key: 'side', value: 'invalid' },
    ]) {
        const before = structuredClone(b);
        assert.throws(() => applyManualChange(b, change, data));
        assert.deepEqual(b, before);
    }
    const dead = b.units[1];
    dead.hp = 0; dead.x = 0;
    assert.throws(() => applyManualChange(b, { type: 'restore', uid: dead.uid }, data), /已有单位/);
});

test('递减公式防御平滑减伤，倍率与地形独立乘算，魔法使用魔防', () => {
    const { b, rules } = fixture();
    const [a, d] = b.units;
    a.atk = 40; a.matk = 60;
    for (const [def, expected] of [[0, 40], [12, 20], [24, 13], [48, 8]]) {
        d.def = def;
        assert.equal(E.calcDamage(b, a, d, 'physical', 100, rules, () => 0.5), expected);
    }
    d.def = 12; d.mdef = 24;
    assert.equal(E.calcDamage(b, a, d, 'physical', 200, rules, () => 0.5), 40);
    assert.equal(E.calcDamage(b, a, d, 'magical', 100, rules, () => 0.5), 20);
    b.terrains.plain.defBonus = 50;
    assert.equal(E.calcDamage(b, a, d, 'physical', 200, rules, () => 0.5), 20);
    assert.equal(E.calcDamage(b, a, d, 'physical', 200, rules, () => 0.5, true), 20);
    assert.equal(E.calcDamage(b, a, d, 'physical', 100, { ...rules, defenseScale: 24 }, () => 0.5), 13);
});

test('旧默认公式升级，比例公式与已有防御基准保留', () => {
    const st = { profiles: [{ rules: { formula: 'subtract' } }, { rules: { formula: 'ratio', defenseScale: 20 } }] };
    upgradeCombatRules(st);
    assert.equal(st.profiles[0].rules.formula, 'diminishing');
    assert.equal(st.profiles[0].rules.defenseScale, 12);
    assert.equal(st.profiles[1].rules.formula, 'ratio');
    assert.equal(st.profiles[1].rules.defenseScale, 20);
});
