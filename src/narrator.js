// 把战斗事件 / 战场状态翻译成给 LLM 的文本
import { SIDE_NAMES, MISSION_NAMES, missionOf, guardTargets, enemyKeyTargets, nextWaveTurn, effectLabel } from './engine.js';

const pos = p => `(${p.x + 1},${p.y + 1})`;
const KIND = { physical: '物理', magical: '魔法', support: '辅助', heal: '治疗' };

function who(r) {
    // 附带故事中的名字或世界书关键词，让 LLM 对上号，也方便触发世界书条目
    const alias = r.alias || r.wbKey;
    return alias && alias !== r.name ? `${r.name}〈${alias}〉` : r.name;
}

function hpChange(r) {
    return `HP ${r.hpBefore}→${r.hpAfter}`;
}

/** 事件属于哪个描写类别 */
export function eventCategory(e) {
    switch (e.type) {
        case 'move': case 'wait': return 'move';
        case 'attack': return 'attack';
        case 'skill': return 'skill';
        case 'phase': case 'terrainHeal': case 'terrainDamage': case 'mission': return 'turn';
        case 'reinforce': return 'reinforce';
        case 'dot': case 'statusEnd': case 'stunned': return 'status';
        case 'llm': return 'llm';
        case 'result': return 'result';
        default: return 'other';
    }
}

/** 是否按设置需要描写该事件 */
export function shouldNarrate(e, n) {
    if (e.type === 'result' || e.type === 'mission') return true;
    const side = e.actor?.side;
    if (e.type !== 'reinforce' && side === 'enemy' && !n.enemy) return false;
    if (e.type !== 'reinforce' && side === 'ally' && !n.ally) return false;
    if (e.type === 'phase' && e.phase === 'enemy' && !n.enemy) return false;
    if (e.type === 'phase' && e.phase === 'ally' && !n.ally) return false;
    const cat = eventCategory(e);
    return n[cat] !== false;
}

export function formatEvent(e) {
    const text = formatEventBody(e);
    // LLM 指挥官给出的意图
    return e.intent && text ? text.replace(/。?$/, `（意图：${e.intent}）。`) : text;
}

function formatLlm(e) {
    const why = e.reason ? `——${e.reason}` : '';
    const a = e.actor ? who(e.actor) : '';
    switch (e.cmd) {
        case 'damage': return `【剧情】${a} 受到 ${e.amount} 点伤害（${hpChange(e)}）${e.killed ? '，倒下了' : ''}${e.note || ''}${why}`;
        case 'heal': return `【剧情】${a} 恢复了 ${e.amount} 点生命（${hpChange(e)}）${why}`;
        case 'status': return e.removed
            ? `【剧情】${a} 身上的减益被驱散${e.removed.length ? `：${e.removed.map(x => `【${x}】`).join('')}` : ''}${why}`
            : `【剧情】${a} ${e.debuff ? '陷入' : '获得'}【${e.label}】（${e.turns} 回合）${why}`;
        case 'unstatus': return `【剧情】${a} 身上的${e.removed.map(x => `【${x}】`).join('')}被解除${why}`;
        case 'move': return `【剧情】${a} 从 ${pos(e.from)} 移动到 ${pos(e.to)}${e.terrain}${why}`;
        case 'retreat': return `【剧情】${a} 撤离了战场${why}`;
        case 'spawn': return `【剧情】${a} 出现在 ${pos(e.at)}${e.terrain}${why}`;
        case 'terrain': return `【剧情】${pos(e.at)} 的${e.from}变成了${e.to}${why}`;
        case 'end': return `【剧情】战斗结束：${e.result === 'victory' ? '我方胜利' : '我方战败'}${why}`;
        default: return `【剧情】${e.raw || ''}`;
    }
}

