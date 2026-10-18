import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleProfile, makeMap } from '../src/defaults.js';
import * as E from '../src/engine.js';
import { countReplies, syncWindow, buildSyncPrompt, normalizeSync, buildGrowthPrompt, normalizeGrowth, applyGrowth, revertGrowth, growthLines, growthIds, growthSummary } from '../src/story.js';
import { buildDesignPrompt, parseDesignReply } from '../src/designer.js';

test('同步范围：按 AI 回复数计轮；读取窗口以目标楼层结尾，已同步的楼层只作参考', () => {
    const chat = [{ is_user: false }, { is_user: true }, { is_user: false }, { is_system: true }, { is_user: true }, { is_user: false }];
    assert.equal(countReplies(chat), 3);
    assert.equal(countReplies(chat, 0), 2);
    assert.equal(countReplies(chat, 2, 4), 0);
    assert.deepEqual(syncWindow({ syncedTo: 4, to: 30, depth: 20 }), { start: 11, from: 11, to: 30, skipped: 6 });
    assert.deepEqual(syncWindow({ syncedTo: 25, to: 30, depth: 20 }), { start: 11, from: 26, to: 30, skipped: 0 });
    assert.deepEqual(syncWindow({ to: 5, depth: 20 }), { start: 0, from: 0, to: 5, skipped: 0 });
    assert.equal(syncWindow({ syncedTo: 25, to: 30, depth: 20, from: 15 }).from, 15, '手动指定起点');
});

