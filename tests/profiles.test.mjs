import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, makeProfile, SAMPLE_PROFILE_ID } from '../src/defaults.js';
import { profilePayload, allPayload, profilesFromPayload, addProfiles, profileFor, boundOwners, removeProfile } from '../src/profiles.js';
import { migrateToProfiles, normalizeProfile } from '../src/st.js';

test('旧版设置自动打包成资料卡，并补上示例', () => {
    const old = { version: 3, units: [{ id: 'u1', name: '旧单位', skills: [{ name: '治愈', kind: 'heal', power: 100 }] }], terrains: [{ id: 'plain', name: '平原' }], maps: [], rules: { formula: 'ratio' }, narration: { move: false } };
    migrateToProfiles(old);
    assert.ok(!('units' in old) && !('rules' in old));
    assert.equal(old.profiles.length, 2);
    const mine = old.profiles[0];
    assert.equal(mine.name, '我的资料卡');
    assert.equal(old.activeProfile, mine.id);
    assert.equal(old.defaultProfile, mine.id);
    assert.equal(old.profiles[1].id, SAMPLE_PROFILE_ID);
    normalizeProfile(mine);
    assert.equal(mine.units[0].skills[0].kind, 'support');
    assert.equal(mine.units[0].agi, 5);
    assert.equal(mine.rules.formula, 'ratio');
    assert.equal(mine.rules.baseHit, 90);
    assert.equal(mine.terrains[0].avoid, 0);
    assert.deepEqual(old.narration, { move: false }, '全局设置保留');
});

test('导出 / 导入：单张、全部、旧格式', () => {
    const s = defaultSettings();
    const p = s.profiles[0];
    assert.equal(profilesFromPayload(profilePayload(p))[0].name, p.name);
    assert.equal(profilesFromPayload(allPayload(s)).length, 1);
    const legacy = profilesFromPayload({ format: 'tavern-srpg', version: 1, units: [{ id: 'x' }], maps: [] });
    assert.equal(legacy[0].units[0].id, 'x');
    assert.throws(() => profilesFromPayload({ foo: 1 }), /不是 Tavern-SRPG/);
});

test('同 id 导入：默认作为副本，可选覆盖', () => {
    const s = defaultSettings();
    const p = structuredClone(s.profiles[0]);
    p.name = '改过的';
    const [copy] = addProfiles(s, [p]);
    assert.notEqual(copy.id, SAMPLE_PROFILE_ID);
    assert.equal(copy.name, '改过的（导入）');
    assert.equal(s.profiles.length, 2);
    addProfiles(s, [p], { replace: true });
    assert.equal(s.profiles.length, 2);
    assert.equal(s.profiles[0].name, '改过的');
});

test('显式绑定才启用，一张资料卡可绑定多个角色；删除时清理所有绑定', () => {
    const s = defaultSettings();
    const b = makeProfile({ name: '乙' });
    s.profiles.push(b);
    s.bindings['char:alice.png'] = b.id;
    s.bindings['char:carol.png'] = b.id;
    s.bindings['group:7'] = b.id;
    assert.equal(profileFor(s, 'char:alice.png').name, '乙');
    assert.equal(profileFor(s, 'char:bob.png'), null);
    assert.equal(profileFor(s, 'char:carol.png').id, b.id);
    assert.equal(profileFor(s, null), null);
    assert.deepEqual(boundOwners(s, b.id), ['char:alice.png', 'char:carol.png', 'group:7']);
    s.activeProfile = b.id;
    removeProfile(s, b.id);
    assert.deepEqual(s.bindings, {});
    assert.equal(s.activeProfile, SAMPLE_PROFILE_ID);
    assert.throws(() => removeProfile(s, SAMPLE_PROFILE_ID), /至少保留一张/);
});
