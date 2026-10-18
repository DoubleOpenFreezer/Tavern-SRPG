// 剧情联动：处理聊天回复中的 <srpg-story> 标记，后台生成角色成长 / 剧情关卡，应用与撤销
import * as ST from '../st.js';
import { toast } from './dom.js';
import { uid } from '../defaults.js';
import { extractStory, buildGrowthPrompt, normalizeGrowth, applyGrowth, revertGrowth, growthIds, STORY_KINDS } from '../story.js';
import { buildDesignPrompt, parseDesignReply } from '../designer.js';
import { designerGenerate } from '../ai-api.js';

const ACTIVE = ['queued', 'working', 'ready', 'error'];

/** 设计助手需要的资料：世界书、角色卡、最近的剧情 */
export async function designContext(app, { chat = false, upTo = null } = {}) {
    const cfg = app.settings.designer;
    const books = cfg.books ?? await ST.chatLoreBooks().catch(() => []);
    const lore = await ST.loreForDesign(books, cfg.loreChars);
    return {
        books, lore: lore.text, entries: lore.entries, truncated: lore.truncated,
        character: cfg.includeChar ? ST.characterBrief() : '',
        chat: chat ? ST.recentChat(Math.max(1, Number(cfg.story?.chatDepth) || 20), upTo) : '',
    };
}

/** 收到 AI 回复：取出剧情标记，排队生成 */
export async function handleStoryMessage(app, mesId, type) {
    const cfg = app.settings.designer.story;
    if (!cfg.enabled || !ST.isEnabledForChat() || type === 'first_message') return;
    const msg = ST.getMessage(mesId);
    if (!msg || msg.is_user || msg.is_system) return;
    const { clean, items } = extractStory(msg.mes);
    const store = ST.getStory(true);
    // 重新生成 / 滑动：上一版回复留下、尚未应用的提议作废
    if (type !== 'continue') {
        for (const it of store.items) if (it.mesId === mesId && ACTIVE.includes(it.status)) it.status = 'dismissed';
    }
    if (!items.length) { ST.saveStory(); app.render(); return; }
    if (cfg.hideTag) await ST.rewriteChatMessage(mesId, clean);
    for (const it of items) {
        if (it.kind === 'battle' && !cfg.battle) continue;
        if (it.kind === 'battle' && ST.getBattle()?.active) { toast('info', `剧情提到了战斗「${it.subject}」，但当前已有进行中的战斗，已忽略。`); continue; }
        store.items.push({ id: uid('story'), ...it, mesId, status: 'queued', at: Date.now() });
    }
    store.items = store.items.slice(-30);
    ST.saveStory();
    app.render();
    processQueue(app);
}

/** 消息被删除：被删楼层上尚未处理的提议作废 */
export function handleStoryDeleted(app) {
    const store = ST.getStory();
    if (!store) return;
    const n = ST.chatLength();
    let changed = false;
    for (const it of store.items) if (it.mesId >= n && ACTIVE.includes(it.status)) { it.status = 'dismissed'; changed = true; }
    if (changed) { ST.saveStory(); app.render(); }
}

/** 切换聊天后继续处理没做完的提议 */
export function resumeStory(app) {
    const store = ST.getStory();
    if (!store) return;
    for (const it of store.items) if (it.status === 'working') it.status = 'queued';
    if (store.items.some(it => it.status === 'queued')) processQueue(app);
}

let running = false;

export async function processQueue(app) {
    if (running) return;
    running = true;
    try {
        for (;;) {
            const item = ST.getStory()?.items.find(x => x.status === 'queued');
            if (!item) break;
            await runItem(app, item);
        }
    } finally {
        running = false;
        app.render();
    }
}

