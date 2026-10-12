// 浮动主面板：标签页切换、拖动、尺寸记忆
import { h, clear, button } from './dom.js';
import { renderBattleTab, newBattleUi } from './battle.js';
import { renderUnitsTab, renderTerrainsTab, renderMapsTab, newEditorUi } from './editors.js';
import { renderSettingsTab } from './settings.js';
import { renderProfilesTab } from './profiles-tab.js';
import { getProfile, profileFor, addProfiles, PROFILE_FORMAT } from '../profiles.js';
import { toast } from './dom.js';
import { buildBattleContext } from '../context.js';
import { commandGuide } from '../commands.js';
import { alive } from '../engine.js';
import * as ST from '../st.js';

const TABS = [
    ['battle', '战场', 'fa-chess-board', renderBattleTab],
    ['profiles', '资料卡', 'fa-address-card', renderProfilesTab],
    ['units', '单位', 'fa-users', renderUnitsTab],
    ['terrains', '地形', 'fa-mountain-sun', renderTerrainsTab],
    ['maps', '地图', 'fa-map', renderMapsTab],
    ['settings', '设置', 'fa-gear', renderSettingsTab],
];

export class App {
    constructor() {
        this.bs = newBattleUi();
        this.ed = newEditorUi();
        this.panel = null;
        this.body = null;
        this.tabBar = null;
        this.injectSeq = 0;
        this.wbCache = {}; // uid -> 世界书条目内容（供宏和工具同步读取）
    }

    get settings() {
        return ST.getSettings();
    }

    save() {
        ST.saveSettings();
    }

    /** 当前使用的资料卡（单位、地形、地图、战斗规则） */
    get data() {
        const s = this.settings;
        let p = getProfile(s, s.activeProfile);
        if (!p) {
            p = s.profiles[0];
            s.activeProfile = p.id;
        }
        return p;
    }

    /** 切换资料卡 */
    switchProfile(id, { quiet = false } = {}) {
        const s = this.settings;
        const p = getProfile(s, id);
        if (!p || s.activeProfile === id) return false;
        s.activeProfile = id;
        this.save();
        this.ed = newEditorUi();
        this.bs.setupMap = null;
        if (!quiet) toast('info', `已切换到资料卡「${p.name}」`);
        this.render();
        return true;
    }

    /** 打开聊天时：切换到该角色 / 群组绑定的资料卡；角色卡里带有资料卡时询问是否导入 */
    async syncProfileWithChat() {
        const owner = ST.currentOwner();
        if (!owner) return;
        const s = this.settings;
        await this.offerEmbeddedProfile(owner);
        const target = profileFor(s, owner.key);
        if (target && target.id !== s.activeProfile) {
            this.switchProfile(target.id, { quiet: true });
            toast('info', `${owner.name} 使用资料卡「${target.name}」`);
        }
    }

    async offerEmbeddedProfile(owner) {
        if (owner.kind !== 'char') return;
        const s = this.settings;
        const embedded = ST.readCardExtension(owner.character);
        if (embedded?.format !== PROFILE_FORMAT || !embedded.profile) return;
        const p = embedded.profile;
        if (s.bindings[owner.key]) return; // 已经绑定过（可能就是自己写进去的）
        if (getProfile(s, p.id)) { s.bindings[owner.key] = p.id; this.save(); return; }
        const stamp = `${p.id}@${p.updatedAt || 0}`;
        if (s.declinedEmbeds[owner.key] === stamp) return;
        const ok = await ST.confirmPopup(
            `<h3>角色卡附带了 SRPG 资料卡</h3><p>「${owner.name}」带有资料卡「${p.name}」（${(p.units || []).length} 个单位、${(p.maps || []).length} 张地图）。</p><p>导入并绑定到这个角色吗？</p>`,
            `「${owner.name}」带有 SRPG 资料卡「${p.name}」，导入并绑定到这个角色吗？`);
        if (!ok) {
            s.declinedEmbeds[owner.key] = stamp;
            this.save();
            return;
        }
        const [added] = addProfiles(s, [p], { normalize: ST.normalizeProfile });
        s.bindings[owner.key] = added.id;
        this.save();
        toast('success', `已导入资料卡「${added.name}」并绑定到 ${owner.name}`);
    }

