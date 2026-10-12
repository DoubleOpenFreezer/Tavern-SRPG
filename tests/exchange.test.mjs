import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMap, makeUnit, makeSkill, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { exchangePreview } from '../src/exchange.js';
import { formatEvent } from '../src/narrator.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false, counter: true };
function battle(over = {}) {
    const defs = [makeUnit({ id: 'p', name: '勇者', hp: 100, def: 0, atk: 20, mov: 0, ...over }), makeUnit({ id: 'e', name: '兽人', side: 'enemy', hp: 100, atk: 20, def: 0, mov: 0, ai: 'stationary' })];
    return E.createBattle(makeMap({ w: 4, h: 1, placements: [{ unitId: 'p', x: 0, y: 0 }, { unitId: 'e', x: 1, y: 0 }] }), defs, DEFAULT_TERRAINS);
}

test('反击和防御的预览与结算一致，防御减伤且放弃反击', () => {
    for (const reaction of ['counter', 'defend']) {
        const b = battle(), [p, e] = b.units;
        const forecast = exchangePreview(b, e, p, rules, null, reaction);
        const ev = E.doAttack(b, e, p, rules, () => 0.5, reaction);
        assert.equal(ev.damage, forecast.damage);
        assert.equal(ev.damage, reaction === 'defend' ? 10 : 20);
        assert.equal(ev.hitRate, forecast.hit);
        assert.equal(!!ev.counter, reaction === 'counter');
        assert.equal(e.hp, reaction === 'counter' ? 80 : 100);
        if (reaction === 'defend') assert.match(formatEvent(ev), /选择防御/);
    }
});

test('反击资格受射程、眩晕、MAP限制；无法反击默认防御，建筑不减伤', () => {
    const b = battle(), [p, e] = b.units;
    assert.equal(E.defaultReaction(b, e, p, rules), 'counter');
    e.x = 2; e.rangeMin = 2; e.rangeMax = 2;
    assert.equal(E.canRespond(b, e, p, rules), false);
    assert.equal(E.defaultReaction(b, e, p, rules), 'defend');
    e.x = 1; e.rangeMin = 1; e.rangeMax = 1;
    p.statuses = [{ type: 'stun', turns: 1 }];
    assert.equal(E.canRespond(b, e, p, rules), false);
    p.statuses = [];
    for (const mode of ['mapLine', 'mapArea']) assert.equal(E.canRespond(b, e, p, rules, makeSkill({ attackMode: mode })), false);
    p.object = true;
    assert.equal(E.defaultReaction(b, e, p, rules), 'none');
    assert.equal(E.doAttack(b, e, p, rules, () => 0.5, 'defend').damage, 20);
});

test('防御取消后手先攻，反击允许先攻；期望伤害计入命中和先被击败风险', () => {
    const b = battle(), [p, e] = b.units;
    e.attackOrder = 'last'; e.hp = 5;
    const preview = exchangePreview(b, e, p, rules);
    assert.equal(preview.firstStrike, true);
    assert.equal(preview.expectedDamage, 0);
    assert.equal(preview.expectedCounter, 20);
    const guarded = E.doAttack(b, e, p, rules, () => 0.5, 'defend');
    assert.equal(guarded.firstStrike, null);
    assert.equal(guarded.cancelled, false);
    assert.equal(p.hp, 90);
    const hitRules = { ...rules, hitEnabled: true, baseHit: 40, agiFactor: 0 };
    assert.equal(exchangePreview(b, p, e, hitRules).expectedDamage, 8);
});

test('异步敌方行动在伤害前等待选择，选择后不重掷或重复移动', async () => {
    const b = battle(), [p, e] = b.units;
    let choose, rolls = 0;
    const run = E.aiActInteractive(b, e, { ...rules, variance: 10 }, () => new Promise(resolve => { choose = resolve; }), () => { rolls++; return 0.5; });
    assert.equal(p.hp, 100);
    assert.equal(e.hp, 100);
    assert.equal(rolls, 0);
    choose('defend');
    const events = await run;
    assert.equal(p.hp, 90);
    assert.equal(e.hp, 100);
    assert.equal(events.filter(e => e.type === 'attack').length, 1);
    assert.equal(rolls, 1, '只结算一次伤害浮动');
});

test('普通技能可反击，MAP只能防御；技能未命中也完整记录反击', () => {
    for (const mode of ['normal', 'mapLine']) {
        const b = battle({ skills: [makeSkill({ attackMode: mode, lineLength: 3 })] });
        const [p, e] = b.units;
        const sk = p.skills[0];
        const response = E.defaultReaction(b, p, e, rules, sk);
        const preview = exchangePreview(b, p, e, rules, sk, response);
        const event = E.doSkill(b, p, sk, 1, 0, rules, () => 0.5, { [e.uid]: response });
        assert.equal(event.results[0].damage, preview.damage);
        assert.equal(!!event.results[0].counter, mode === 'normal');
        assert.equal(p.hp, mode === 'normal' ? 80 : 100);
    }
    const b = battle({ skills: [makeSkill()] }), [p, e] = b.units;
    const rolls = [0.9, 0.1, 0.5];
    const ev = E.doSkill(b, p, p.skills[0], 1, 0, { ...rules, hitEnabled: true, baseHit: 50, agiFactor: 0 }, () => rolls.shift(), { [e.uid]: 'counter' });
    assert.equal(ev.results[0].missed, true);
    assert.match(formatEvent(ev), /未命中.*反击造成/);
});