/** 为一条提议生成内容（成长或关卡） */
async function runItem(app, item) {
    const cfg = app.settings.designer;
    const chatId = ST.currentChatId();
    item.status = 'working'; item.error = '';
    app.render();
    try {
        const ctx = await designContext(app, { chat: true, upTo: item.mesId });
        const hint = `${item.subject}${item.text ? `：${item.text}` : ''}`;
        const prompt = item.kind === 'grow'
            ? buildGrowthPrompt(app.data, { hint, chat: ctx.chat, lore: ctx.lore, character: ctx.character })
            : buildDesignPrompt(app.data, { task: 'story', request: hint, size: { w: 12, h: 8 }, chat: ctx.chat, lore: ctx.lore, character: ctx.character });
        const { text, truncated } = await designerGenerate(cfg, prompt);
        if (ST.currentChatId() !== chatId) return; // 聊天已切换：回到那个聊天时会重新处理
        if (item.status !== 'working') return; // 生成期间回复被重新生成、删除或忽略：结果作废
        Object.assign(item, { json: parseDesignReply(text), truncated: !!truncated, entries: ctx.entries, status: 'ready', profileId: app.data.id });
        if (item.kind === 'grow' && cfg.story.grow === 'auto') {
            applyStoryGrowth(app, item);
        } else {
            toast('info', `「${item.subject}」的${STORY_KINDS[item.kind]}已生成，打开「AI 设计」页查看并确认。`);
        }
    } catch (err) {
        if (ST.currentChatId() !== chatId || item.status !== 'working') return;
        item.status = 'error';
        item.error = err.message || String(err);
        toast('warning', `「${item.subject}」的${STORY_KINDS[item.kind]}生成失败：${item.error}`);
    }
    ST.saveStory();
    app.render();
}

/** 进行中的战斗（需要同步成长时） */
function liveBattle(app) {
    const b = ST.getBattle();
    return app.settings.designer.story.syncBattle && b?.active && !b.paused && b.profileId === app.data.id ? b : null;
}

/**
 * 应用一条剧情成长；chosen 为空时全部应用
 * @returns {object|null} applyGrowth 的结果
 */
export function applyStoryGrowth(app, item, chosen = null, growth = null) {
    if (item.profileId && item.profileId !== app.data.id) { toast('warning', '这条成长是为另一张资料卡生成的，请先切换回那张资料卡。'); return null; }
    const g = growth || normalizeGrowth(item.json, app.data, { entries: item.entries || [] });
    const battle = liveBattle(app);
    const res = applyGrowth(app.data, g, chosen || new Set(growthIds(g)), battle);
    if (!res.lines.length) { toast('info', '没有可应用的变化。'); return res; }
    app.save();
    if (battle) {
        battle.pending.push({ type: 'growth', turn: battle.turn, text: res.lines.join('；') });
        ST.saveBattle();
        app.updateInjection();
    }
    Object.assign(item, { status: 'applied', applied: { before: res.before, newIds: res.newIds, lines: res.lines, profileId: app.data.id } });
    ST.saveStory();
    toast('success', `剧情成长：${res.lines.join('；')}${battle && res.synced ? '（已同步到当前战斗）' : ''}`);
    app.render();
    return res;
}

/** 撤销已应用的成长（只恢复资料卡；进行中战斗里的变化不回退） */
export function undoStoryGrowth(app, item) {
    const a = item.applied;
    if (!a) return;
    if (a.profileId !== app.data.id) return toast('warning', '这条成长属于另一张资料卡，请先切换回那张资料卡。');
    revertGrowth(app.data, a.before, a.newIds);
    app.save();
    item.status = 'ready';
    delete item.applied;
    ST.saveStory();
    toast('info', `已撤销「${item.subject}」的成长（进行中战斗里的变化需要用「撤销」或手动修改恢复）。`);
    app.render();
}

export function retryStory(app, item) {
    item.status = 'queued';
    ST.saveStory();
    processQueue(app);
}

export function dismissStory(app, item) {
    item.status = 'dismissed';
    ST.saveStory();
    app.render();
}

/** 等待处理（已生成待确认）的提议数量，用于悬浮按钮角标 */
export function readyStoryCount() {
    return (ST.getStory()?.items || []).filter(x => x.status === 'ready').length;
}