test('同步提示词：只处理新的剧情；战斗中才附上战场与指令写法；已有战斗时不提出关卡', () => {
    const p = sampleProfile();
    const { system, user } = buildSyncPrompt(p, { before: '#1 旧事', fresh: '#2 艾琳学会了星落', lore: '星界设定', character: '主角设定' });
    assert.match(system, /不参与对话，也不续写剧情/);
    assert.match(system, /"battle": null 或/);
    assert.doesNotMatch(system, /battleChanges/);
    assert.match(user, /## 世界书（世界观设定）\n星界设定/);
    assert.match(user, /## 之前的剧情（已经同步过，只作参考）\n#1 旧事/);
    assert.ok(user.trim().endsWith('## 新的剧情（只处理这一部分）\n#2 艾琳学会了星落'));
    assert.ok(!user.includes('哥布林弓手"'), '默认不包含敌人的完整资料');
    const inBattle = buildSyncPrompt(p, { fresh: '#9 落石', allowBattle: false, battle: '战场状态', commands: '## 战场变化（battleChanges）的写法' });
    assert.match(inBattle.system, /"battleChanges": \["指令", …\]/);
    assert.doesNotMatch(inBattle.system, /"battle": null 或/);
    assert.match(inBattle.user, /## 进行中的战斗（战场状态由战斗系统计算）\n战场状态/);
});

test('解析同步回复：空的成长与“无”视为没有变化，指令可以是字符串或对象', () => {
    assert.deepEqual(normalizeSync({ summary: '无', growth: { updates: [], newUnits: [] }, battle: null, battleChanges: [] }),
        { summary: '', growth: null, battle: null, commands: [] });
    const r = normalizeSync({ summary: '神殿开战', growth: { updates: [{ unit: '法师' }] }, battle: { place: '废弃神殿', summary: '暗影教团伏击' }, battleChanges: ['damage E1 3 落石', { command: 'heal P1 2' }, ''] });
    assert.equal(r.summary, '神殿开战');
    assert.equal(r.growth.updates.length, 1);
    assert.deepEqual(r.battle, { subject: '废弃神殿', text: '暗影教团伏击' });
    assert.deepEqual(r.commands, ['damage E1 3 落石', 'heal P1 2']);
    assert.equal(normalizeSync({ updates: [{ unit: '法师' }] }).growth.updates.length, 1, '直接写成长格式也能识别');
    assert.equal(normalizeSync(null).growth, null);
});

const reply = JSON.stringify({
    updates: [
        { unit: '法师', reason: '在图书馆学会星落', changes: { matk: 15, mdef: 9, flying: false, antiAir: true },
            addSkills: [{ name: '星落', kind: 'magical', power: 140, rangeMin: 2, rangeMax: 4, attackMode: 'mapArea', radius: 1, cooldown: 3, antiAir: true, desc: '召唤流星' },
                { name: '治愈', kind: 'support', target: 'ally', rangeMax: 3, effects: [{ type: 'heal', value: 150 }] }],
            removeSkills: ['守护之光', '不存在的技能'], addTraits: [{ name: '星辰眷顾', effects: [{ type: 'matk_up', value: 10 }] }] },
        { unit: '罗兰', changes: { atk: 14, weaponName: '圣剑' }, editSkills: [{ name: '冲锋', power: 180 }] },
        { unit: '哥布林', changes: { atk: 9 } },
        { unit: '不存在的人', changes: { atk: 99 } },
    ],
    newUnits: [{ name: '莉娜', side: 'ally', hp: 24, atk: 9, agi: 10, skills: [{ name: '连射', power: 80, rangeMax: 3, antiAir: true }] }],
});

function profileWithAlias() {
    const p = sampleProfile();
    p.units.find(u => u.name === '骑士').aliases = '罗兰';
    return p;
}

test('成长：数值、技能（新增 / 同名升级 / 修改 / 移除）、特质、别名查找、无变化与未知单位的处理', () => {
    const p = profileWithAlias();
    const g = normalizeGrowth(parseDesignReply(reply), p);
    assert.equal(growthSummary(g), '2 个单位成长 · 1 个新单位');
    const [mage, knight] = g.updates;
    assert.deepEqual(mage.patch, { matk: 15, antiAir: true }, 'MDEF 与飞行没有变化，不写入');
    assert.equal(mage.addSkills.length, 1, '「治愈」已存在，视为升级');
    assert.equal(mage.editSkills[0].after.name, '治愈');
    assert.equal(mage.editSkills[0].after.effects[0].value, 150);
    assert.equal(mage.editSkills[0].id, 'sk_sample_heal', '升级保留原技能 id');
    assert.deepEqual(mage.removeSkills.map(s => s.name), ['守护之光']);
    assert.equal(knight.unitName, '骑士', '用别名找到单位');
    assert.equal(knight.editSkills[0].after.power, 180);
    assert.equal(knight.editSkills[0].after.sureHit, true, '只修改给出的字段');
    assert.ok(g.warnings.some(w => w.includes('不存在的技能')));
    assert.ok(g.warnings.some(w => w.includes('不存在的人')));
    assert.ok(g.warnings.some(w => w.includes('哥布林') && w.includes('相同')), '数值没变的修改被忽略');
    const lines = growthLines(mage, p.units.find(u => u.name === '法师'), p.unitTypes);
    assert.ok(lines.includes('MATK 13 → 15'));
    assert.ok(lines.some(l => l.startsWith('学会技能【星落】') && l.includes('可对空')));
    assert.ok(lines.includes('失去技能【守护之光】'));
    assert.equal(g.design.units[0].name, '莉娜');
});

test('应用成长：更新资料卡和进行中战斗里的同一单位，撤销后资料卡恢复', () => {
    const p = profileWithAlias();
    const b = E.createBattle(makeMap({ w: 6, h: 4, placements: [{ unitId: 'unit_sample_mage', x: 0, y: 0 }, { unitId: 'unit_sample_knight', x: 1, y: 0 }] }), p.units, p.terrains);
    const bm = b.units[0];
    bm.hp = 10;
    const g = normalizeGrowth(parseDesignReply(JSON.stringify({ updates: [{ unit: '法师', changes: { hp: 30, matk: 15 }, addSkills: [{ name: '星落', kind: 'magical', power: 140, uses: 2 }] }] })), p);
    const before = structuredClone(p.units.find(u => u.name === '法师'));
    const res = applyGrowth(p, g, new Set(growthIds(g)), b);
    const mage = p.units.find(u => u.name === '法师');
    assert.equal(mage.hp, 30); assert.equal(mage.matk, 15);
    assert.ok(mage.skills.some(s => s.name === '星落'));
    assert.equal(res.synced, 1);
    assert.equal(bm.maxHp, 30); assert.equal(bm.hp, 18, '最大 HP 提高 8，当前 HP 也恢复 8');
    assert.equal(bm.matk, 15);
    const star = bm.skills.find(s => s.name === '星落');
    assert.deepEqual([star.usesLeft, star.cdLeft], [2, 0]);
    assert.ok(res.lines.some(l => l.startsWith('法师：MATK 13 → 15')));
    assert.equal(revertGrowth(p, res.before), 1);
    assert.deepEqual(p.units.find(u => u.name === '法师'), before);
});

test('只应用选中的项；新同伴加入资料卡', () => {
    const p = profileWithAlias();
    const g = normalizeGrowth(parseDesignReply(reply), p);
    const n = p.units.length;
    const res = applyGrowth(p, g, new Set([g.design.units[0].id]));
    assert.equal(p.units.length, n + 1);
    assert.equal(p.units.find(u => u.name === '法师').matk, 13, '未选中的成长不应用');
    assert.ok(res.lines.includes('莉娜加入了友军'));
});

test('成长提示词包含剧情、事件、可修改单位的完整资料；默认不含敌人。剧情关卡任务带上聊天记录', () => {
    const p = sampleProfile();
    const { system, user } = buildGrowthPrompt(p, { hint: '法师学会了星落', chat: '法师：我感受到了星辰的力量。' });
    assert.match(system, /成长要克制/);
    assert.match(system, /"editSkills"/);
    assert.match(user, /星辰的力量/);
    assert.match(user, /法师学会了星落/);
    assert.match(user, /"name":"法师".*"skills":\[/);
    assert.doesNotMatch(user, /"name":"哥布林"/);
    assert.match(buildGrowthPrompt(p, { scope: 'all' }).user, /"name":"哥布林"/);
    const story = buildDesignPrompt(p, { task: 'story', request: '废弃神殿：暗影教团伏击', chat: '骑士：小心，有埋伏！' });
    assert.match(story.user, /最近的剧情[\s\S]*小心，有埋伏/);
    assert.match(story.user, /根据「最近的剧情」设计/);
});
