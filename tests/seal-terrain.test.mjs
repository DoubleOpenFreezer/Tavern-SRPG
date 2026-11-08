import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings, makeMap, makeUnit, makeSkill } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';
import { exchangePreview } from '../src/exchange.js';
import { skillFrom, normalizeDesign, buildDesignPrompt } from '../src/designer.js';
import { makeProfile } from '../src/defaults.js';

const S = defaultSettings();
const rules = { ...S.rules, variance: 0, counter: true, hitEnabled: false };
const fixed = () => 0.5;

function battle(units, placements, tiles = new Array(50).fill('plain')) {
    const map = makeMap({ w: 10, h: 5, tiles, placements });
    return E.createBattle(map, units, S.terrains);
}
function duel() {
    const hero = makeUnit({ id: 'h', name: '勇者', hp: 40, atk: 12, def: 2 });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 40, atk: 12, def: 2, ai: 'stationary' });
    const b = battle([hero, orc], [{ unitId: 'h', x: 2, y: 2 }, { unitId: 'o', x: 3, y: 2 }]);
    return { b, h: b.units[0], o: b.units[1] };
}

test('封印反击：不能反击，也不能先攻；仍可防御', () => {
    const { b, h, o } = duel();
    o.statuses.push({ type: 'seal_counter', value: 0, turns: 1, srcSide: 'player' });
    assert.equal(E.canCounter(b, o, h), false);
    assert.equal(E.canRespond(b, h, o, rules), false);
    assert.equal(E.defaultReaction(b, h, o, rules), 'defend', '不能反击时改为防御');
    const ev = E.doAttack(b, h, o, rules, fixed, 'counter');
    assert.equal(ev.counter, null);
    assert.equal(h.hp, 40);
    // 后手武器：被封印反击的一方不会先攻
    h.attackOrder = 'last'; h.acted = false;
    const ev2 = E.doAttack(b, h, o, rules, fixed, 'counter');
    assert.equal(ev2.firstStrike, null);
});

test('封印防御：选择防御按承受结算且不消耗韧性，AI 默认改为反击或承受', () => {
    const { b, h, o } = duel();
    o.statuses.push({ type: 'seal_defend', value: 0, turns: 1, srcSide: 'player' });
    assert.equal(E.canDefend(o), false);
    const full = E.calcDamage(b, h, o, 'physical', 100, rules, fixed, true);
    assert.equal(exchangePreview(b, h, o, rules, null, 'defend').damage, full, '预览不按防御减伤');
    const tough = E.toughLeft(o);
    const ev = E.doAttack(b, h, o, { ...rules, counter: false }, fixed, 'defend');
    assert.equal(ev.reaction, 'none');
    assert.equal(ev.sealed, true);
    assert.equal(ev.damage, full);
    assert.equal(E.toughLeft(o), tough, '没有防御，不消耗韧性');
    assert.match(formatEvent(ev), /兽人的防御被封印，只能硬接这一击/);
    assert.equal(E.defaultReaction(b, h, o, { ...rules, counter: false }), 'none');
    assert.equal(E.defaultReaction(b, h, o, rules), 'counter', '仍可反击');
});

test('封印效果可以由技能施加，并写进战场状态', () => {
    const breaker = makeSkill({ id: 'br', name: '破甲', kind: 'physical', power: 50, effects: [{ type: 'seal_defend', value: 0, turns: 1 }, { type: 'seal_counter', value: 0, turns: 1 }] });
    const hero = makeUnit({ id: 'h', name: '勇者', hp: 40, atk: 12, skills: [breaker] });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 99, ai: 'stationary' });
    const b = battle([hero, orc], [{ unitId: 'h', x: 2, y: 2 }, { unitId: 'o', x: 3, y: 2 }]);
    const [h, o] = b.units;
    const ev = E.doSkill(b, h, h.skills[0], 3, 2, rules, fixed, { [o.uid]: 'none' });
    assert.ok(E.hasStatus(o, 'seal_defend') && E.hasStatus(o, 'seal_counter'));
    assert.match(formatEvent(ev), /陷入【封印防御】（1 回合）.*陷入【封印反击】（1 回合）/);
    assert.match(buildBattleContext(b, S), /封印防御（减益，剩 1 回合）/);
    // 持续到我方下个阶段开始
    E.endPlayerPhase(b, rules, fixed);
    assert.ok(!E.hasStatus(o, 'seal_defend'));
});

test('AI 设计：技能可以使用封印效果', () => {
    const warnings = [];
    const sk = skillFrom({ name: '缴械', kind: 'physical', effects: [{ type: '封印反击', turns: 2 }] }, { name: '盗贼' }, warnings);
    assert.deepEqual(sk.effects, [{ type: 'seal_counter', value: 0, turns: 2 }]);
    assert.equal(warnings.length, 0);
});