    get isOpen() {
        return !!this.panel && !!this._open;
    }

    mount() {
        this.tabBar = h('div.tsrpg-tabs');
        this.body = h('div.tsrpg-body');
        this.layoutBtn = button('', () => this.setLayout(this.settings.ui.layout === 'compact' ? 'float' : 'compact'), { cls: 'tsrpg-icon-btn' });
        const header = h('div.tsrpg-header',
            h('div.tsrpg-title', h('i.fa-solid.fa-chess-knight'), h('span', ' Tavern-SRPG')),
            this.tabBar,
            this.layoutBtn,
            button('', () => this.toggle(false), { icon: 'fa-xmark', cls: 'tsrpg-icon-btn', title: '收起（点击悬浮按钮可再次打开）' }),
        );
        this.panel = h('div#tsrpg-panel.tsrpg-panel', { hidden: true }, header, this.body);
        document.body.append(this.panel);
        this.mountFab();
        this.applyLayout();
        this.enableDrag(header);

        // 记住浮动窗口的尺寸；宽度变化时切换紧凑布局并重新适配棋盘
        let t = null, lastW = 0;
        new ResizeObserver(() => {
            if (!this.isOpen) return;
            const w = this.panel.getBoundingClientRect().width;
            this.panel.classList.toggle('narrow', w < 640);
            clearTimeout(t);
            t = setTimeout(() => {
                const r = this.panel.getBoundingClientRect();
                if (this.settings.ui.layout === 'float' && window.innerWidth >= 700) {
                    Object.assign(this.settings.ui, { width: Math.round(r.width), height: Math.round(r.height) });
                    this.save();
                }
                if (this.settings.ui.layout === 'compact' && r.bottom > window.innerHeight) {
                    this.panel.style.top = `${Math.max(0, window.innerHeight - r.height)}px`;
                }
                if (Math.abs(r.width - lastW) > 8) { lastW = r.width; this.render(); }
            }, 200);
        }).observe(this.panel);
        window.addEventListener('resize', () => { this.applyLayout(); this.render(); });
    }

    /** 完整窗口与仅保留战斗操作的小窗。旧停靠设置迁移为小窗。 */
    applyLayout() {
        const { ui } = this.settings;
        if (ui.layout === 'dock') { ui.layout = 'compact'; this.save(); }
        const compact = ui.layout === 'compact';
        const p = this.panel;
        p.classList.remove('dock');
        p.classList.toggle('float', !compact);
        p.classList.toggle('compact', compact);
        p.style.cssText = '';
        if (!compact) {
            if (ui.width) p.style.width = `${ui.width}px`;
            if (ui.height) p.style.height = `${ui.height}px`;
        }
        const pos = compact ? ui.compactPos : ui;
        if (pos?.left != null && pos?.top != null) {
            p.style.left = `${Math.max(0, Math.min(pos.left, window.innerWidth - (compact ? Math.min(460, window.innerWidth - 20) : 120)))}px`;
            p.style.right = 'auto';
            p.style.top = `${Math.max(0, Math.min(pos.top, window.innerHeight - (compact ? this.panel.getBoundingClientRect().height || 60 : 60)))}px`;
        }
        p.hidden = !this.isOpenState;
        clear(this.layoutBtn).append(h(`i.fa-solid.${compact ? 'fa-expand' : 'fa-compress'}`));
        this.layoutBtn.title = compact ? '恢复完整窗口' : '缩小为战斗小窗';
        this.placeFab();
    }

