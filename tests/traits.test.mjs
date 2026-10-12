import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMap, makeUnit, makeTrait, makeSkill, flatDefaults, makeProfile } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { buildBattleContext } from '../src/context.js';
import { profilePayload, profilesFromPayload } from '../src/profiles.js';
import { formatEvent } from '../src/narrator.js';
const settings = flatDefaults();
const rules = { ...settings.rules, variance: 0, hitEnabled: false, counter: false };
function battle(defs, positions) {
    return E.createBattle(makeMap({ w: 10, h: 5, placements: defs.map((u, i) => ({ unitId: u.id, x: positions[i][0], y: positions[i][1] })) }), defs, settings.terrains);
}
const trait = effects => makeTrait({ name: '组合特质', desc: '强壮且会恢复', effects });

test('常驻特质与临时状态叠加，驱散不移除特质，影响伤害和移动', () => {
    const hero = makeUnit({ atk: 100, mov: 3, traits: [trait([{ type: 'atk_up', value: 10 }, { type: 'atk_up', value: 5, flat: true }, { type: 'mov_up', value: 2 }])] });
    const enemy = makeUnit({ side: 'enemy', hp: 999, def: 0 });
    const b = battle([hero, enemy], [[0, 0], [1, 0]]);
    const [h, e] = b.units;
    h.statuses = [{ type: 'atk_down', value: 20, turns: 1, srcSide: 'player' }];
    assert.equal(E.stat(h, 'atk'), 95);
    assert.equal(E.stat(h, 'mov'), 5);
    const sk = makeSkill({ kind: 'support', target: 'self', rangeMin: 0, rangeMax: 0, effects: [{ type: 'cleanse' }] });
    h.skills.push(sk);
    E.doSkill(b, h, sk, 0, 0, rules);
    assert.equal(E.stat(h, 'atk'), 115);
    assert.equal(h.traits.length, 1);
    assert.equal(E.calcDamage(b, h, e, 'physical', 100, rules, Math.random, true), 115);
    assert.ok(E.reachable(b, h).has('0,4'));
    hero.traits[0].effects[0].value = 999;
    assert.equal(E.stat(h, 'atk'), 115, '战斗单位持有独立快照');
});

test('再生每次自己阵营阶段开始触发，组合固定和比例，上限HP，零值无回复，不复活', () => {
    const hero = makeUnit({ hp: 100, traits: [trait([{ type: 'regen', value: 10 }, { type: 'regen_flat', value: 5 }, { type: 'regen_flat', value: 0 }])] });
    const enemy = makeUnit({ side: 'enemy' });
    const b = battle([hero, enemy], [[0, 0], [9, 4]]);
    const h = b.units[0]; h.hp = 70;
    E.beginSidePhase(b, 'enemy');
    assert.equal(h.hp, 70);
    let events = E.beginSidePhase(b, 'player').events;
    assert.equal(h.hp, 85);
    assert.equal(events.filter(e => e.type === 'dot').length, 2);
    assert.match(formatEvent(events.find(e => e.type === 'dot')), /特质：组合特质/);
    E.beginSidePhase(b, 'player'); assert.equal(h.hp, 100);
    events = E.beginSidePhase(b, 'player').events;
    assert.ok(!events.some(e => e.type === 'dot'));
    h.hp = 0; E.beginSidePhase(b, 'player'); assert.equal(h.hp, 0);
    assert.equal(h.traits[0].effects.length, 3);
});

test('范围吸引优先攻击较远的高血量目标，但不强制玩家或禁止其他攻击', () => {
    for (const ai of ['aggressive', 'defensive', 'stationary']) {
        const weak = makeUnit({ hp: 5 });
        const tank = makeUnit({ hp: 200, def: 20, traits: [trait([{ type: 'attract', value: 3 }])] });
        const enemy = makeUnit({ side: 'enemy', atk: 10, rangeMax: 3, mov: 0, ai });
        const b = battle([weak, tank, enemy], [[4, 1], [2, 1], [5, 1]]);
        const [w, t, e] = b.units;
        assert.ok(E.attackTargets(b, e).includes(w), '吸引是优先级而不是强制嘲讽');
        assert.equal(E.aiAct(b, e, rules).find(x => x.type === 'attack').target.uid, t.uid);
        assert.equal(E.aiOptions(b, e, rules)[0].target.uid, t.uid);
    }
});

test('吸引超出范围/撤离/击败时失效；无法够到吸引者时攻击其他目标', () => {
    const weak = makeUnit({ hp: 100 });
    const tank = makeUnit({ hp: 200, traits: [trait([{ type: 'attract', value: 3 }])] });
    const enemy = makeUnit({ side: 'enemy', rangeMax: 1, mov: 0 });
    const b = battle([weak, tank, enemy], [[4, 1], [2, 1], [5, 1]]);
    const [w, t, e] = b.units;
    assert.equal(E.aiAct(b, e, rules).find(x => x.type === 'attack').target.uid, w.uid);
    t.x = 0; assert.equal(E.attractionTargets(b, e).length, 0);
    t.x = 2; t.retreated = true; assert.equal(E.attractionTargets(b, e).length, 0);
    t.retreated = false; t.hp = 0; assert.equal(E.attractionTargets(b, e).length, 0);
});

test('特质在资料卡导入导出及增援中保留，并向LLM提供实际效果与描述，旧单位兼容', () => {
    const d = makeUnit({ traits: [trait([{ type: 'atk_up', value: 10 }, { type: 'regen_flat', value: 5 }])] });
    const [p] = profilesFromPayload(profilePayload(makeProfile({ units: [d] })));
    assert.deepEqual(p.units[0].traits, d.traits);
    const b = battle([d, makeUnit({ side: 'enemy' })], [[0, 0], [9, 4]]);
    assert.match(buildBattleContext(b), /常驻特质【组合特质】：ATK\+10%、自己阵营回合开始恢复5HP；强壮且会恢复/);
    const spawned = E.makeBattleUnit(d, 'new', d.name, 1, 1);
    assert.equal(E.stat(spawned, 'atk'), E.stat(b.units[0], 'atk'));
    delete d.traits;
    assert.deepEqual(E.makeBattleUnit(d, 'old', d.name, 1, 1).traits, []);
});
