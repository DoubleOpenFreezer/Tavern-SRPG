import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings, makeMap, makeUnit, makeSkill } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { composeMessage } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';

const S = defaultSettings();
const rules = { ...S.rules, variance: 0, counter: false };
const fixed = () => 0.5;

function battle(units, placements) {
    const map = makeMap({ w: 10, h: 5, tiles: new Array(50).fill('plain'), placements });
    return E.createBattle(map, units, S.terrains);
}
const sup = (effects, over = {}) => makeSkill({ kind: 'support', target: 'ally', rangeMin: 0, rangeMax: 3, effects, ...over });

test('冷却：冷却 3 回合的技能每 3 回合可用一次', () => {
    const hero = makeUnit({ id: 'h', name: '勇者', hp: 30, atk: 10, skills: [makeSkill({ id: 'sk', name: '重击', cooldown: 3 })] });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 999, atk: 0, ai: 'stationary' });
    const b = battle([hero, orc], [{ unitId: 'h', x: 0, y: 0 }, { unitId: 'o', x: 1, y: 0 }]);
    const [h, o] = b.units;
    const sk = h.skills[0];
    E.doSkill(b, h, sk, 1, 0, rules, fixed); // 第 1 回合使用
    assert.equal(E.readyTurn(b, h, sk), 4);
    E.endPlayerPhase(b, rules, fixed); // 第 2 回合
    assert.equal(E.skillUsable(sk), false);
    E.endPlayerPhase(b, rules, fixed); // 第 3 回合
    assert.equal(E.skillUsable(sk), false);
    E.endPlayerPhase(b, rules, fixed); // 第 4 回合
    assert.equal(E.skillUsable(sk), true);
    assert.ok(o.hp > 0);
});

test('防御力上升减少伤害，持续回合结束后消失', () => {
    const mage = makeUnit({ id: 'm', name: '法师', hp: 20, matk: 10, skills: [sup([{ type: 'def_up', value: 50, turns: 1 }])] });
    const knight = makeUnit({ id: 'k', name: '骑士', hp: 40, def: 10 });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 50, atk: 20, mov: 0, ai: 'stationary' });
    const b = battle([mage, knight, orc], [{ unitId: 'm', x: 0, y: 0 }, { unitId: 'k', x: 5, y: 2 }, { unitId: 'o', x: 6, y: 2 }]);
    const [m, k, o] = b.units;
    m.x = 4; m.y = 2;
    const ev = E.doSkill(b, m, m.skills[0], 5, 2, rules, fixed);
    assert.equal(E.stat(k, 'def'), 15);
    assert.match(composeMessage(b, [ev], S), /骑士 获得【防御力上升50%】（1 回合）/);
    const enemy = E.endPlayerPhase(b, rules, fixed);
    const hit = enemy.find(e => e.type === 'attack' && e.target.name === '骑士');
    assert.equal(hit.damage, Math.round(20 * 12 / (12 + 15)), '敌方阶段时增益仍然有效');
    assert.ok(enemy.some(e => e.type === 'statusEnd' && e.actor.name === '骑士'), '下个我方阶段开始时结束');
    assert.equal(E.stat(k, 'def'), 10);
});

test('嘲讽：敌人只能攻击嘲讽者，即使旁边有更弱的目标', () => {
    const tank = makeUnit({ id: 't', name: '盾卫', hp: 50, def: 8, skills: [sup([{ type: 'taunt', value: 0, turns: 1 }], { target: 'self' })] });
    const weak = makeUnit({ id: 'w', name: '村民', hp: 5, def: 0 });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 30, atk: 10, mov: 4 });
    const b = battle([tank, weak, orc], [{ unitId: 't', x: 0, y: 4 }, { unitId: 'w', x: 6, y: 2 }, { unitId: 'o', x: 7, y: 2 }]);
    const [t] = b.units;
    E.doSkill(b, t, t.skills[0], 0, 0, rules, fixed);
    const ev = E.endPlayerPhase(b, rules, fixed);
    assert.ok(!ev.some(e => e.type === 'attack' && e.target.name === '村民'), '不应攻击村民');
    assert.ok(ev.some(e => e.type === 'move' && e.actor.name === '兽人'), '朝嘲讽者前进');
});