    setLayout(layout) {
        this.settings.ui.layout = layout;
        this.save();
        this.applyLayout();
        this.render();
    }

    enableDrag(handle) {
        let start = null;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('button, .tsrpg-tab') || (this.settings.ui.layout !== 'compact' && window.innerWidth < 700)) return;
            const r = this.panel.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            e.preventDefault();
        });
        window.addEventListener('pointermove', e => {
            if (!start) return;
            const compact = this.settings.ui.layout === 'compact';
            const r = this.panel.getBoundingClientRect();
            const left = Math.max(0, Math.min(window.innerWidth - (compact ? r.width : 80), start.left + e.clientX - start.x));
            const top = Math.max(0, Math.min(window.innerHeight - (compact ? r.height : 40), start.top + e.clientY - start.y));
            this.panel.style.left = `${left}px`;
            this.panel.style.top = `${top}px`;
        });
        window.addEventListener('pointerup', () => {
            if (!start) return;
            start = null;
            const r = this.panel.getBoundingClientRect();
            const pos = { left: Math.round(r.left), top: Math.round(r.top) };
            if (this.settings.ui.layout === 'compact') this.settings.ui.compactPos = pos;
            else Object.assign(this.settings.ui, pos);
            this.save();
        });
        window.addEventListener('pointercancel', () => { start = null; });
    }

    // ---------------------------------------------------------------- 悬浮按钮

    mountFab() {
        this.fabBadge = h('span.tsrpg-fab-badge', { hidden: true });
        this.fab = h('div#tsrpg-fab.tsrpg-fab', { title: 'Tavern-SRPG 战棋（可拖动）' }, h('i.fa-solid.fa-chess-knight'), this.fabBadge);
        document.body.append(this.fab);
        let start = null;
        const onMove = e => {
            if (!start) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < 5) return;
            start.moved = true;
            const right = Math.max(4, Math.min(window.innerWidth - 52, start.right - dx));
            const bottom = Math.max(4, Math.min(window.innerHeight - 52, start.bottom - dy));
            Object.assign(this.fab.style, { right: `${right}px`, bottom: `${bottom}px` });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!start) return;
            const moved = start.moved;
            start = null;
            if (moved) {
                const r = this.fab.getBoundingClientRect();
                this.settings.ui.fabPos = { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) };
                this.save();
            } else {
                this.toggle();
            }
        };
        this.fab.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            const r = this.fab.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, moved: false };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
        this.placeFab();
    }

    placeFab() {
        if (!this.fab) return;
        const { ui } = this.settings;
        const pos = ui.fabPos || { right: 20, bottom: 140 };
        Object.assign(this.fab.style, {
            right: `${Math.max(4, Math.min(window.innerWidth - 52, pos.right))}px`,
            bottom: `${Math.max(4, Math.min(window.innerHeight - 52, pos.bottom))}px`,
        });
        // 窗口打开时隐藏悬浮按钮，避免遮挡地图和操作。
        const hide = ui.fab === false || this.isOpen;
        this.fab.hidden = hide;
        this.fab.classList.toggle('open', this.isOpen);
        this.updateSqueeze();
    }

    /** 清理旧停靠模式留下的聊天区域偏移。 */
    updateSqueeze() {
        document.body.classList.remove('tsrpg-squeeze');
        document.body.style.removeProperty('--tsrpg-dock-width');
    }

    /** 悬浮按钮上的提示：LLM 提议的战场变化数量 */
    updateFab() {
        if (!this.fabBadge) return;
        const n = ST.getBattle()?.llm?.proposals?.cmds?.length || 0;
        this.fabBadge.hidden = !n;
        this.fabBadge.textContent = n ? String(n) : '';
        this.fab.classList.toggle('active', !!ST.getBattle()?.active);
    }

    /** 根据面板宽度决定格子大小（不超过设置中的上限） */
    cellFor(w, reserve = 0) {
        const max = this.settings.ui.layout === 'compact' ? Math.min(32, Number(this.settings.ui.cell) || 40) : Number(this.settings.ui.cell) || 40;
        const avail = (this.body?.clientWidth || 600) - 28;
        const narrow = this.settings.ui.layout === 'compact' || this.panel?.classList.contains('narrow');
        // 宽面板时，棋盘旁边还有信息栏 / 列表
        const room = narrow ? avail : avail - reserve;
        return Math.max(18, Math.min(max, Math.floor(room / Math.max(1, w)) - 1));
    }

    get isOpenState() {
        return !!this._open;
    }

    toggle(force) {
        if (!this.panel) return;
        const open = force ?? !this._open;
        this._open = open;
        this.panel.hidden = !open;
        this.placeFab();
        if (open) this.render();
    }

    setTab(id) {
        this.settings.ui.tab = id;
        this.save();
        this.render();
    }

    render() {
        if (!this.isOpen) { this.updateFab(); return; }
        // 先按当前宽度决定布局，棋盘格子大小依赖它
        this.panel.classList.toggle('narrow', this.panel.getBoundingClientRect().width < 640);
        this.updateSqueeze();
        const s = this.settings;
        if (!TABS.some(t => t[0] === s.ui.tab)) s.ui.tab = 'battle';
        clear(this.tabBar).append(...TABS.map(([id, label, icon]) =>
            h(`div.tsrpg-tab${id === s.ui.tab ? '.active' : ''}`, { onclick: () => this.setTab(id), title: label },
                h(`i.fa-solid.${icon}`), h('span', label))));
        const scroll = this.body.scrollTop;
        const renderer = s.ui.layout === 'compact' ? renderBattleTab : TABS.find(t => t[0] === s.ui.tab)[3];
        try {
            renderer(this, this.body);
        } catch (err) {
            console.error('[Tavern-SRPG]', err);
            clear(this.body).append(h('div.tsrpg-empty', `界面渲染出错：${err.message || err}`));
        }
        this.body.scrollTop = scroll;
        this.updateFab();
    }

    async onChatChanged() {
        this.bs = newBattleUi();
        try {
            await this.syncProfileWithChat();
        } catch (err) {
            console.warn('[Tavern-SRPG] 同步资料卡失败', err);
        }
        this.updateInjection();
        this.render();
    }

    /**
     * 给 LLM 看的战场信息
     * @param {string[]} [sections] 只输出某些部分：mission / map / units / log
     */
    battleContext(sections) {
        const b = ST.getBattle();
        if (!b?.active) return '';
        const { inject: inj, llm } = this.settings;
        const opts = { ...inj, sections, commands: llm.commands };
        if (sections) Object.assign(opts, { map: true, legend: true, stats: true, skills: true, nearest: true });
        let text = buildBattleContext(b, opts, inj.includeWb ? this.wbCache : {});
        // 开启剧情指令时，告诉 LLM 怎样写指令
        if (llm.commands && !sections) text += `\n\n${commandGuide(llm)}`;
        // 替换别名、世界书内容里的 {{user}} {{char}}，让宏、工具、注入看到的都是真实名字
        return ST.substitute(text);
    }

    /** 把战场信息注入到提示词中 */
    async updateInjection() {
        const seq = ++this.injectSeq;
        const s = this.settings;
        const b = ST.getBattle();
        if (!b?.active) {
            this.wbCache = {};
            ST.setInjection('');
            return;
        }
        if (s.inject.includeWb) {
            const wb = {};
            for (const u of alive(b)) {
                if (!u.wb) continue;
                const text = await ST.getEntryContent(u.wb);
                if (text) wb[u.uid] = text;
            }
            if (seq !== this.injectSeq) return; // 已有更新的调用
            this.wbCache = wb;
        }
        ST.setInjection(s.inject.enabled ? this.battleContext() : '', s.inject);
    }
}
