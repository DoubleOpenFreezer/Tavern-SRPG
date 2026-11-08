import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatDefaults as defaultSettings, makeMap, makeUnit, makeSkill } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent } from '../src/narrator.js';
import { buildBattleContext } from '../src/context.js';
import { parseCommands, applyCommand } from '../src/commands.js';
import { exchangePreview } from '../src/exchange.js';
import { actionFrames } from '../src/ui/action-process.js';

const S = defaultSettings();
const rules = { ...S.rules, variance: 0, counter: false, hitEnabled: false };
const fixed = () => 0.5;

function battle(units, placements) {
    const map = makeMap({ w: 10, h: 5, tiles: new Array(50).fill('plain'), placements });
    return E.createBattle(map, units, S.terrains);
}
const pills = (value = 50, turns = 2) => makeSkill({ id: 'pills', name: '止痛药', kind: 'support', target: 'self', rangeMin: 0, rangeMax: 0, effects: [{ type: 'temp_hp', value, turns }] });

function setup({ value = 50, turns = 2, foeAtk = 12 } = {}) {
    const hero = makeUnit({ id: 'h', name: '幸存者', hp: 40, def: 0, mdef: 0, skills: [pills(value, turns)] });
    const zombie = makeUnit({ id: 'z', name: '丧尸', side: 'enemy', hp: 999, atk: foeAtk, mov: 0, ai: 'stationary' });
    const b = battle([hero, zombie], [{ unitId: 'h', x: 2, y: 2 }, { unitId: 'z', x: 3, y: 2 }]);
    return { b, h: b.units[0], z: b.units[1] };
}

test('临时HP：按最大HP比例获得，伤害先扣临时HP，HP 不变', () => {
    const { b, h, z } = setup();
    const ev = E.doSkill(b, h, h.skills[0], h.x, h.y, rules, fixed);
    assert.equal(E.tempHp(h), 20);
    assert.equal(E.effectiveHp(h), 60);
    assert.match(formatEvent(ev), /获得 20 点临时HP（2 回合后消失）/);
    const dmg = E.calcDamage(b, z, h, 'physical', 100, rules, fixed, true);
    assert.ok(dmg < 20);
    const atk = E.doAttack(b, z, h, rules, fixed, 'none');
    assert.equal(h.hp, 40, 'HP 没有减少');
    assert.equal(E.tempHp(h), 20 - dmg);
    assert.equal(atk.absorbed, dmg);
    assert.match(formatEvent(atk), new RegExp(`造成 ${dmg} 点伤害（幸存者 HP 40→40，临时HP抵消 ${dmg}、剩 ${20 - dmg}）`));
});

test('临时HP：伤害超过临时HP时余下的扣 HP，打光后状态消失', () => {
    const { b, h, z } = setup({ value: 10, foeAtk: 25 });
    E.doSkill(b, h, h.skills[0], h.x, h.y, rules, fixed);
    assert.equal(E.tempHp(h), 4);
    const dmg = E.calcDamage(b, z, h, 'physical', 100, rules, fixed, true);
    assert.equal(E.hpAfterDamage(h, dmg), 40 - (dmg - 4), '预测与结算一致');
    const atk = E.doAttack(b, z, h, rules, fixed, 'none');
    assert.equal(h.hp, 40 - (dmg - 4));
    assert.equal(atk.absorbed, 4);
    assert.ok(!E.hasStatus(h, 'temp_hp'), '临时HP打光后状态移除');
    assert.match(formatEvent(atk), /临时HP抵消 4、已耗尽/);
});

test('临时HP：持续回合结束后剩余部分消失', () => {
    const { b, h, z } = setup({ turns: 1 });
    z.x = 9; // 不让丧尸打到
    E.doSkill(b, h, h.skills[0], h.x, h.y, rules, fixed);
    const events = E.endPlayerPhase(b, rules, fixed);
    assert.equal(E.tempHp(h), 0);
    assert.equal(h.hp, 40);
    const end = events.find(e => e.type === 'statusEnd' && e.actor.name === '幸存者');
    assert.equal(end.tempLost, 20);
    assert.match(formatEvent(end), /【临时HP 20】效果结束了，剩下的 20 点临时HP随之消失/);
});

test('临时HP：再次获得时取较多的一份并刷新回合，不叠加', () => {
    const { b, h } = setup();
    E.grantTempHp(h, 5, 1, 'player');
    E.grantTempHp(h, 3, 3, 'player');
    assert.equal(E.tempHp(h), 5);
    assert.equal(h.statuses.filter(s => s.type === 'temp_hp').length, 1);
    assert.equal(h.statuses.find(s => s.type === 'temp_hp').turns, 3);
    E.grantTempHp(h, 9, 2, 'player');
    assert.equal(E.tempHp(h), 9);
});

