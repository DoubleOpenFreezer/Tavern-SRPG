import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules, defaultSettings } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';
import { applyManualChange } from '../src/manual.js';
import { normalizeProfile } from '../src/st.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false, counter: true };
const fixed = () => 0.5;
function battle(defs, positions) {
    return E.createBattle(makeMap({ w: 8, h: 5, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS);
}
const archer = (over = {}) => makeUnit({ id: 'ar', name: '弓手', hp: 100, atk: 20, rangeMin: 2, rangeMax: 3, ...over });
const knight = (over = {}) => makeUnit({ id: 'kn', name: '骑士', hp: 100, atk: 20, ...over });
const orc = (over = {}) => makeUnit({ id: 'orc', name: '兽人', side: 'enemy', hp: 200, atk: 15, ai: 'stationary', ...over });

test('每次防御或反击消耗1点韧性，耗尽后只能承受全额伤害且不反击', () => {
    const b = battle([archer(), knight(), orc({ tough: 2 })], [[0, 2], [2, 1], [2, 2]]);
    const [ar, kn, o] = b.units;
    assert.equal(E.toughLeft(o), 2);
    assert.equal(E.defaultReaction(b, ar, o, rules), 'defend', '近战目标打不到弓手，只能防御');
    const first = E.doAttack(b, ar, o, rules, fixed, 'defend');
    assert.equal(first.reaction, 'defend');
    assert.deepEqual(first.tough, [2, 1]);
    assert.equal(E.defaultReaction(b, kn, o, rules), 'counter');
    const second = E.doAttack(b, kn, o, rules, fixed, 'counter');
    assert.ok(second.counter, '还有韧性时可以反击');
    assert.equal(E.toughLeft(o), 0);

    // 韧性耗尽：默认反应为承受，强行选择防御 / 反击也无效
    ar.acted = false; kn.acted = false;
    assert.equal(E.defaultReaction(b, ar, o, rules), 'none');
    assert.equal(E.canRespond(b, kn, o, rules), false);
    const hpBefore = kn.hp;
    const third = E.doAttack(b, kn, o, rules, fixed, 'counter');
    assert.equal(third.reaction, 'none');
    assert.equal(third.exhausted, true);
    assert.equal(third.counter, null);
    assert.equal(kn.hp, hpBefore);
    assert.ok(third.damage > first.damage, '承受时没有防御减伤');
    assert.match(formatEvent(third), /韧性耗尽，无法防御或反击/);
    assert.match(buildBattleContext(b), /兽人｜敌方｜位于 \(3,3\) 平原｜HP \d+\/200｜韧性 0\/2（耗尽，无法防御或反击）/);
    assert.equal(E.previewAttack(b, ar, o, rules, E.defaultReaction(b, ar, o, rules)).damage, third.damage);

    // 己方阶段开始时回满；其他阵营的阶段不回复
    const ev = E.endPlayerPhase(b, rules, fixed);
    assert.ok(ev.some(e => e.type === 'phase'));
    assert.equal(E.toughLeft(o), 2);
});

test('技能和MAP攻击：每个目标的防御各消耗韧性，未命中也消耗，耗尽的目标承受全额伤害', () => {
    const blast = makeSkill({ id: 'map', attackMode: 'mapLine', lineLength: 4, power: 100, mapTargets: 'enemy' });
    const b = battle([archer({ skills: [blast] }), orc({ id: 'o1', tough: 1 }), orc({ id: 'o2', tough: 0 })], [[0, 2], [1, 2], [2, 2]]);
    const [ar, o1, o2] = b.units;
    const responses = { [o1.uid]: E.defaultReaction(b, ar, o1, rules, blast), [o2.uid]: E.defaultReaction(b, ar, o2, rules, blast) };
    assert.deepEqual(Object.values(responses), ['defend', 'none']);
    const ev = E.doSkill(b, ar, ar.skills[0], 1, 2, rules, fixed, responses);
    const [r1, r2] = ev.results;
    assert.equal(r1.reaction, 'defend');
    assert.equal(E.toughLeft(o1), 0);
    assert.equal(r2.reaction, 'none');
    assert.equal(r2.exhausted, true);
    assert.ok(r2.damage > r1.damage);
    assert.match(formatEvent(ev), /韧性耗尽，无法防御/);

    const missRules = { ...rules, hitEnabled: true, baseHit: 0 };
    const single = makeSkill({ id: 'shot', rangeMin: 2, rangeMax: 3 });
    const b2 = battle([archer({ skills: [single] }), knight({ id: 'k2', side: 'enemy', tough: 1, rangeMin: 2, rangeMax: 3 })], [[0, 0], [2, 0]]);
    const [a2, k2] = b2.units;
    const miss = E.doSkill(b2, a2, a2.skills[0], 2, 0, missRules, fixed, { [k2.uid]: 'counter' });
    assert.ok(miss.results[0].missed);
    assert.ok(miss.results[0].counter, '技能未命中，反击照常进行');
    assert.equal(E.toughLeft(k2), 0);
});

test('AI会优先攻击韧性耗尽的目标；建筑没有韧性', () => {
    const b = battle([knight({ id: 'k1', tough: 0 }), knight({ id: 'k2', tough: 2 }), orc({ ai: 'stationary', atk: 30 }), makeUnit({ id: 'wall', kind: 'object', hp: 50 })], [[1, 2], [3, 2], [2, 2], [5, 4]]);
    const [k1, k2, o, wall] = b.units;
    assert.equal(E.toughMax(wall), 0);
    assert.equal(E.defaultReaction(b, o, wall, rules), 'none');
    const ev = E.aiAct(b, o, rules, fixed);
    assert.equal(ev.find(e => e.type === 'attack').target.uid, k1.uid);
    assert.ok(k2.hp === k2.maxHp);
});

test('旧资料卡与旧战斗补上默认韧性；手动修改可调整韧性，恢复会回满', () => {
    const p = defaultSettings().profiles[0];
    delete p.units[0].tough;
    normalizeProfile(p);
    assert.equal(p.units[0].tough, 2);
    const b = battle([knight({ tough: 3 }), orc()], [[0, 0], [4, 4]]);
    const k = b.units[0];
    assert.equal(E.toughMax(k), 3);
    delete k.tough; delete k.toughMax;
    assert.equal(E.toughLeft(k), E.DEFAULT_TOUGH, '旧战斗单位视为默认韧性');
    k.toughMax = 3; k.tough = 3;
    applyManualChange(b, { type: 'stat', uid: k.uid, key: 'tough', value: 1 }, p);
    assert.equal(E.toughLeft(k), 1);
    assert.throws(() => applyManualChange(b, { type: 'stat', uid: k.uid, key: 'tough', value: 9 }, p), /韧性上限/);
    applyManualChange(b, { type: 'restore', uid: k.uid }, p);
    assert.equal(E.toughLeft(k), 3);
    applyManualChange(b, { type: 'stat', uid: k.uid, key: 'toughMax', value: 1 }, p);
    assert.equal(E.toughLeft(k), 1);
});
