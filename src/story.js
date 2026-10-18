// 剧情联动（纯逻辑）：聊天回复里的 <srpg-story> 标记、角色成长的提示词 / 校验 / 差异 / 应用
import { uid } from './defaults.js';
import { normalizeSkill, SIDE_NAMES } from './engine.js';
import { SCHEMA, designRules, existingContent, normalizeDesign, applyDesign, skillFrom, traitFrom, int, str, bool, pick, arr } from './designer.js';
import { skillSummary } from './narrator.js';

export const STORY_TAG = 'srpg-story';
export const STORY_KINDS = { grow: '角色成长', battle: '剧情关卡' };
const BLOCK_RE = new RegExp(`<${STORY_TAG}>([\\s\\S]*?)<\\/${STORY_TAG}>`, 'gi');

// ---------------------------------------------------------------- 聊天中的标记

/** 注入给聊天 LLM 的说明：剧情中发生成长或即将开战时写标记 */
export function storyGuide(profile, { battle = true, inBattle = false } = {}) {
    const party = (profile.units || []).filter(u => u.side !== 'enemy' && u.kind !== 'object').map(u => u.name);
    const lines = [
        '[Tavern-SRPG 剧情联动]',
        '剧情中出现下列情况时，在回复的最后附上一个标记块（不要在正文里提到它，也不要解释）：',
        '- 我方角色学会了新能力或技能、得到或失去装备、实力成长或受到长期削弱、新的同伴加入我方：',
        '  grow <角色名> | <一句话说明发生了什么、新能力是什么样的>',
    ];
    if (battle && !inBattle) lines.push('- 剧情即将进入一场需要在战棋棋盘上进行的战斗（双方已经对峙、即将开打）：', '  battle <地点> | <一句话说明敌人、我方出场的角色与局势>');
    lines.push(
        '格式示例：',
        `<${STORY_TAG}>`,
        'grow 艾琳 | 在古代图书馆学会了「星落」，可以召唤流星攻击一片区域',
        `</${STORY_TAG}>`,
        '没有这些情况时不要写标记；同一件事只标记一次；数值与战斗由战棋系统决定，不要在正文里写数值。',
    );
    if (party.length) lines.push(`当前我方角色：${party.join('、')}。`);
    return lines.join('\n');
}

/**
 * 取出回复中的剧情标记
 * @returns {{clean:string, items:{kind:'grow'|'battle', subject:string, text:string}[]}}
 */