test('临时HP：中毒和地形伤害也先扣临时HP，中毒仍不会致死', () => {
    const { b, h, z } = setup();
    z.x = 9;
    h.hp = 1;
    E.grantTempHp(h, 3, 5, 'enemy');
    h.statuses.push({ type: 'poison', value: 10, turns: 5, srcSide: 'enemy' });
    const events = E.endPlayerPhase(b, rules, fixed);
    const dot = events.find(e => e.type === 'dot' && e.effect === 'poison');
    assert.equal(dot.absorbed, 3);
    assert.equal(h.hp, 1, '毒先吃掉临时HP，HP 停在 1');
    assert.match(formatEvent(dot), /损失 3 点生命（HP 1→1，临时HP抵消 3、已耗尽）/);

    const lava = { ...S.terrains.plain, id: 'lava', name: '熔岩', enterDamage: 10 };
    b.terrains.lava = lava;
    h.hp = 30;
    E.grantTempHp(h, 6, 2, 'player');
    b.tiles[h.y * b.w + h.x] = 'lava';
    const burn = E.terrainDamage(b, h);
    assert.equal(burn.damage, 10);
    assert.equal(burn.absorbed, 6);
    assert.equal(h.hp, 26);
});

test('临时HP：预测与 AI 按有效生命判断能否击败', () => {
    const { b, h, z } = setup({ foeAtk: 45 });
    const dmg = E.calcDamage(b, z, h, 'physical', 100, rules, fixed, true);
    assert.ok(dmg >= h.hp);
    E.grantTempHp(h, 20, 2, 'player');
    assert.ok(dmg < E.effectiveHp(h));
    assert.equal(E.hpAfterDamage(h, dmg), 60 - dmg);
    const p = exchangePreview(b, z, h, rules, null, 'none');
    assert.equal(p.damage, dmg);
    assert.equal(E.previewAttack(b, z, h, rules, 'none').expectedDamage, dmg);
});

test('临时HP：AI 在受威胁时会给自己吃药，已有更多临时HP时不会', () => {
    const hero = makeUnit({ id: 'h', name: '幸存者', hp: 40 });
    const medic = makeUnit({ id: 'm', name: '药剂师', side: 'enemy', hp: 30, atk: 0, mov: 0, ai: 'stationary', skills: [pills(50, 2)] });
    const b = battle([hero, medic], [{ unitId: 'h', x: 1, y: 2 }, { unitId: 'm', x: 4, y: 2 }]);
    const [, m] = b.units;
    const events = E.endPlayerPhase(b, rules, fixed);
    assert.ok(events.some(e => e.type === 'skill' && e.actor.name === '药剂师'), '受威胁时使用');
    assert.equal(E.tempHp(m), 15);
    m.skills[0].cdLeft = 0;
    E.grantTempHp(m, 99, 5, 'enemy');
    const again = E.endPlayerPhase(b, rules, fixed);
    assert.ok(!again.some(e => e.type === 'skill' && e.actor.name === '药剂师'), '已有更多临时HP时不浪费');
});

test('临时HP：剧情指令 status / damage 与战场状态', () => {
    const { b, h } = setup();
    const opt = { ...S.llm, unitDefs: S.units, terrainDefs: S.terrains, maxChangePct: 50 };
    const run = text => parseCommands(text).map(c => applyCommand(b, c, opt));
    const [st] = run('status 幸存者 temp_hp 25 2 服下止痛药');
    assert.equal(E.tempHp(h), 10);
    assert.match(formatEvent(st), /获得【临时HP 10】（2 回合）/);
    assert.match(buildBattleContext(b, S), /HP 40\/40＋临时HP 10/);
    const [hit] = run('damage 幸存者 15 被咬了一口');
    assert.equal(hit.amount, 15);
    assert.equal(h.hp, 35);
    assert.match(formatEvent(hit), /受到 15 点伤害（HP 40→35，临时HP抵消 10、已耗尽）/);
});

test('临时HP：回放时伤害数字包含被抵消的部分，血条上的临时HP同步减少', () => {
    const { b, h, z } = setup();
    E.doSkill(b, h, h.skills[0], h.x, h.y, rules, fixed);
    const before = structuredClone(b);
    const ev = E.doAttack(b, z, h, rules, fixed, 'none');
    const frames = [...actionFrames(before, b, [ev])];
    const last = frames.at(-1);
    const shown = last.battle.units.find(u => u.uid === h.uid);
    assert.equal(E.tempHp(shown), E.tempHp(h));
    assert.equal(last.effects[0].text, `−${ev.absorbed}`);
});
