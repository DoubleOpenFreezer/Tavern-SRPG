import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules, defaultSettings } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent, skillSummary } from '../src/narrator.js';
import { describePlan } from '../src/commander.js';
import { buildBattleContext } from '../src/context.js';
import { actionFrames, playBattleEvents } from '../src/ui/action-process.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false, counter: true };
const fixed = () => 0.5;
function battle(defs, positions, w = 7, h = 5) {
    return E.createBattle(makeMap({ w, h, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS);
}
const hero = (over = {}) => makeUnit({ id: 'h', name: '勇者', hp: 100, atk: 20, mov: 0, skills: [], ...over });
const foe = (over = {}) => makeUnit({ id: 'f', name: '敌人', side: 'enemy', hp: 100, atk: 15, ai: 'stationary', ...over });

test('MAP直线穿过多个目标和地形，长度3且不伤自己、不触发反击', () => {
    const sk = makeSkill({ attackMode: 'mapLine', lineLength: 3, cooldown: 2, uses: 2 });
    const b = battle([hero({ skills: [sk] }), foe(), foe({ id: 'f2' }), hero({ id: 'a' }), foe({ id: 'off' })], [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]]);
    const [h, f1, f2, ally, off] = b.units;
    b.tiles[2 * b.w + 2] = 'wall';
    const skill = h.skills[0];
    assert.deepEqual(E.skillAreaTiles(b, h, skill, 3, 2), [[1, 2], [2, 2], [3, 2]]);
    assert.deepEqual(E.skillAffected(b, h, skill, 1, 2).map(u => u.uid), [f1.uid, f2.uid, ally.uid]);
    assert.ok(!E.skillTargetTiles(b, h, skill).some(([x, y]) => x === 1 && y === 3), '不允许斜向');
    const ev = E.doSkill(b, h, skill, 3, 2, rules, fixed);
    assert.equal(ev.results.length, 3);
    assert.ok([f1, f2, ally].every(u => u.hp < u.maxHp));
    assert.equal(off.hp, off.maxHp);
    assert.equal(h.hp, h.maxHp);
    assert.equal(ev.counter, undefined);
    assert.equal(skill.usesLeft, 1);
    assert.equal(skill.cdLeft, 2);
    assert.match(formatEvent(ev), /MAP直线/);
    assert.match(skillSummary(skill), /直线3格.*不反击/);
});

test('MAP地块范围按菱形半径覆盖，允许选空地，支持仅敌方和地图边界', () => {
    const sk = makeSkill({ attackMode: 'mapArea', radius: 1, rangeMin: 0, rangeMax: 5, mapTargets: 'enemy' });
    const b = battle([hero({ skills: [sk] }), foe(), foe({ id: 'f2' }), foe({ id: 'diag' }), hero({ id: 'a' })], [[0, 0], [3, 2], [4, 1], [4, 2], [3, 0]]);
    const h = b.units[0], skill = h.skills[0];
    assert.deepEqual(new Set(E.skillAffected(b, h, skill, 3, 1).map(u => u.uid)), new Set([b.units[1].uid, b.units[2].uid]));
    assert.equal(E.skillAreaTiles(b, h, skill, 0, 0).length, 3);
    const ev = E.doSkill(b, h, skill, 3, 1, rules, fixed);
    assert.equal(ev.results.length, 2);
    assert.equal(b.units[3].hp, 100, '对角线超出半径1');
    assert.equal(b.units[4].hp, 100, '友军不受影响');
    assert.equal(h.hp, 100);
    const nearSelf = E.skillAffected(b, { ...h }, { ...skill, mapTargets: 'all', radius: 10 }, 0, 0);
    assert.ok(!nearSelf.some(t => t.uid === h.uid), 'AI预览克隆单位也不伤自己');
    assert.throws(() => E.doSkill(b, h, skill, 6, 4, rules), /范围/);
});

test('MAP攻击空区域仍消耗技能，关闭鲁莽的AI会避免净损失的友军误伤', () => {
    const sk = makeSkill({ attackMode: 'mapLine', lineLength: 3, uses: 1 });
    const b = battle([hero({ skills: [sk] }), foe()], [[0, 0], [4, 4]]);
    const ev = E.doSkill(b, b.units[0], b.units[0].skills[0], 1, 0, rules, fixed);
    assert.equal(ev.results.length, 0);
    assert.equal(b.units[0].skills[0].usesLeft, 0);
    const ai = battle([foe({ skills: [sk], mapReckless: false }), foe({ id: 'a' }), hero()], [[0, 0], [1, 0], [2, 0]]);
    assert.equal(ai.units[0].mapReckless, false);
    assert.ok(!E.aiOptions(ai, ai.units[0], rules, 30).some(p => p.kind === 'skill'));
    ai.units[0].skills[0].mapTargets = 'enemy';
    assert.ok(E.aiOptions(ai, ai.units[0], rules, 30).some(p => p.kind === 'skill'));
});

test('鲁莽使用MAP攻击（默认）：被挑衅时也会穿过整排友军轰击目标，不会只打友军', () => {
    const sk = makeSkill({ attackMode: 'mapLine', lineLength: 20, sureHit: true });
    const goblins = [1, 2, 3, 4].map(i => foe({ id: `g${i}`, hp: 10 }));
    const b = battle([hero(), ...goblins, foe({ id: 'fort', skills: [sk] })], [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [6, 2]]);
    const fort = b.units.at(-1);
    assert.equal(fort.mapReckless, true, '未设置时默认鲁莽');
    b.units[0].statuses.push({ type: 'taunt', value: 0, turns: 1, srcSide: 'player' });
    const plan = E.aiOptions(b, fort, rules)[0];
    assert.equal(plan.kind, 'skill');
    assert.match(describePlan(b, fort, plan, rules), /误伤友军/);
    const ev = E.aiAct(b, fort, rules, fixed);
    const blast = ev.find(e => e.type === 'skill');
    assert.ok(blast, '发射MAP攻击');
    assert.equal(blast.results.length, 5);
    assert.ok(b.units.slice(1, 5).every(g => g.hp === 0), '整排友军被清除');
    assert.ok(b.units[0].hp < 100);

    // 线上只有友军、没有敌人时不会发射
    const only = battle([hero(), foe({ id: 'g' }), foe({ id: 'fort', skills: [sk] })], [[0, 0], [1, 2], [3, 2]]);
    assert.ok(!E.aiOptions(only, only.units[2], rules, 30).some(p => p.kind === 'skill' && p.targets.every(t => !E.isFoe(t, only.units[2]))));
});

test('后手主动攻击时目标先攻，双方后手或无法回击时主动方先攻', () => {
    for (const targetSlow of [false, true]) {
        const b = battle([hero({ attackOrder: 'last', weaponName: '大剑' }), foe({ attackOrder: targetSlow ? 'last' : 'normal' })], [[0, 0], [1, 0]]);
        const [h, f] = b.units;
        assert.equal(E.previewAttack(b, h, f, rules).firstStrike, !targetSlow);
        const ev = E.doAttack(b, h, f, rules, fixed);
        assert.equal(!!ev.firstStrike, !targetSlow);
        assert.equal(!!ev.counter, targetSlow);
        assert.ok(h.hp < 100 && f.hp < 100);
        if (!targetSlow) assert.match(formatEvent(ev), /敌人先攻/);
        assert.match(buildBattleContext(b), /大剑.*后手/);
    }
    const b = battle([hero({ attackOrder: 'last', rangeMax: 3 }), foe({ rangeMax: 1 })], [[0, 0], [3, 0]]);
    assert.equal(E.doAttack(b, ...b.units, rules, fixed).firstStrike, null);
    const stunned = battle([hero({ attackOrder: 'last' }), foe()], [[0, 0], [1, 0]]);
    stunned.units[1].statuses = [{ type: 'stun', turns: 1, srcSide: 'player' }];
    assert.equal(E.doAttack(stunned, ...stunned.units, rules, fixed).firstStrike, null);
});

test('后手先被击败则攻击取消；关闭普通反击仍遵守后手先攻', () => {
    const b = battle([hero({ hp: 1, def: 0, attackOrder: 'last' }), foe()], [[0, 0], [1, 0]]);
    const before = structuredClone(b);
    const ev = E.doAttack(b, ...b.units, { ...rules, counter: false }, fixed);
    assert.equal(ev.cancelled, true);
    assert.equal(b.units[0].hp, 0);
    assert.equal(b.units[1].hp, 100);
    assert.match(formatEvent(ev), /未能发动攻击/);
    const frames = [...actionFrames(before, b, [ev])];
    assert.ok(frames.every(f => f.label === '敌人 先攻'));
    assert.equal(frames.at(-1).battle.units[0].hp, 0);
    assert.equal(frames.at(-1).battle.units[1].hp, 100);
});

test('MAP不受后手顺序影响；后手先攻未命中后仍可正常攻击', () => {
    const sk = makeSkill({ attackMode: 'mapLine', lineLength: 3 });
    const b = battle([hero({ attackOrder: 'last', skills: [sk] }), foe()], [[0, 0], [1, 0]]);
    E.doSkill(b, b.units[0], b.units[0].skills[0], 1, 0, rules, fixed);
    assert.equal(b.units[0].hp, 100);
    const missed = battle([hero({ attackOrder: 'last' }), foe()], [[0, 0], [1, 0]]);
    const rolls = [0.9, 0.1, 0.5];
    const ev = E.doAttack(missed, ...missed.units, { ...rules, hitEnabled: true, baseHit: 50, agiFactor: 0 }, () => rolls.shift());
    assert.equal(ev.firstStrike.hit, false);
    assert.equal(ev.hit, true);
    assert.equal(ev.cancelled, false);
});

test('逐格移动回放保留穿过友军的路径；回放不改写原始战斗', () => {
    const b = battle([hero({ mov: 4 }), hero({ id: 'a' }), foe()], [[0, 0], [1, 0], [5, 0]], 7, 1);
    const before = structuredClone(b);
    const ev = E.doMove(b, b.units[0], 2, 0);
    assert.deepEqual(ev.path, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
    const after = structuredClone(b);
    const frames = [...actionFrames(before, b, [ev])];
    assert.deepEqual(frames.map(f => f.battle.units[0].x), [1, 2]);
    assert.deepEqual(b, after);
    assert.equal(before.units[0].x, 0);
});

test('后手回放依次显示先攻、主动攻击；MAP所有目标同一帧扣血', () => {
    const b = battle([hero({ attackOrder: 'last' }), foe()], [[0, 0], [1, 0]]);
    const before = structuredClone(b);
    const ev = E.doAttack(b, ...b.units, rules, fixed);
    const frames = [...actionFrames(before, b, [ev])];
    assert.deepEqual(frames.map(f => f.label), ['敌人 先攻', '敌人 先攻', '勇者 攻击 敌人', '勇者 攻击 敌人']);
    assert.equal(frames[1].battle.units[1].hp, 100);
    assert.ok(frames[1].battle.units[0].hp < 100);
    assert.equal(frames.at(-1).battle.units[1].hp, b.units[1].hp);
    const sk = makeSkill({ attackMode: 'mapLine', lineLength: 3, mapTargets: 'enemy' });
    const multi = battle([hero({ skills: [sk] }), foe(), foe({ id: 'f2' })], [[0, 0], [1, 0], [2, 0]]);
    const start = structuredClone(multi);
    const hit = E.doSkill(multi, multi.units[0], multi.units[0].skills[0], 3, 0, rules, fixed);
    const all = [...actionFrames(start, multi, [hit])];
    assert.equal(all.length, 2);
    assert.deepEqual(all[1].battle.units.map(u => u.hp), multi.units.map(u => u.hp));
    assert.equal(all[1].effects.length, 2);
});

test('过程可跳过，聊天切换会取消，不修改当前聊天或最终结算', async t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
    const b = battle([hero({ mov: 3 }), foe()], [[0, 0], [5, 0]], 7, 1);
    const before = structuredClone(b);
    const ev = E.doMove(b, b.units[0], 3, 0);
    let current = b;
    const settings = defaultSettings();
    settings.bindings['char:test.png'] = settings.profiles[0].id;
    globalThis.SillyTavern = { getContext: () => ({ chatId: 'test', characterId: 0, characters: [{ avatar: 'test.png' }], extensionSettings: { tavern_srpg: settings }, chatMetadata: { tavern_srpg: current } }) };
    t.after(() => { if (original) Object.defineProperty(globalThis, 'SillyTavern', original); else delete globalThis.SillyTavern; });
    t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
    const app = { bs: {}, settings: { ui: { animate: true } }, isOpen: true, render() { if (this.bs.playback) this.bs.skipPlayback = true; } };
    await playBattleEvents(app, b, before, [ev]);
    assert.equal(app.bs.playback, null);
    assert.equal(app.bs.busy, null);
    assert.equal(b.units[0].x, 3);
    app.render = () => { if (app.bs.playback) current = { active: true, units: [] }; };
    await playBattleEvents(app, b, before, [ev]);
    assert.deepEqual(current, { active: true, units: [] });
    assert.equal(b.units[0].x, 3);
});