export function extractStory(text) {
    const items = [];
    const clean = String(text || '').replace(BLOCK_RE, (_, body) => {
        for (const line of body.split('\n')) {
            const m = line.trim().match(/^(grow|battle|成长|战斗|关卡)\s+([^|｜]+?)\s*(?:[|｜]\s*(.*))?$/i);
            if (!m) continue;
            const kind = /^(battle|战斗|关卡)$/i.test(m[1]) ? 'battle' : 'grow';
            items.push({ kind, subject: m[2].trim(), text: (m[3] || '').trim() });
        }
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { clean, items };
}

// ---------------------------------------------------------------- 角色成长：提示词

const GROWTH_SCHEMA = `{
  "updates": [{
    "unit": "要修改的已有单位名",
    "reason": "剧情依据（一句话）",
    "changes": { "hp": 36, "atk": 14, "matk": 6, "def": 9, "mdef": 4, "agi": 5, "mov": 5, "tough": 3, "vision": 4, "rangeMin": 1, "rangeMax": 1,
      "atkType": "physical|magical", "attackOrder": "normal|last", "weaponName": "新武器名", "flying": false, "antiAir": false, "type": "兵种名", "aliases": "故事中的称呼" },
    "addSkills": [ 技能，格式同下方 units[].skills ],
    "editSkills": [{ "name": "原技能名", "newName": "改名（可省略）", ...只写需要修改的技能字段 }],
    "removeSkills": ["要移除的技能名"],
    "addTraits": [ 特质，格式同下方 units[].traits ],
    "removeTraits": ["要移除的特质名"]
  }],
  "newUnits": [ 新加入的单位，格式同下方 units ],
  "unitTypes": [ 需要的新兵种（可省略） ]
}`;

const SKILL_FIELDS = ['name', 'kind', 'target', 'power', 'rangeMin', 'rangeMax', 'radius', 'attackMode', 'lineLength', 'mapTargets', 'cooldown', 'uses', 'hitMod', 'sureHit', 'quick', 'antiAir', 'desc'];

/** 比较技能是否真的有变化（旧技能可能缺少新版字段） */
function skillKey(sk) {
    return JSON.stringify([...SKILL_FIELDS.map(k => sk[k] == null || sk[k] === false || sk[k] === '' ? null : sk[k]),
        (sk.effects || []).map(e => [e.type, Number(e.value) || 0, Number(e.turns) || 0])]);
}

/** 给 AI 看的单位完整资料（用于精确修改） */
function unitSheet(u, types) {
    const type = types.find(t => t.id === u.typeId)?.name || '';
    return JSON.stringify({
        name: u.name, side: u.side, type: type || undefined, aliases: u.aliases || undefined,
        hp: u.hp, atk: u.atk, matk: u.matk, def: u.def, mdef: u.mdef, agi: u.agi, mov: u.mov, tough: u.tough, vision: u.vision,
        rangeMin: u.rangeMin, rangeMax: u.rangeMax, atkType: u.atkType, attackOrder: u.attackOrder, weaponName: u.weaponName || undefined,
        flying: u.flying || undefined, antiAir: u.antiAir || undefined,
        traits: (u.traits || []).map(t => ({ name: t.name, desc: t.desc, effects: t.effects })),
        skills: (u.skills || []).map(s => ({ name: s.name, kind: s.kind, target: s.kind === 'support' ? s.target : undefined, power: s.kind === 'support' ? undefined : s.power,
            rangeMin: s.rangeMin, rangeMax: s.rangeMax, radius: s.radius || undefined, attackMode: s.attackMode !== 'normal' ? s.attackMode : undefined,
            cooldown: s.cooldown || undefined, uses: s.uses || undefined, effects: s.effects?.length ? s.effects : undefined, desc: s.desc || undefined })),
    });
}

/**
 * @param {object} profile
 * @param {object} o
 * @param {string} o.hint 剧情标记或用户写的说明，例如「艾琳学会了星落」
 * @param {'party'|'all'} [o.scope] 可以修改哪些单位
 */
export function buildGrowthPrompt(profile, { hint = '', scope = 'party', chat = '', lore = '', character = '', previous = '', feedback = '' } = {}) {
    const types = profile.unitTypes || [];
    const candidates = (profile.units || []).filter(u => u.kind !== 'object' && (scope === 'all' || u.side !== 'enemy'));
    const system = [
        '你是 SRPG（战棋）的成长设计师。根据剧情的发展，更新资料卡中角色的属性、技能和特质，或者加入新的同伴。',
        '只修改剧情明确支持的部分：学会新能力就加技能，装备了新武器就改武器和相应属性，修行成长就小幅提高属性；没有发生变化的角色不要输出。',
        '成长要克制：一次剧情事件一般只让属性提高 1–3 点，新技能的强度与角色现有技能相当；能力要符合世界观设定（世界书与角色设定）。',
        '新同伴加入时放在 newUnits 里（side 为 player 或 ally），数值参考同等级的已有我方单位。',
        '只输出一个 JSON 对象，不要输出任何解释；可以放在 ```json 代码块中。',
        '',
        '## 输出格式',
        GROWTH_SCHEMA,
        'changes 中写修改后的新数值（不是增量），只写有变化的字段。',
        '',
        '## 单位、技能、特质的字段格式',
        SCHEMA,
        '',
        '## 规则说明',
        ...designRules(profile.rules || {}),
    ].join('\n');
    const ctx = [];
    if (character) ctx.push('## 角色卡设定', character, '');
    if (lore) ctx.push('## 世界书（世界观设定）', lore, '');
    if (chat) ctx.push('## 最近的剧情（聊天记录，越靠后越新）', chat, '');
    ctx.push(...existingContent(profile), '');
    ctx.push('## 可以修改的单位（当前完整资料）', ...candidates.map(u => unitSheet(u, types)), '');
    ctx.push('## 本次要处理的剧情事件', hint.trim() || '根据最近的剧情，找出我方角色发生的成长或变化。');
    if (previous) ctx.push('', '## 上一版修改', previous, '', '## 修改意见', feedback.trim() || '请改进上一版。', '请输出修改后的完整 JSON。');
    return { system, user: ctx.join('\n') };
}

// ---------------------------------------------------------------- 角色成长：校验与差异

const NUMBERS = { hp: ['HP', 1, 9999], atk: ['ATK', 0, 999], matk: ['MATK', 0, 999], def: ['DEF', 0, 999], mdef: ['MDEF', 0, 999], agi: ['AGI', 0, 999], mov: ['MOV', 0, 20],
    tough: ['韧性', 0, 10], vision: ['视野', 0, 20], rangeMin: ['最小射程', 1, 20], rangeMax: ['最大射程', 1, 20] };
const FIELD_LABELS = { atkType: '攻击类型', attackOrder: '攻击顺序', weaponName: '武器', flying: '飞行', antiAir: '普通攻击对空', typeId: '兵种', aliases: '别名' };

function findUnit(profile, name) {
    const n = str(name);
    const units = profile.units || [];
    return units.find(u => u.name === n) || units.find(u => u.name.toLowerCase() === n.toLowerCase())
        || units.find(u => String(u.aliases || '').split(/[,，、]/).map(x => x.trim()).includes(n)) || null;
}

/**
 * 把模型给出的成长转换成可预览、可应用的修改
 * @returns {{updates:object[], design:{unitTypes:object[], terrains:[], units:object[], maps:[], warnings:string[]}, warnings:string[]}}
 */
export function normalizeGrowth(raw, profile, { entries = [] } = {}) {
    const warnings = [];
    const design = normalizeDesign({ units: raw.newUnits || raw.units, unitTypes: raw.unitTypes }, profile, { entries });
    warnings.push(...design.warnings);
    const types = [...(profile.unitTypes || []), ...design.unitTypes];
    const updates = [];
    for (const r of arr(raw.updates)) {
        const u = findUnit(profile, r?.unit ?? r?.name);
        if (!u) { warnings.push(`成长对象「${str(r?.unit ?? r?.name)}」不在资料卡中，已忽略（新同伴请放在 newUnits）`); continue; }
        if (u.kind === 'object') { warnings.push(`「${u.name}」是建筑，不能成长`); continue; }
        const c = r.changes || r.stats || {};
        const patch = {};
        for (const [k, [, min, max]] of Object.entries(NUMBERS)) if (k in c) {
            const v = int(c[k], u[k], min, max);
            if (v !== u[k]) patch[k] = v;
        }
        const rmin = patch.rangeMin ?? u.rangeMin, rmax = patch.rangeMax ?? u.rangeMax;
        if (rmax < rmin) patch.rangeMax = rmin;
        if ('atkType' in c && pick(c.atkType, ['physical', 'magical'], u.atkType) !== u.atkType) patch.atkType = c.atkType;
        if ('attackOrder' in c && pick(c.attackOrder, ['normal', 'last'], u.attackOrder) !== u.attackOrder) patch.attackOrder = c.attackOrder;
        if ('weaponName' in c && str(c.weaponName) !== (u.weaponName || '')) patch.weaponName = str(c.weaponName);
        if ('aliases' in c && str(c.aliases) !== (u.aliases || '')) patch.aliases = str(c.aliases);
        for (const k of ['flying', 'antiAir']) if (k in c && bool(c[k]) !== !!u[k]) patch[k] = bool(c[k]);
        if ('type' in c) {
            const t = str(c.type) ? types.find(x => x.name === str(c.type)) : null;
            if (str(c.type) && !t) warnings.push(`「${u.name}」的新兵种「${str(c.type)}」不存在，已忽略`);
            else if ((t?.id || '') !== (u.typeId || '')) patch.typeId = t?.id || '';
        }

        const removeSkills = arr(r.removeSkills).map(n => u.skills.find(s => s.name === str(n?.name ?? n)) || (warnings.push(`「${u.name}」没有技能「${str(n?.name ?? n)}」，无法移除`), null)).filter(Boolean);
        const editSkills = [];
        const edit = (old, fields) => {
            const merged = skillFrom({ ...structuredClone(old), ...fields, name: str(fields.newName) || old.name }, u, warnings);
            if (!merged) return;
            merged.id = old.id;
            if (skillKey(merged) !== skillKey(normalizeSkill(structuredClone(old)))) editSkills.push({ id: old.id, before: old, after: merged });
        };
        for (const e of arr(r.editSkills)) {
            const old = u.skills.find(s => s.name === str(e?.name));
            if (!old) { warnings.push(`「${u.name}」没有技能「${str(e?.name)}」，无法修改`); continue; }
            edit(old, e);
        }
        const addSkills = [];
        for (const sk of arr(r.addSkills)) {
            const same = u.skills.find(s => s.name === str(sk?.name));
            if (same) { edit(same, sk); continue; } // 同名技能视为升级
            const made = skillFrom(sk, u, warnings);
            if (made) addSkills.push(made);
        }
        const removeTraits = arr(r.removeTraits).map(n => (u.traits || []).find(t => t.name === str(n?.name ?? n)) || (warnings.push(`「${u.name}」没有特质「${str(n?.name ?? n)}」，无法移除`), null)).filter(Boolean);
        const addTraits = arr(r.addTraits).map(t => traitFrom(t, u, warnings)).filter(t => t.effects.length || t.desc);

        const update = { id: uid('grow'), unitId: u.id, unitName: u.name, reason: str(r.reason), patch, addSkills, editSkills,
            removeSkills: removeSkills.map(s => ({ id: s.id, name: s.name })), addTraits, removeTraits: removeTraits.map(t => ({ id: t.id, name: t.name })) };
        if (!growthLines(update, u, types).length) { warnings.push(`「${u.name}」的修改与现有资料相同，已忽略`); continue; }
        updates.push(update);
    }
    return { updates, design, warnings };
}

/** 一条成长的可读说明（用于预览、提示和记录） */
export function growthLines(update, unit, types = []) {
    const lines = [];
    const typeName = id => types.find(t => t.id === id)?.name || '无兵种';
    for (const [k, v] of Object.entries(update.patch)) {
        if (NUMBERS[k]) lines.push(`${NUMBERS[k][0]} ${unit[k]} → ${v}`);
        else if (k === 'typeId') lines.push(`兵种 ${typeName(unit.typeId)} → ${typeName(v)}`);
        else if (typeof v === 'boolean') lines.push(`${FIELD_LABELS[k]}：${v ? '是' : '否'}`);
        else lines.push(`${FIELD_LABELS[k]}：${unit[k] || '无'} → ${v || '无'}`);
    }
    for (const s of update.addSkills) lines.push(`学会技能【${s.name}】${skillSummary(s)}${s.desc ? `｜${s.desc}` : ''}`);
    for (const e of update.editSkills) lines.push(`技能【${e.before.name}】${e.after.name !== e.before.name ? `→【${e.after.name}】` : ''}：${skillSummary(e.before)}  ⇒  ${skillSummary(e.after)}`);
    for (const s of update.removeSkills) lines.push(`失去技能【${s.name}】`);
    for (const t of update.addTraits) lines.push(`获得特质【${t.name}】${t.desc ? `：${t.desc}` : ''}`);
    for (const t of update.removeTraits) lines.push(`失去特质【${t.name}】`);
    return lines;
}

// ---------------------------------------------------------------- 角色成长：应用

function patchSkills(list, update, battle = false) {
    const removed = new Set(update.removeSkills.map(s => s.id));
    let out = list.filter(s => !removed.has(s.id));
    for (const e of update.editSkills) {
        out = out.map(s => s.id !== e.id ? s : battle
            // 战斗中升级的技能：保留冷却，剩余次数不超过新的次数上限
            ? { ...structuredClone(e.after), usesLeft: Number(e.after.uses) ? Math.min(s.usesLeft ?? Number(e.after.uses), Number(e.after.uses)) : 0, cdLeft: s.cdLeft || 0 }
            : structuredClone(e.after));
    }
    for (const s of update.addSkills) out.push(battle ? { ...structuredClone(s), usesLeft: Number(s.uses) || 0, cdLeft: 0 } : structuredClone(s));
    return out;
}

function patchTraits(list, update) {
    const removed = new Set(update.removeTraits.map(t => t.id));
    return [...(list || []).filter(t => !removed.has(t.id)), ...update.addTraits.map(t => structuredClone(t))];
}

/**
 * 应用选中的成长与新同伴
 * @param {Set<string>} chosen 成长 id 与新单位 id
 * @param {object|null} battle 进行中的战斗：同步修改场上来自同一单位的棋子
 * @returns {{before: object[], lines: string[], added: number, synced: number, newIds: string[]}} before：修改前的单位，newIds：新加入的单位（用于撤销）
 */
export function applyGrowth(profile, growth, chosen, battle = null) {
    const before = [], lines = [];
    let synced = 0;
    for (const upd of growth.updates.filter(x => chosen.has(x.id))) {
        const u = profile.units.find(x => x.id === upd.unitId);
        if (!u) continue;
        before.push(structuredClone(u));
        lines.push(...growthLines(upd, u, profile.unitTypes || []).map(l => `${u.name}：${l}`));
        Object.assign(u, upd.patch);
        u.skills = patchSkills(u.skills || [], upd);
        u.traits = patchTraits(u.traits, upd);
        for (const bu of battle?.units?.filter(x => x.defId === u.id && !x.object) || []) {
            for (const [k, v] of Object.entries(upd.patch)) {
                if (k === 'hp') { const d = v - bu.maxHp; bu.maxHp = v; if (bu.hp > 0) bu.hp = Math.max(1, Math.min(v, bu.hp + Math.max(0, d))); }
                else if (k === 'tough') { bu.toughMax = v; bu.tough = Math.min(v, bu.tough ?? v); }
                else bu[k] = v;
            }
            bu.skills = patchSkills(bu.skills || [], upd, true);
            bu.traits = patchTraits(bu.traits, upd);
            synced++;
        }
    }
    const newIds = new Set(growth.design.units.filter(x => chosen.has(x.id)).map(x => x.id));
    const { ids } = newIds.size ? applyDesign(profile, growth.design, newIds) : { ids: [] };
    for (const id of ids) {
        const n = growth.design.units.find(x => x.id === id);
        if (n) lines.push(`${n.name}加入了${SIDE_NAMES[n.side]}`);
    }
    return { before, lines, added: newIds.size, synced, newIds: ids };
}

/** 撤销成长：把单位恢复成修改前的资料，移除新加入且没有被地图使用的单位（进行中的战斗不回退） */
export function revertGrowth(profile, before, newIds = []) {
    let n = 0;
    const used = new Set((profile.maps || []).flatMap(m => [...(m.placements || []), ...(m.reinforcements || [])].map(p => p.unitId)));
    profile.units = profile.units.filter(u => !newIds.includes(u.id) || used.has(u.id));
    for (const old of before || []) {
        const i = profile.units.findIndex(u => u.id === old.id);
        if (i >= 0) { profile.units[i] = structuredClone(old); n++; }
    }
    return n;
}

/** 成长结果的条目 id（默认全选） */
export function growthIds(growth) {
    return [...growth.updates.map(x => x.id), ...growth.design.units.map(x => x.id)];
}

export function growthSummary(growth) {
    const bits = [];
    if (growth.updates.length) bits.push(`${growth.updates.length} 个单位成长`);
    if (growth.design.units.length) bits.push(`${growth.design.units.length} 个新单位`);
    return bits.join(' · ') || '没有变化';
}