function formatEventBody(e) {
    switch (e.type) {
        case 'llm':
            return formatLlm(e);
        case 'move':
            return `${who(e.actor)} 从 ${pos(e.from)}${e.fromTerrain} 移动到 ${pos(e.to)}${e.terrain}。${e.terrainDamage ? formatEvent(e.terrainDamage) : ''}`;
        case 'manual':
            return `【手动修改】${e.text}`;
        case 'terrainDamage':
            return `${who(e.actor)} ${e.timing === 'turn' ? '回合开始时' : '落脚时'}受到${e.terrain}伤害，损失 ${e.damage} 点生命（${hpChange(e)}）${e.killed ? '，被击败' : ''}。`;
        case 'wait':
            return `${who(e.actor)} 在${e.terrain}原地待命。`;
        case 'attack': {
            let lead = '';
            if (e.reaction === 'defend') lead = `${who(e.target)}选择防御，放弃反击并减轻伤害。`;
            if (e.firstStrike) {
                const f = e.firstStrike;
                lead = `${who(e.actor)} 使用后手武器，${who(e.target)}先攻${f.hit === false ? '但未命中' : `造成 ${f.damage} 点伤害（${e.actor.name} ${hpChange(f)}）`}。`;
                if (e.cancelled) return `${lead}${e.actor.name}被击败，未能发动攻击。`;
            }
            // hit 为 false 表示未命中（旧版事件没有该字段，视为命中）
            let s = e.hit === false
                ? `${who(e.actor)} 对 ${who(e.target)} 发动${KIND[e.atkType]}普通攻击，但被 ${e.target.name} 闪避了（未命中）`
                : `${who(e.actor)} 对 ${who(e.target)} 发动${KIND[e.atkType]}普通攻击，造成 ${e.damage} 点伤害（${e.target.name} ${hpChange(e)}）`;
            if (e.killed) s += `，${e.target.name} 被击败`;
            if (e.counter) {
                s += e.counter.hit === false
                    ? `；${e.target.name} 反击，但被 ${e.actor.name} 躲开了（未命中）`
                    : `；${e.target.name} 反击，造成 ${e.counter.damage} 点${KIND[e.counter.atkType]}伤害（${e.actor.name} ${hpChange(e.counter)}）`;
                if (e.counter.killed) s += `，${e.actor.name} 被击败`;
            }
            return lead + s + '。';
        }
        case 'skill': {
            const parts = e.results.map(r => {
                const counter = r.counter ? r.counter.hit === false ? '；反击未命中' : `；反击造成 ${r.counter.damage} 点伤害（${e.actor.name} ${hpChange(r.counter)}）${r.counter.killed ? '，施法者被击败' : ''}` : '';
                if (r.missed) return `${who(r.target)} 闪避了（未命中）${counter}`;
                const bits = [];
                if (r.reaction === 'defend') bits.push('选择防御');
                if (r.damage != null) bits.push(`受到 ${r.damage} 点伤害`);
                if (r.heal != null) bits.push(`恢复 ${r.heal} 点生命`);
                for (const ef of r.effects || []) {
                    if (ef.heal != null) continue;
                    if (ef.type === 'cleanse') bits.push(ef.removed?.length ? `被驱散了${ef.removed.map(x => `【${x}】`).join('')}` : '被净化（没有减益）');
                    else bits.push(`${ef.debuff ? '陷入' : '获得'}【${ef.label}】（${ef.turns} 回合）`);
                }
                const hp = r.hpBefore !== r.hpAfter ? `（${hpChange(r)}）` : '';
                return `${who(r.target)} ${bits.join('，') || '不受影响'}${hp}${r.killed ? '，被击败' : ''}${counter}`;
            });
            const desc = e.skill.desc ? `（${e.skill.desc}）` : '';
            const mode = e.skill.attackMode === 'mapLine' ? 'MAP直线' : e.skill.attackMode === 'mapArea' ? 'MAP范围' : '';
            return `${who(e.actor)} 释放${mode}${KIND[e.skill.kind]}技能【${e.skill.name}】${desc}：${parts.join('；') || '范围内没有目标'}。`;
        }
        case 'dot':
            return e.effect === 'poison'
                ? `${who(e.actor)} 受到毒素侵蚀，损失 ${e.hpBefore - e.hpAfter} 点生命（${hpChange(e)}）。`
                : `${who(e.actor)} 在【${e.label}】效果下恢复了 ${e.hpAfter - e.hpBefore} 点生命（${hpChange(e)}）。`;
        case 'stunned':
            return `${who(e.actor)} 处于眩晕状态，无法行动。`;
        case 'statusEnd':
            return `${who(e.actor)} 身上的${e.effects.map(x => `【${x}】`).join('')}效果结束了。`;
        case 'phase':
            return e.phase === 'player' ? `—— 第 ${e.turn} 回合 · 我方阶段开始 ——` : `—— 第 ${e.turn} 回合 · ${SIDE_NAMES[e.phase]}阶段 ——`;
        case 'terrainHeal':
            return `${who(e.actor)} 借助${e.terrain}恢复了 ${e.heal} 点生命（${hpChange(e)}）。`;
        case 'reinforce': {
            const where = `${pos(e.at)}${e.terrain}`;
            if (!e.units.length) return `${SIDE_NAMES[e.side]}的增援（${e.actor.name}）试图从 ${where} 赶到，但道路被堵住了。`;
            return `${SIDE_NAMES[e.side]}增援从 ${where} 出现：${e.units.map(who).join('、')}${e.units.length < e.wanted ? `（另有 ${e.wanted - e.units.length} 名被地形堵住）` : ''}。`;
        }
        case 'mission':
            return `任务：${e.text}`;
        case 'result':
            return e.result === 'victory'
                ? `★ 战斗结束：我方胜利！${e.reason || '所有敌人都被击败了'}。`
                : `✖ 战斗结束：我方战败……${e.reason || ''}。`;
        default:
            return '';
    }
}

/** 一句话简述（用于“无需描写”的背景信息） */
function briefEvent(e) {
    if (e.type === 'phase') return '';
    return formatEvent(e).replace(/（[^）]*）/g, '');
}

/**
 * 组装发送给 LLM 的用户消息
 * @param {object} battle
 * @param {object[]} events 待发送事件
 * @param {object} settings 插件设置
 * @param {string} note 用户补充说明
 */
