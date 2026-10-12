import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings, makeMap, makeUnit, makeSkill } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { composeMessage } from '../src/narrator.js';

const S = defaultSettings();
const rules = { ...S.rules, variance: 0, counter: true, baseHit: 90, agiFactor: 3 };
const roll = v => () => v; // rng 固定返回 v：v*100 < 命中率 才命中

function battle(units, placements, tiles) {
    const map = makeMap({ w: 6, h: 3, tiles: tiles || new Array(18).fill('plain'), placements });
    return E.createBattle(map, units, S.terrains);
}
const fast = makeUnit({ id: 'f', name: '刺客', hp: 30, atk: 12, def: 2, agi: 15 });
const slow = makeUnit({ id: 's', name: '重甲兵', side: 'enemy', hp: 30, atk: 10, def: 2, agi: 5 });

test('命中率 = 基础 + 敏捷差 × 系数 − 地形闪避，限制在 0–100', () => {
    const b = battle([fast, slow], [{ unitId: 'f', x: 0, y: 0 }, { unitId: 's', x: 1, y: 0 }]);
    const [f, s] = b.units;
    assert.equal(E.hitChance(b, f, s, rules), 100); // 90 + 30 → 封顶 100
    assert.equal(E.hitChance(b, s, f, rules), 60); // 90 − 30
    b.tiles[0] = 'forest'; // 刺客站在森林（闪避 +15）
    assert.equal(E.hitChance(b, s, f, rules), 45);
    f.statuses.push({ type: 'agi_down', value: 100, turns: 1, srcSide: 'enemy' }); // 敏捷降为 0
    assert.equal(E.hitChance(b, s, f, rules), 90 + 15 - 15);
    assert.equal(E.hitChance(b, s, f, { ...rules, hitEnabled: false }), 100);
});

test('未命中时不造成伤害，反击也会判定', () => {
    const b = battle([fast, slow], [{ unitId: 'f', x: 0, y: 0 }, { unitId: 's', x: 1, y: 0 }]);
    const [f, s] = b.units;
    // rng 0.7：刺客命中率 100% 必中；重甲兵反击命中率 60%，70 ≥ 60 未命中
    const ev = E.doAttack(b, f, s, rules, roll(0.7));
    assert.equal(ev.hit, true);
    assert.equal(s.hp, 30 - 10);
    assert.equal(ev.counter.hit, false);
    assert.equal(f.hp, 30);
    const msg = composeMessage(b, [ev], S);
    assert.match(msg, /重甲兵 反击，但被 刺客 躲开了（未命中）/);

    const ev2 = E.doAttack(b, s, f, rules, roll(0.7));
    assert.equal(ev2.hit, false);
    assert.equal(ev2.damage, 0);
    assert.equal(f.hp, 30);
    assert.match(composeMessage(b, [ev2], S), /但被 刺客 闪避了（未命中）/);
});

test('技能命中：范围技能逐个判定，必中与命中修正，友方技能必定命中', () => {
    const mage = makeUnit({ id: 'm', name: '法师', hp: 20, matk: 20, agi: 0, skills: [
        makeSkill({ id: 'aoe', name: '雷暴', kind: 'magical', power: 100, rangeMin: 1, rangeMax: 3, radius: 1 }),
        makeSkill({ id: 'sure', name: '魔弹', kind: 'magical', power: 100, rangeMin: 1, rangeMax: 3, sureHit: true }),
        makeSkill({ id: 'buff', name: '祝福', kind: 'support', target: 'self', effects: [{ type: 'atk_up', value: 10, turns: 1 }] }),
    ] });
    const a = makeUnit({ id: 'a', name: '哥布林', side: 'enemy', hp: 40, mdef: 0, agi: 0 });
    const c = makeUnit({ id: 'c', name: '影狼', side: 'enemy', hp: 40, mdef: 0, agi: 20 });
    const b = battle([mage, a, c], [{ unitId: 'm', x: 0, y: 1 }, { unitId: 'a', x: 2, y: 1 }, { unitId: 'c', x: 3, y: 1 }]);
    const [m, g, w] = b.units;
    const [aoe, sure, buff] = m.skills;
    assert.equal(E.skillHitChance(b, m, aoe, g, rules), 90);
    assert.equal(E.skillHitChance(b, m, aoe, w, rules), 30);
    const ev = E.doSkill(b, m, aoe, 2, 1, rules, roll(0.5));
    assert.deepEqual(ev.results.map(r => [r.target.name, !!r.missed]), [['哥布林', false], ['影狼', true]]);
    assert.equal(w.hp, 40);
    assert.match(composeMessage(b, [ev], S), /影狼 闪避了（未命中）/);

    aoe.hitMod = 70;
    assert.equal(E.skillHitChance(b, m, aoe, w, rules), 100);
    assert.equal(E.skillHitChance(b, m, sure, w, rules), 100);
    assert.equal(E.skillHitChance(b, m, buff, m, rules), 100);
    m.acted = false;
    E.doSkill(b, m, sure, 3, 1, rules, roll(0.99));
    assert.equal(w.hp, 20);
});

test('AI 按命中率估值：优先打容易命中的目标', () => {
    const archer = makeUnit({ id: 'ar', name: '弓手', side: 'enemy', hp: 20, atk: 12, agi: 5, mov: 0, rangeMin: 1, rangeMax: 3, ai: 'stationary' });
    const dodge = makeUnit({ id: 'd', name: '盗贼', hp: 20, def: 0, agi: 35 });
    const tank = makeUnit({ id: 't', name: '骑士', hp: 20, def: 2, agi: 0 });
    const b = battle([archer, dodge, tank], [{ unitId: 'ar', x: 0, y: 1 }, { unitId: 'd', x: 1, y: 1 }, { unitId: 't', x: 2, y: 1 }]);
    const ev = E.aiAct(b, b.units[0], rules, roll(0));
    assert.equal(ev.find(e => e.type === 'attack').target.name, '骑士');
});