test('嘲讽：被敌方嘲讽时，我方也只能攻击嘲讽者', () => {
    const hero = makeUnit({ id: 'h', name: '勇者', hp: 30, atk: 10, rangeMax: 2 });
    const a = makeUnit({ id: 'a', name: '兽人', side: 'enemy', hp: 30 });
    const bUnit = makeUnit({ id: 'b', name: '兽人王', side: 'enemy', hp: 30 });
    const b = battle([hero, a, bUnit], [{ unitId: 'h', x: 2, y: 2 }, { unitId: 'a', x: 3, y: 2 }, { unitId: 'b', x: 4, y: 2 }]);
    const [h, orc, king] = b.units;
    king.statuses.push({ type: 'taunt', value: 0, turns: 1, srcSide: 'enemy' });
    assert.deepEqual(E.attackTargets(b, h).map(u => u.name), ['兽人王']);
    assert.throws(() => E.doAttack(b, h, orc, rules, fixed), /嘲讽/);
});

test('立即恢复、驱散、中毒不会致死、眩晕跳过行动', () => {
    const healer = makeUnit({ id: 'h', name: '牧师', hp: 20, matk: 10, skills: [
        sup([{ type: 'heal', value: 100 }, { type: 'cleanse' }], { id: 's1' }),
    ] });
    const ally = makeUnit({ id: 'a', name: '战士', hp: 40 });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 30, atk: 5 });
    const b = battle([healer, ally, orc], [{ unitId: 'h', x: 0, y: 0 }, { unitId: 'a', x: 1, y: 0 }, { unitId: 'o', x: 9, y: 4 }]);
    const [h, a, o] = b.units;
    a.hp = 10;
    a.statuses.push({ type: 'poison', value: 50, turns: 3, srcSide: 'enemy' }, { type: 'atk_up', value: 10, turns: 3, srcSide: 'player' });
    const ev = E.doSkill(b, h, h.skills[0], 1, 0, rules, fixed);
    assert.equal(a.hp, 20);
    assert.deepEqual(a.statuses.map(x => x.type), ['atk_up'], '只驱散减益');
    assert.match(composeMessage(b, [ev], S), /恢复 10 点生命，被驱散了【中毒50%】/);

    a.hp = 3;
    a.statuses.push({ type: 'poison', value: 50, turns: 3, srcSide: 'enemy' });
    o.statuses.push({ type: 'stun', turns: 1, srcSide: 'player' });
    const ev2 = E.endPlayerPhase(b, rules, fixed);
    assert.ok(ev2.some(e => e.type === 'stunned' && e.actor.name === '兽人'));
    assert.ok(!ev2.some(e => e.type === 'move' && e.actor.name === '兽人'));
    const tick = ev2.find(e => e.type === 'dot');
    assert.ok(ev2.indexOf(tick) > ev2.findIndex(e => e.type === 'phase' && e.phase === 'player'), '中毒在受害者自己的阶段开始时结算');
    assert.equal(a.hp, 1, '中毒不会致死');
    assert.match(buildBattleContext(b), /\[P2\] 战士｜我方｜位于 \(2,1\) 平原｜HP 1\/40\n.*\n  状态：攻击力上升10%（增益，剩 \d 回合）、中毒50%（减益，剩 \d 回合）/);
});

test('AI 会使用治疗和增益技能；伤害技能可附带减益', () => {
    const priest = makeUnit({ id: 'p', name: '萨满', side: 'enemy', hp: 20, matk: 10, mov: 3, ai: 'defensive',
        skills: [sup([{ type: 'heal', value: 150 }], { id: 'heal' })] });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 40, mov: 0, ai: 'stationary' });
    const archer = makeUnit({ id: 'a', name: '弓手', hp: 20, atk: 10, rangeMin: 2, rangeMax: 3,
        skills: [makeSkill({ id: 'pa', name: '破甲箭', power: 100, rangeMin: 2, rangeMax: 3, effects: [{ type: 'def_down', value: 50, turns: 2 }] })] });
    const b = battle([priest, orc, archer], [{ unitId: 'p', x: 8, y: 0 }, { unitId: 'o', x: 8, y: 2 }, { unitId: 'a', x: 0, y: 4 }]);
    const [p, o, a] = b.units;
    o.hp = 10;
    const ev = E.aiAct(b, p, rules, fixed);
    assert.equal(ev.at(-1).type, 'skill');
    assert.equal(o.hp, 25);

    a.x = 6; a.y = 2;
    E.doSkill(b, a, a.skills[0], 8, 2, rules, fixed);
    assert.ok(E.hasStatus(o, 'def_down'));
});

test('旧版治疗技能自动升级为辅助技能', () => {
    const sk = E.normalizeSkill({ name: '治愈', kind: 'heal', power: 120, rangeMin: 0, rangeMax: 2 });
    assert.equal(sk.kind, 'support');
    assert.equal(sk.target, 'ally');
    assert.deepEqual(sk.effects, [{ type: 'heal', value: 120, turns: 0 }]);
    assert.equal(sk.cooldown, 0);
});
