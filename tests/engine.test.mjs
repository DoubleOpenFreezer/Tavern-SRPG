import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings } from '../src/defaults.js';
import * as E from '../src/engine.js';

const S = defaultSettings();
const mk = () => E.createBattle(S.maps[0], S.units, S.terrains);
const fixed = () => 0.5; // 无浮动

test('createBattle 实例化单位并为重名单位加后缀', () => {
    const b = mk();
    assert.equal(b.units.length, 5);
    assert.deepEqual(b.units.filter(u => u.defId === 'unit_sample_goblin').map(u => u.name), ['哥布林A', '哥布林B']);
});

test('步行单位无法渡河，只能走桥', () => {
    const b = mk();
    const knight = b.units[0];
    knight.mov = 99;
    const r = E.reachable(b, knight);
    for (let y = 0; y < b.h; y++) {
        const ok = r.has(`6,${y}`);
        assert.equal(ok, y === 3 || y === 4, `river row ${y}`);
    }
});

test('飞行单位可越过河流', () => {
    const b = mk();
    const k = b.units[0];
    k.flying = true; k.x = 5; k.y = 0; k.mov = 2;
    assert.ok(E.reachable(b, k).has('7,0'));
});

test('森林消耗 2 点移动力', () => {
    const b = mk();
    const k = b.units[0]; k.x = 1; k.y = 1; k.mov = 2;
    const r = E.reachable(b, k);
    assert.equal(r.get('2,1').cost, 2);
    assert.ok(!r.has('3,1'));
});

test('减法公式 + 地形减伤 + 反击', () => {
    const legacyRules = { ...S.rules, formula: 'subtract' };
    const b = mk();
    const [knight, , gob] = b.units;
    knight.x = 8; knight.y = 3; gob.x = 9; gob.y = 3;
    const ev = E.doAttack(b, knight, gob, legacyRules, fixed);
    assert.equal(ev.damage, 12 - 3);
    assert.equal(gob.hp, 18 - 9);
    assert.equal(ev.counter.damage, 1); // 9-9=0，取最低伤害 1
    gob.x = 8; gob.y = 6; knight.x = 7; knight.y = 6; gob.hp = 18; // 哥布林在森林
    const ev2 = E.doAttack(b, knight, gob, legacyRules, fixed);
    assert.equal(ev2.damage, Math.round(9 * 0.8));
});

test('范围技能命中多个敌人并扣除次数', () => {
    const b = mk();
    const mage = b.units[1];
    const [, , g1, g2] = b.units;
    mage.x = 5; mage.y = 4; g1.x = 7; g1.y = 4; g2.x = 7; g2.y = 5;
    const fb = mage.skills[0];
    const ev = E.doSkill(b, mage, fb, 7, 4, S.rules, fixed);
    assert.equal(ev.results.length, 2);
    assert.equal(fb.cdLeft, 2);
    assert.equal(E.skillUsable(fb), false, '冷却中');
});

test('AI 会接近并攻击，最终分出胜负', () => {
    const b = mk();
    let guard = 0;
    while (!b.result && guard++ < 60) {
        for (const u of E.alive(b).filter(u => u.side === 'player')) E.aiAct(b, u, S.rules, Math.random);
        E.endPlayerPhase(b, S.rules, Math.random);
    }
    assert.ok(b.result === 'victory' || b.result === 'defeat', `result ${b.result} after ${guard} turns`);
});

test('distanceField 绕河行走', () => {
    const b = mk();
    const k = b.units[0];
    const f = E.distanceField(b, k, [[7, 0]]);
    assert.ok(f[0 * b.w + 5] > 2, 'must route around the river via the bridge');
    assert.ok(isFinite(f[0 * b.w + 5]));
});
