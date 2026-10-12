// 浮动主面板：标签页切换、拖动、尺寸记忆
import { h, clear, button } from './dom.js';
import { renderBattleTab, newBattleUi } from './battle.js';
import { renderUnitsTab, renderTerrainsTab, renderMapsTab, newEditorUi } from './editors.js';
import { renderSettingsTab } from './settings.js';
import { buildBattleContext } from '../context.js';
import { alive } from '../engine.js';
import * as ST from '../st.js';

const TABS = [
    ['battle', '战场', 'fa-chess-board', renderBattleTab],
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

    get isOpen() {
        return !!this.panel && !this.panel.hidden;
    }

    mount() {
        const s = this.settings;
        this.tabBar = h('div.tsrpg-tabs');
        this.body = h('div.tsrpg-body');
        const header = h('div.tsrpg-header',
            h('div.tsrpg-title', h('i.fa-solid.fa-chess-knight'), ' Tavern-SRPG'),
            this.tabBar,
            button('', () => this.toggle(false), { icon: 'fa-xmark', cls: 'tsrpg-close', title: '关闭' }),
        );
        this.panel = h('div#tsrpg-panel.tsrpg-panel', { hidden: true }, header, this.body);
        document.body.append(this.panel);

        const { ui } = s;
        if (ui.width) this.panel.style.width = `${ui.width}px`;
        if (ui.height) this.panel.style.height = `${ui.height}px`;
        if (ui.left != null && ui.top != null) {
            this.panel.style.left = `${ui.left}px`;
            this.panel.style.top = `${ui.top}px`;
        }
        this.enableDrag(header);
        let t = null;
        new ResizeObserver(() => {
            if (!this.isOpen) return;
            clearTimeout(t);
            t = setTimeout(() => {
                const r = this.panel.getBoundingClientRect();
                Object.assign(this.settings.ui, { width: Math.round(r.width), height: Math.round(r.height) });
                this.save();
            }, 400);
        }).observe(this.panel);
    }

    enableDrag(handle) {
        let start = null;
        handle.addEventListener('mousedown', e => {
            if (e.target.closest('button, .tsrpg-tab') || window.innerWidth < 700) return;
            const r = this.panel.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!start) return;
            const left = Math.max(0, Math.min(window.innerWidth - 80, start.left + e.clientX - start.x));
            const top = Math.max(0, Math.min(window.innerHeight - 40, start.top + e.clientY - start.y));
            this.panel.style.left = `${left}px`;
            this.panel.style.top = `${top}px`;
        });
        window.addEventListener('mouseup', () => {
            if (!start) return;
            start = null;
            const r = this.panel.getBoundingClientRect();
            Object.assign(this.settings.ui, { left: Math.round(r.left), top: Math.round(r.top) });
            this.save();
        });
    }

    toggle(force) {
        if (!this.panel) return;
        const open = force ?? this.panel.hidden;
        this.panel.hidden = !open;
        if (open) this.render();
    }

    setTab(id) {
        this.settings.ui.tab = id;
        this.save();
        this.render();
    }

    render() {
        if (!this.isOpen) return;
        const s = this.settings;
        if (!TABS.some(t => t[0] === s.ui.tab)) s.ui.tab = 'battle';
        clear(this.tabBar).append(...TABS.map(([id, label, icon]) =>
            h(`div.tsrpg-tab${id === s.ui.tab ? '.active' : ''}`, { onclick: () => this.setTab(id), title: label },
                h(`i.fa-solid.${icon}`), h('span', label))));
        const scroll = this.body.scrollTop;
        const renderer = TABS.find(t => t[0] === s.ui.tab)[3];
        try {
            renderer(this, this.body);
        } catch (err) {
            console.error('[Tavern-SRPG]', err);
            clear(this.body).append(h('div.tsrpg-empty', `界面渲染出错：${err.message || err}`));
        }
        this.body.scrollTop = scroll;
    }

    onChatChanged() {
        this.bs = newBattleUi();
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
        const inj = this.settings.inject;
        const opts = { ...inj, sections };
        if (sections) Object.assign(opts, { map: true, legend: true, stats: true, skills: true, nearest: true });
        // 替换别名、世界书内容里的 {{user}} {{char}}，让宏、工具、注入看到的都是真实名字
        return ST.substitute(buildBattleContext(b, opts, inj.includeWb ? this.wbCache : {}));
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
