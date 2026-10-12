// LLM 影响战场：处理回复中的指令、待确认的提议、重新生成时撤回、LLM 指挥官
import * as E from '../engine.js';
import * as ST from '../st.js';
import { toast } from './dom.js';
import { formatEvent } from '../narrator.js';
import { extractBlocks, parseCommands, applyCommand, previewCommands, settle } from '../commands.js';
import { buildCommanderPrompt, parseCommanderReply } from '../commander.js';

export function commandOptions(app) {
    const s = app.settings;
    return { ...s.llm, unitDefs: app.data.units, terrainDefs: app.data.terrains, subst: ST.substitute };
}

function llmState(b) {
    b.llm ||= { proposals: null, applied: null };
    return b.llm;
}

// ---------------------------------------------------------------- 回复中的指令

/** 收到 AI 回复时：取出指令块，按设置自动应用或等待确认 */
export async function handleMessage(app, mesId, type) {
    const s = app.settings;
    if (!s.llm.commands || type === 'first_message') return;
    let b = ST.getBattle();
    if (!b?.active) return;
    const msg = ST.getMessage(mesId);
    if (!msg || msg.is_user || msg.is_system) return;
    const chatId = ST.currentChatId();

    // 同一条消息被重新生成 / 滑动：先撤回上一版回复造成的改动（续写不撤回）
    if (type !== 'continue') {
        revertMessage(app, mesId);
        b = ST.getBattle();
    }
    const { clean, blocks } = extractBlocks(msg.mes);
    const st = llmState(b);
    if (!blocks.length) {
        if (st.proposals?.mesId === mesId && type !== 'continue') { st.proposals = null; ST.saveBattle(); app.render(); }
        return;
    }
    if (s.llm.hideBlock) await ST.rewriteMessage(mesId, clean);
    if (ST.getBattle() !== b || ST.currentChatId() !== chatId) return;
    const cmds = blocks.flatMap(parseCommands);
    if (!cmds.length) return;

    if (s.llm.mode === 'auto') {
        applyCommands(app, b, cmds, mesId);
    } else {
        const prev = st.proposals?.mesId === mesId && type === 'continue' ? st.proposals.cmds : [];
        st.proposals = { mesId, cmds: [...prev, ...cmds] };
        ST.saveBattle();
        toast('info', `LLM 提议了 ${cmds.length} 项战场变化，点击悬浮按钮在战场页确认。`);
        if (app.isOpen && app.settings.ui.tab !== 'battle') app.setTab('battle');
        else app.render();
    }
}

/** 应用一组指令；记录应用前的快照，以便重新生成时撤回 */
export function applyCommands(app, b, cmds, mesId) {
    if (ST.getBattle() !== b) return;
    const snapshot = structuredClone(b);
    snapshot.llm = { proposals: null, applied: null };
    app.bs.undo.push(structuredClone(b));
    const opt = commandOptions(app);
    const events = [], errors = [];
    for (const c of cmds) {
        try {
            events.push(applyCommand(b, c, opt));
        } catch (err) {
            errors.push(`${c.raw}：${err.message || err}`);
        }
    }
    const r = settle(b);
    if (r) events.push(r);
    b.log.push(...events.map(formatEvent).filter(Boolean));
    const st = llmState(b);
    st.proposals = null;
    st.applied = events.length ? { mesId, snapshot, rev: (b.rev || 0) + 1 } : st.applied;
    ST.saveBattle();
    app.updateInjection();
    app.render();
    if (events.length) toast('success', `已应用 ${events.length} 项战场变化`);
    if (errors.length) toast('warning', `${errors.length} 条指令无效：\n${errors.join('\n')}`);
    if (b.result) toast(b.result === 'victory' ? 'success' : 'error', `战斗结束：${b.resultReason || ''}`);
    return { events, errors };
}

/** 待确认提议的预演结果（用于界面显示） */
export function previewProposals(app, b) {
    const p = b.llm?.proposals;
    return p ? previewCommands(b, p.cmds, commandOptions(app)) : [];
}

export function acceptProposals(app, b, keep) {
    const p = b.llm?.proposals;
    if (!p) return;
    const cmds = p.cmds.filter((_, i) => !keep || keep[i]);
    if (!cmds.length) return rejectProposals(app, b);
    applyCommands(app, b, cmds, p.mesId);
}

export function rejectProposals(app, b) {
    llmState(b).proposals = null;
    ST.saveBattle();
    app.render();
}

/**
 * 撤回某条消息造成的改动（重新生成、滑动、删除时调用）。
 * 如果之后棋盘又有别的改动，就不自动撤回，只提示。
 */