export function composeMessage(battle, events, settings, note = '') {
    const n = settings.narration;
    const narrate = [], brief = [];
    for (const e of events) {
        if (shouldNarrate(e, n)) narrate.push(formatEvent(e));
        else if (n.brief) {
            const s = briefEvent(e);
            if (s) brief.push(s);
        }
    }
    const lines = [];
    if (settings.send.header) lines.push(settings.send.header.trim());
    const first = Math.min(battle.turn, ...events.map(e => e.turn || battle.turn));
    lines.push(`〔战场：${battle.mapName}｜${first < battle.turn ? `第 ${first}–${battle.turn} 回合` : `第 ${battle.turn} 回合`}〕`);
    if (narrate.length) {
        lines.push('', '【需要描写的行动】');
        narrate.forEach(s => lines.push(s.startsWith('——') ? s : `· ${s}`));
    }
    if (brief.length) {
        lines.push('', '【背景信息（无需详细描写，一笔带过或略过即可）】');
        brief.forEach(s => lines.push(`· ${s}`));
    }
    if (!narrate.length && !brief.length) {
        lines.push('', '（本次战场变化无需描写，请继续推进剧情。）');
    }
    if (note && note.trim()) {
        lines.push('', '【用户补充要求】', note.trim());
    }
    return lines.join('\n');
}

/** 任务说明，例如“守城战：保护「城门」，坚守到第 5 回合结束（还剩 3 回合）” */
export function missionText(battle) {
    const m = missionOf(battle);
    const n = Number(m.turns) || 0;
    const names = list => list.map(u => `「${u.name}」${u.hp > 0 ? '' : '（已摧毁）'}`).join('');
    const left = n ? `（还剩 ${Math.max(0, n - battle.turn + 1)} 回合）` : '';
    switch (m.type) {
        case 'defend':
            return `${MISSION_NAMES.defend}：敌人会直奔${names(guardTargets(battle)) || '守卫目标'}，保护它不被摧毁${n ? `，坚守到第 ${n} 回合结束${left}` : '，并击退所有敌人'}。`;
        case 'assault':
            return `${MISSION_NAMES.assault}：破坏敌方关键目标${names(enemyKeyTargets(battle))}${n ? `，需在第 ${n} 回合结束前完成${left}` : ''}。`;
        default:
            return `${MISSION_NAMES.annihilate}：击败所有敌人${n ? `，需在第 ${n} 回合结束前完成${left}` : ''}。`;
    }
}

/** 已知的后续增援 */
export function upcomingWaves(battle) {
    return (battle.reinforcements || []).map(w => {
        const t = nextWaveTurn(battle, w);
        if (t == null) return '';
        const name = battle.unitDefs?.[w.unitId]?.name || '?';
        return `第 ${t} 回合 ${SIDE_NAMES[w.side]}${name}×${Math.max(1, Number(w.count) || 1)} 于${pos(w)}`;
    }).filter(Boolean).join('；');
}

const TARGET_NAMES = { ally: '友方', enemy: '敌方', self: '自身' };

/** 技能的一行说明，例如「辅助·友方 射程0-2 范围1 冷却3回合｜防御力上升30%（2回合）」 */
export function skillSummary(sk) {
    const side = sk.kind === 'support' ? (sk.target || 'ally') : 'enemy';
    const parts = [sk.kind === 'support' ? `辅助·${TARGET_NAMES[side]}` : `${KIND[sk.kind]} ${sk.power}%`];
    if (side !== 'self' && sk.attackMode !== 'mapLine') parts.push(`射程${sk.rangeMin}-${sk.rangeMax}`);
    if (side !== 'self' && Number(sk.radius) && !['mapLine', 'mapArea'].includes(sk.attackMode)) parts.push(`范围${sk.radius}`);
    if (Number(sk.cooldown) > 1) parts.push(`冷却${sk.cooldown}回合`);
    if (side === 'enemy' && sk.sureHit) parts.push('必中');
    else if (side === 'enemy' && Number(sk.hitMod)) parts.push(`命中${sk.hitMod > 0 ? '+' : ''}${sk.hitMod}%`);
    if (sk.uses) parts.push(`剩余${sk.usesLeft ?? sk.uses}/${sk.uses}次`);
    const fx = (sk.effects || []).map(e => {
        const label = effectLabel(e);
        return e.type === 'heal' ? `恢复HP（MATK×${e.value}%）` : e.type === 'heal_pct' ? `恢复HP（最大HP×${e.value}%）` : e.turns && !['cleanse'].includes(e.type) ? `${label}（${e.turns}回合）` : label;
    });
    const map = sk.attackMode === 'mapLine' ? `MAP直线${sk.lineLength || 3}格，不反击` : sk.attackMode === 'mapArea' ? `MAP范围半径${Math.max(1, sk.radius || 1)}格，不反击` : '';
    if (map) parts.push(map, sk.mapTargets === 'enemy' ? '仅敌方' : '敌我全部（不伤害自己）');
    return parts.join(' ') + (fx.length ? `｜${fx.join('、')}` : '');
}
