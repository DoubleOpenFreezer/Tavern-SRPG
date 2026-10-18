// Tavern-SRPG：SillyTavern 战棋插件入口
import { App } from './src/ui/panel.js';
import { ctx } from './src/st.js';
import { registerMacros, registerTool } from './src/llm.js';
import { revertMessage, handleDeleted } from './src/ui/llm-flow.js';
import { handleStoryMessage, handleStorySwiped, handleStoryDeleted } from './src/ui/story-flow.js';
import { installBattleMessageFolding } from './src/ui/chat-messages.js';

const app = new App();
window.TavernSRPG = app;

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('tsrpg_menu_button')) return;
    const item = document.createElement('div');
    item.id = 'tsrpg_menu_button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-chess-knight extensionsMenuExtensionButton"></div><span>Tavern-SRPG 战棋</span>';
    item.addEventListener('click', () => app.toggle());
    menu.append(item);
}

function addSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('tsrpg_settings')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tsrpg_settings';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Tavern-SRPG</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>在棋盘上操作战斗，由插件计算结果，再交给 LLM 描写。单位、地形、地图与描写模式都在面板中设置。</p>
                <div class="menu_button menu_button_icon" id="tsrpg_open"><i class="fa-solid fa-chess-board"></i><span>打开战棋面板</span></div>
                <small>也可以从输入框左侧的 <i class="fa-solid fa-wand-magic-sparkles"></i> 菜单或 <code>/srpg</code> 命令打开。</small>
            </div>
        </div>`;
    host.append(wrap);
    wrap.querySelector('#tsrpg_open').addEventListener('click', () => app.toggle(true));
}

function registerCommand() {
    try {
        const c = ctx();
        const callback = () => { app.toggle(true); return ''; };
        if (c.SlashCommandParser?.addCommandObject && c.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'srpg', callback, returns: 'nothing', helpString: '打开 Tavern-SRPG 战棋面板',
            }));
        } else if (typeof c.registerSlashCommand === 'function') {
            c.registerSlashCommand('srpg', callback, [], '– 打开 Tavern-SRPG 战棋面板', true, true);
        }
    } catch (err) {
        console.warn('[Tavern-SRPG] 注册 /srpg 失败', err);
    }
}

jQuery(async () => {
    app.mount();
    addMenuButton();
    addSettingsDrawer();
    registerCommand();
    app.refreshMessageFolding = installBattleMessageFolding();
    try {
        registerMacros(app);
        registerTool(app);
    } catch (err) {
        console.warn('[Tavern-SRPG] 注册宏 / 工具失败', err);
    }

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => app.onChatChanged());
    // 插件不改写聊天 AI 的回复，也不要求它写任何标记：收到回复时只按设置触发剧情同步（由插件配置的模型在后台读取，不等待）。
    // 重新生成 / 滑动 / 删除时，撤回同步到这一楼造成的战场变化，并作废这一楼之后的同步
    const guard = fn => (...args) => Promise.resolve(fn(...args)).catch(err => console.error('[Tavern-SRPG]', err));
    eventSource.on(eventTypes.MESSAGE_RECEIVED, guard((id, type) => handleStoryMessage(app, Number(id), type)));
    if (eventTypes.MESSAGE_SWIPED) eventSource.on(eventTypes.MESSAGE_SWIPED, guard(id => { revertMessage(app, Number(id)); handleStorySwiped(app, Number(id)); }));
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, guard(() => { handleDeleted(app); handleStoryDeleted(app); }));
    // 生成前再同步一次，确保注入的是最新战况
    if (eventTypes.GENERATION_STARTED) {
        eventSource.on(eventTypes.GENERATION_STARTED, () => app.updateInjection());
    }
    await app.onChatChanged();
    console.log('[Tavern-SRPG] loaded');
});
