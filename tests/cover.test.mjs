import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeUnit, makeSkill, makeMap, DEFAULT_TERRAINS, defaultRules } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { formatEvent } from '../src/narrator.js';

const rules = { ...defaultRules(), variance: 0, hitEnabled: false };
const fixed = () => 0.5;
function battle(defs, positions, w = 10, h = 5) {
    return E.createBattle(makeMap({ w, h, placements: positions.map(([x, y], i) => ({ unitId: defs[i].id, x, y })) }), defs, DEFAULT_TERRAINS);
}
const guard = makeSkill({ id: 'g', name: '援护', kind: 'support', target: 'ally', rangeMin: 1, rangeMax: 3, effects: [{ type: 'cover', turns: 1 }] });
const aegis = makeSkill({ id: 'a', name: '守护领域', kind: 'support', target: 'self', effects: [{ type: 'cover_area', value: 2, turns: 1 }] });
const tank = (over = {}) => makeUnit({ id: 'tank', name: '格雷', hp: 100, def: 10, skills: [guard, aegis], ...over });
const mage = (over = {}) => makeUnit({ id: 'mage', name: '米娅', hp: 20, def: 0, ...over });
const orc = (over = {}) => makeUnit({ id: 'orc', name: '兽人', side: 'enemy', hp: 60, atk: 15, ai: 'stationary', ...over });

test('单体援护：替队友挡下下一次攻击，不反击，用完即消失', () => {
    const b = battle([tank(), mage(), orc()], [[0, 2], [2, 2], [3, 2]]);
    const [t, m, o] = b.units;
    const ev = E.doSkill(b, t, t.skills[0], 2, 2, rules, fixed);
    assert.match(formatEvent(ev), /受格雷援护/);
    assert.ok(E.hasStatus(m, 'cover'));
    const cover = E.coverFor(b, o, m);
    assert.equal(cover.unit, t);

    const hit = E.doAttack(b, o, m, rules, fixed, E.defaultReaction(b, o, t, rules, null, true));
    assert.equal(hit.target.uid, t.uid);
    assert.equal(hit.coveredFor.uid, m.uid);
    assert.equal(m.hp, 20, '队友没有受伤');
    assert.ok(t.hp < 100);
    assert.equal(hit.reaction, 'defend', '援护者默认防御');
    assert.equal(hit.counter, null, '援护者不反击');
    assert.equal(o.hp, 60);
    assert.match(formatEvent(hit), /兽人 对 米娅 发动物理普通攻击，格雷 挺身援护，替其承受了 \d+ 点伤害/);
    assert.ok(!E.hasStatus(m, 'cover'), '援护一次后消失');

    o.acted = false;
    E.doAttack(b, o, m, rules, fixed, 'none');
    assert.ok(m.hp < 20, '第二次攻击直接命中队友');
});

test('范围援护：范围内的友军受到单体攻击都由施法者承受，范围外、MAP攻击和攻击施法者本人不受影响', () => {
    const blast = makeSkill({ id: 'blast', name: '冲击波', attackMode: 'mapArea', radius: 1, rangeMin: 1, rangeMax: 4, power: 100, mapTargets: 'enemy' });
    const shot = makeSkill({ id: 'shot', name: '射击', rangeMin: 1, rangeMax: 5, power: 100 });
    const b = battle([tank(), mage(), mage({ id: 'far', name: '远方村民' }), orc({ skills: [blast, shot], rangeMin: 1, rangeMax: 6 })], [[2, 2], [3, 2], [6, 2], [4, 2]]);
    const [t, m, far, o] = b.units;
    E.doSkill(b, t, t.skills[1], t.x, t.y, rules, fixed);
    assert.ok(E.hasStatus(t, 'cover_area'));

    for (let i = 0; i < 2; i++) {
        o.acted = false;
        E.doAttack(b, o, m, rules, fixed);
    }
    assert.equal(m.hp, 20, '多次攻击都由施法者承受');

    const skillHit = E.doSkill(b, o, o.skills[1], m.x, m.y, rules, fixed, { [t.uid]: 'defend' });
    assert.equal(skillHit.results[0].target.uid, t.uid, '单体伤害技能同样被援护');
    assert.match(formatEvent(skillHit), /格雷 挺身援护米娅/);
    assert.equal(m.hp, 20);

    o.acted = false;
    E.doAttack(b, o, far, rules, fixed, 'none');
    assert.ok(far.hp < 20, '范围外不受援护');

    const tankHp = t.hp;
    o.skills[0].cdLeft = 0; o.acted = false;
    const map = E.doSkill(b, o, o.skills[0], 3, 2, rules, fixed, {});
    assert.ok(map.results.some(r => r.target.uid === m.uid), 'MAP攻击不会被援护');
    assert.ok(m.hp < 20);
    assert.ok(t.hp < tankHp, '施法者也在范围内照常受伤');
});

test('眩晕或倒下的援护者无法援护；敌方 AI 攻击被援护者时，由援护者选择反应且不能反击', async () => {
    const b = battle([tank(), mage(), orc({ ai: 'aggressive' })], [[0, 2], [3, 2], [4, 2]]);
    const [t, m, o] = b.units;
    E.doSkill(b, t, t.skills[0], 3, 2, rules, fixed);
    t.statuses.push({ type: 'stun', turns: 1, srcSide: 'enemy' });
    assert.equal(E.coverFor(b, o, m), null);
    t.statuses = t.statuses.filter(s => s.type !== 'stun');

    const requests = [];
    const ev = await E.aiActInteractive(b, o, rules, async req => { requests.push(req); return 'defend'; }, fixed);
    assert.equal(requests[0].target.uid, t.uid);
    assert.equal(requests[0].cover.uid, m.uid);
    assert.equal(E.canRespond(b, o, t, rules, null, true), false);
    assert.equal(ev.find(e => e.type === 'attack').coveredFor.uid, m.uid);
    assert.equal(m.hp, 20);
    assert.equal(E.toughLeft(t), 1, '援护者防御消耗韧性');
});

test('AI 会在同伴受威胁时使用范围援护', () => {
    const shield = makeSkill({ id: 'a', name: '守护领域', kind: 'support', target: 'self', effects: [{ type: 'cover_area', value: 2, turns: 1 }] });
    const b = battle([makeUnit({ id: 'h', name: '勇者', hp: 50, atk: 10, mov: 4 }), orc({ id: 'tank', name: '盾兵', hp: 100, skills: [shield], ai: 'defensive', atk: 1 }), orc({ id: 'shaman', name: '萨满', hp: 15, ai: 'defensive' })],
        [[4, 2], [7, 2], [8, 2]]);
    const opts = E.aiOptions(b, b.units[1], rules, 30);
    assert.ok(opts.some(p => p.kind === 'skill' && p.skill.id === 'a' && p.score > 0));
});