function swampBattle(effects, extra = {}) {
    const tiles = new Array(50).fill('plain');
    tiles[2 * 10 + 4] = 'swamp';
    const hero = makeUnit({ id: 'h', name: '勇者', hp: 40, mov: 5, ...extra });
    const orc = makeUnit({ id: 'o', name: '兽人', side: 'enemy', hp: 40, ai: 'stationary' });
    const b = battle([hero, orc], [{ unitId: 'h', x: 1, y: 2 }, { unitId: 'o', x: 9, y: 4 }], tiles);
    b.terrains.swamp = { ...b.terrains.plain, id: 'swamp', name: '沼泽', effects };
    return { b, h: b.units[0], o: b.units[1] };
}

test('落脚效果：移动终点落在地形上时获得效果，按自己阵营计时', () => {
    const { b, h } = swampBattle([{ type: 'seal_defend', value: 0, turns: 1 }, { type: 'temp_hp', value: 25, turns: 1 }]);
    const ev = E.doMove(b, h, 4, 2);
    assert.ok(E.hasStatus(h, 'seal_defend'));
    assert.equal(E.tempHp(h), 10);
    assert.equal(ev.terrainEffect.terrain, '沼泽');
    assert.match(formatEvent(ev), /踏入沼泽，陷入【封印防御】（1 回合），获得 10 点临时HP/);
    assert.equal(h.statuses.find(s => s.type === 'seal_defend').srcSide, 'player');
    assert.match(buildBattleContext(b), /落脚时获得：封印防御（1回合）、临时HP25%（1回合）/);
    // 经过而不停留不触发；原地不重复触发
    E.doMove(b, h, 4, 2);
    assert.equal(h.statuses.filter(s => s.type === 'seal_defend').length, 1);
    E.endPlayerPhase(b, rules, fixed);
    assert.ok(!E.hasStatus(h, 'seal_defend'), '自己的下个阶段开始时结束');
});

test('落脚效果：路过不触发，飞行默认免疫，传送也会触发，致死时不再施加', () => {
    const { b, h } = swampBattle([{ type: 'poison', value: 10, turns: 2 }]);
    E.doMove(b, h, 6, 2);
    assert.ok(!E.hasStatus(h, 'poison'), '只结算落脚格');
    h.x = 1; h.y = 2;
    h.flying = true;
    E.doMove(b, h, 4, 2);
    assert.ok(!E.hasStatus(h, 'poison'), '飞行默认免疫');
    h.x = 1; h.flying = false;
    b.terrains.swamp.enterDamage = 99;
    const dead = E.doMove(b, h, 4, 2);
    assert.equal(h.hp, 0);
    assert.equal(dead.terrainEffect, undefined);

    const blink = makeSkill({ id: 'tp', name: '闪现', kind: 'support', target: 'tile', rangeMin: 1, rangeMax: 5, effects: [] });
    const r = swampBattle([{ type: 'stun', value: 0, turns: 1 }], { skills: [blink] });
    const ev = E.doSkill(r.b, r.h, r.h.skills[0], 4, 2, rules, fixed);
    assert.ok(E.isStunned(r.h));
    assert.match(formatEvent(ev), /传送到 \(5,3\)沼泽，.*踏入沼泽，陷入【眩晕】/);
});

test('落脚效果：只保留可用的预设，AI 设计也会校验', () => {
    assert.ok(E.TERRAIN_EFFECTS.seal_defend && E.TERRAIN_EFFECTS.heal_pct && E.TERRAIN_EFFECTS.temp_hp);
    assert.ok(!E.TERRAIN_EFFECTS.cover && !E.TERRAIN_EFFECTS.recall && !E.TERRAIN_EFFECTS.refresh && !E.TERRAIN_EFFECTS.heal);
    const { b, h } = swampBattle([{ type: 'cover', value: 0, turns: 1 }, { type: 'heal_pct', value: 50, turns: 0 }]);
    h.hp = 10;
    const ev = E.doMove(b, h, 4, 2);
    assert.equal(h.hp, 30);
    assert.ok(!E.hasStatus(h, 'cover'));
    assert.match(formatEvent(ev), /踏入沼泽，恢复 20 点生命（HP 10→30）/);

    const d = normalizeDesign({ terrains: [{ name: '泥沼', effects: [{ type: '封印防御', turns: 2 }, { type: 'cover' }] }] }, makeProfile());
    assert.deepEqual(d.terrains[0].effects, [{ type: 'seal_defend', value: 0, turns: 2 }]);
    assert.ok(d.warnings.some(w => /泥沼.*cover/.test(w)));
    assert.match(buildDesignPrompt(makeProfile()).system, /地形 effects 是单位落脚/);
});