export function revertMessage(app, mesId) {
    const b = ST.getBattle();
    const st = b?.llm;
    if (st?.proposals?.mesId === mesId) st.proposals = null;
    const ap = st?.applied;
    if (!ap || ap.mesId !== mesId) return false;
    if (b.rev !== ap.rev) {
        st.applied = null;
        ST.saveBattle();
        toast('warning', '上一版回复造成的战场变化之后，棋盘又有了其他改动，没有自动撤回。需要的话请用「撤销」。');
        return false;
    }
    ST.setBattle(ap.snapshot);
    app.bs.undo = [];
    app.updateInjection();
    app.render();
    toast('info', '已撤回上一版回复造成的战场变化。');
    return true;
}

/** 消息被删除后，撤回已删除消息造成的改动 */
export function handleDeleted(app) {
    const ap = ST.getBattle()?.llm?.applied;
    if (ap && ap.mesId >= ST.chatLength()) revertMessage(app, ap.mesId);
}

// ---------------------------------------------------------------- LLM 指挥官

async function askCommander(app, b, side, group) {
    const s = app.settings;
    // 自动注入已经包含完整战场信息；关闭注入时把信息放进指挥提示里
    const context = s.inject.enabled ? '' : app.battleContext();
    const { prompt, options } = buildCommanderPrompt(b, side, group, app.data.rules, { limit: s.llm.options, context, intent: s.llm.intent });
    app.bs.busy = `${E.SIDE_NAMES[side]}指挥官（LLM）正在思考……`;
    app.render();
    await app.updateInjection();
    try {
        const reply = await ST.quietGenerate(ST.substitute(prompt));
        console.debug('[Tavern-SRPG] 指挥官回复', reply);
        const picks = parseCommanderReply(b, reply);
        if (!picks.size) toast('warning', '没能从 LLM 的回复中读出指挥，改由战斗系统决定。');
        return { picks, options };
    } catch (err) {
        console.warn('[Tavern-SRPG] 指挥官生成失败', err);
        toast('warning', `LLM 指挥失败，改由战斗系统决定：${err.message || err}`);
        return { picks: new Map(), options };
    }
}

/**
 * 敌方 / 友军阶段（异步版）：开启了 LLM 指挥的阵营先问 LLM，其余交给内置 AI。
 * 等待期间如果切换了聊天，就放弃本次结算。
 */
export async function runAiPhases(app, b, { quiet = false, chooseReaction, processEvents } = {}) {
    const s = app.settings;
    const chatId = ST.currentChatId();
    const events = [];
    const check = () => {
        if (ST.currentChatId() !== chatId || ST.getBattle() !== b) throw new Error('聊天已切换，本次敌方回合已停止。');
    };
    const process = async (before, batch) => {
        if (batch.length && processEvents) await processEvents(before, batch);
        check();
        app.bs.busy = '回合结算中……';
    };
    for (const side of E.AI_SIDES) {
        if (b.result) break;
        check();
        const phaseBefore = structuredClone(b);
        const { events: ev, group } = E.beginSidePhase(b, side);
        events.push(...ev);
        await process(phaseBefore, ev);
        if (b.result) break;
        if (!group.length) continue;
        let picks = new Map(), options = new Map();
        if (!quiet && s.llm.commander[side]) {
            ({ picks, options } = await askCommander(app, b, side, group));
            check();
        }
        for (const u of group) {
            if (b.result) break;
            if (u.hp <= 0 || u.retreated) continue;
            check();
            const pick = picks.get(u.uid);
            const plan = pick && pick.index > 0 ? options.get(u.uid)?.[pick.index - 1] : null;
            let processBefore = structuredClone(b), played = 0;
            const choose = async request => {
                const moves = request.eventsBefore.slice(played);
                if (moves.length) {
                    await process(processBefore, moves);
                    played = request.eventsBefore.length;
                    processBefore = structuredClone(b);
                }
                check();
                const response = chooseReaction ? await chooseReaction(request) : E.defaultReaction(b, request.attacker, request.target, app.data.rules, request.skill);
                check();
                if (!['counter', 'defend', 'none'].includes(response)) throw new Error('已取消本次回合结算。');
                return response;
            };
            let evs;
            if (plan) {
                const res = await E.actWithPlanInteractive(b, u, plan, app.data.rules, choose);
                evs = res.events;
                if (res.usedPlan && pick.intent && s.llm.intent) {
                    const main = [...evs].reverse().find(e => ['attack', 'skill', 'wait', 'move'].includes(e.type));
                    if (main) main.intent = pick.intent;
                }
            } else {
                evs = await E.aiActInteractive(b, u, app.data.rules, choose);
            }
            check();
            events.push(...evs);
            await process(processBefore, evs.slice(played));
        }
    }
    if (!b.result) {
        const before = structuredClone(b);
        const round = E.finishRound(b);
        events.push(...round);
        await process(before, round);
    }
    return events;
}
