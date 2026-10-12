// SillyTavern 适配层：设置、聊天元数据、世界书、发送消息、提示词注入
import { MODULE_NAME, META_KEY, defaultSettings } from './defaults.js';
import { normalizeSkill } from './engine.js';

export const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- 设置（全局）

function mergeDefaults(target, defs) {
    for (const [k, v] of Object.entries(defs)) {
        if (!(k in target)) target[k] = structuredClone(v);
        else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
            mergeDefaults(target[k], v);
        }
    }
    return target;
}

export function getSettings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE_NAME]) all[MODULE_NAME] = defaultSettings();
    else if (!all[MODULE_NAME]._merged) {
        mergeDefaults(all[MODULE_NAME], defaultSettings());
        // 旧版技能（kind: 'heal'、无冷却 / 效果字段）升级为新格式
        for (const u of all[MODULE_NAME].units || []) {
            (u.skills || []).forEach(normalizeSkill);
            if (u.agi == null) u.agi = u.kind === 'object' ? 0 : 5; // v3 新增敏捷
        }
        for (const t of all[MODULE_NAME].terrains || []) if (t.avoid == null) t.avoid = 0;
        all[MODULE_NAME].version = 3;
        Object.defineProperty(all[MODULE_NAME], '_merged', { value: true, enumerable: false });
    }
    return all[MODULE_NAME];
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------- 战斗状态（按聊天保存）

export function getBattle() {
    const meta = ctx().chatMetadata;
    return meta?.[META_KEY] || null;
}

export function setBattle(battle) {
    const c = ctx();
    if (!c.chatMetadata) return;
    if (battle) c.chatMetadata[META_KEY] = battle;
    else delete c.chatMetadata[META_KEY];
    saveBattle();
}

export function saveBattle() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else if (typeof c.saveMetadata === 'function') c.saveMetadata();
}

export function hasChat() {
    const c = ctx();
    return !!(c.getCurrentChatId?.() ?? c.chatId);
}

// ---------------------------------------------------------------- 世界书

let wiModule = null;
async function worldInfoModule() {
    if (!wiModule) {
        wiModule = import('/scripts/world-info.js').catch(() => import('../../../../world-info.js')).catch(() => null);
    }
    return wiModule;
}

export async function listWorldBooks() {
    const mod = await worldInfoModule();
    let names = Array.isArray(mod?.world_names) ? [...mod.world_names] : [];
    if (!names.length) {
        // 退路：从世界书编辑器的下拉框里读
        names = [...document.querySelectorAll('#world_editor_select option')]
            .map(o => o.textContent.trim()).filter(n => n && !n.startsWith('---'));
    }
    return names.sort((a, b) => a.localeCompare(b));
}

const bookCache = new Map();

/** @returns {Promise<{uid:number,label:string,keys:string[],content:string}[]>} */
export async function loadBookEntries(name, force = false) {
    if (!name) return [];
    if (!force && bookCache.has(name)) return bookCache.get(name);
    const c = ctx();
    let data = null;
    if (typeof c.loadWorldInfo === 'function') data = await c.loadWorldInfo(name);
    else data = (await worldInfoModule())?.loadWorldInfo?.(name);
    data = await data;
    const entries = Object.values(data?.entries || {}).map(e => ({
        uid: e.uid,
        label: e.comment || (e.key || [])[0] || `#${e.uid}`,
        keys: Array.isArray(e.key) ? e.key.filter(Boolean) : [],
        content: e.content || '',
        disabled: !!e.disable,
    })).sort((a, b) => a.uid - b.uid);
    bookCache.set(name, entries);
    setTimeout(() => bookCache.delete(name), 30_000);
    return entries;
}

export async function getEntryContent(wb) {
    if (!wb?.book) return '';
    try {
        const entries = await loadBookEntries(wb.book);
        return entries.find(e => e.uid === wb.uid)?.content || '';
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------- 注入 & 发送

const INJECT_KEY = 'tavern_srpg_state';

export function setInjection(text, depth = 2) {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    // position 1 = IN_CHAT，scan=true 让世界书能扫描到单位名，role 0 = system
    c.setExtensionPrompt(INJECT_KEY, text || '', 1, Number(depth) || 0, true, 0);
}

export function isGenerating() {
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

export function readMainInput() {
    return document.getElementById('send_textarea')?.value || '';
}

export function writeMainInput(text) {
    const ta = document.getElementById('send_textarea');
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 以用户身份发送消息并触发生成 */
export function sendAsUser(text) {
    writeMainInput(text);
    const btn = document.getElementById('send_but');
    if (btn) btn.click();
}
