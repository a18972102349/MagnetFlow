const api = window.magnetFlow;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const labels = { metadata: '获取资源信息', checking: '校验已有文件', selecting: '待选择文件', downloading: '下载中', paused: '已暂停', complete: '已完成 · 做种中', error: '任务异常' };
let state = { tasks: [], settings: {} }, nav = 'all', filter = 'all', selectedId = null, player = null, removingId = null, draft = new Set(), draftKey = '', toastTimer, busy = false;
let pendingPlay = null, playRevision = 0, pumping = false, retryTimer = null;
const autoplayAfterSelection = new Set();
let savingSelection = null;
let changingDownloadLimit = false;
const sourceLabels = { cache: '本地缓存', torrent: '种子文件', network: '网络解析' };
const connectionLabels = { preparing_network: '准备下载网络', finding_peers: '寻找资源节点', connecting_peers: '连接资源节点', fetching_metadata: '获取文件信息', awaiting_selection: '请选择要下载的文件', fetching_pieces: '等待可用片段', downloading: '正在接收数据', paused: '任务已暂停', error: '连接出现异常', complete: '所选文件已完成' };
const discoveryLabels = { dht: 'DHT', tracker: 'Tracker', pex: 'PEX', lsd: '局域网', cache: '近期节点' };
const hasKnownSize = task => Number.isFinite(task.length) && task.length > 0;
const taskProgress = task => hasKnownSize(task) ? Math.max(0, Math.min(1, Number(task.progress) || 0, (Number(task.downloaded) || 0) / task.length)) : 0;
const taskComplete = task => !task.awaitingSelection && hasKnownSize(task) && taskProgress(task) >= 1;
const taskActive = task => !['paused', 'error', 'selecting'].includes(task.status) && !taskComplete(task);
const peerCount = task => Math.max(0, Number(task.peers) || 0);
function connectionState(task) {
  let stage = task.connection?.stage;
  if (!connectionLabels[stage]) {
    stage = task.status === 'paused' ? 'paused' : task.status === 'error' ? 'error' : taskComplete(task) ? 'complete'
      : !task.ready ? peerCount(task) > 0 ? 'fetching_metadata' : 'finding_peers'
        : task.downloadSpeed > 0 ? 'downloading' : peerCount(task) > 0 ? 'fetching_pieces' : 'finding_peers';
  }
  if (stage === 'complete' && !taskComplete(task)) stage = task.ready ? 'fetching_pieces' : 'fetching_metadata';
  const messages = {
    preparing_network: '正在准备节点发现服务，随后查询此链接的资源节点。',
    finding_peers: '尚未连接此资源的节点；可重新寻找节点，或导入对应的种子文件。',
    connecting_peers: '已获得节点线索，正在尝试连接；线索不代表对方可用。',
    fetching_metadata: peerCount(task) > 0 ? '已连接节点，正在请求文件列表；对方仍需提供有效的资源信息。' : '文件信息尚未取得，需要可响应的节点或对应种子文件。',
    awaiting_selection: '文件列表已解析。勾选需要的文件，点击“下载所选文件”后开始传输。',
    fetching_pieces: hasKnownSize(task) ? '文件列表已就绪，正在等待节点提供所选文件的片段。' : '请在文件列表中勾选要下载的文件并应用选择。',
    downloading: '正在接收所选文件的数据；可选择媒体文件开始缓冲播放。',
    paused: '点击“继续下载”恢复节点连接和数据传输。', error: '可重试任务；详细原因见下方提示。',
    complete: '所选文件已下载完成。'
  };
  return { stage, label: connectionLabels[stage], message: task.connection?.stage === stage && task.connection.message ? String(task.connection.message) : messages[stage], retryable: task.connection?.retryable ?? !['paused', 'complete', 'awaiting_selection'].includes(stage) };
}
const clockTime = seconds => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
function bytes(n = 0) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
function rateHTML(n) { const [v, unit] = bytes(n).split(' '); return `${v} <small>${unit}/s</small>`; }
function eta(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return '等待节点';
  if (seconds < 60) return '不足 1 分钟';
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${(seconds / 3600).toFixed(1)} 小时`;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6500); }
async function action(fn) { try { return await fn(); } catch (err) { toast(err.message); return null; } }
function openAdd(value = '') { $('#magnet-input').value = value; $('#add-error').textContent = ''; $('#dialog-path').textContent = state.settings.downloadDir || ''; $('#add-dialog').showModal(); $('#magnet-input').focus(); }
const resourceSearch = window.createResourceSearch({
  api, formatBytes: bytes, notify: toast,
  onResolved: async result => {
    state = await api.state(); nav = 'all'; selectedId = result.id; draftKey = ''; filter = 'all'; $('#search').value = '';
    document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
    render(); $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(result.duplicate ? '这个资源已在任务列表中。' : '正在解析文件列表。请勾选需要的文件，再确认下载。');
  }
});
function render() {
  const active = state.tasks.filter(taskActive).length;
  const complete = state.tasks.filter(taskComplete).length;
  $('#count-all').textContent = state.tasks.length;
  $('#count-active').textContent = active;
  $('#count-complete').textContent = complete;
  $('#download-speed').innerHTML = rateHTML(state.downloadSpeed);
  $('#upload-speed').innerHTML = rateHTML(state.uploadSpeed);
  $('#active-stat').innerHTML = `${active} <small>个任务</small>`;
  $('#save-path').textContent = state.settings.downloadDir || '';
  $('#save-path').title = state.settings.downloadDir || '';
  $('#settings-path').textContent = state.settings.downloadDir || '';
  $('#settings-player').textContent = state.settings.playerPath || '自动查找标准安装目录中的 VLC';
  const network = state.network || {};
  $('#network-summary').textContent = `DHT 路由 ${network.dhtNodes || 0} 个 · 已连接资源节点 ${network.peers || 0} 个 · ${network.utp ? 'TCP + µTP' : 'TCP'}`;
  $('#network-engine').textContent = network.dhtEnabled && !network.dhtNodes ? (network.bootstrapPending ? '正在重试 DHT 路由 · Tracker 独立查询' : 'DHT 暂无路由 · Tracker 独立查询') : network.restoredDhtNodes ? `已加载 ${network.restoredDhtNodes} 条近期 DHT 路由线索` : '节点发现与种子缓存已启用';
  $('#transcoder-status').textContent = state.media?.available ? '内置 FFmpeg 已就绪，可直接使用兼容播放。' : '未发现内置 FFmpeg，可使用原画播放或外部播放器。';
  $('#fatal').textContent = state.fatal || '';
  $('#fatal').hidden = !state.fatal;
  document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === nav));
  $('#settings-page').hidden = nav !== 'settings';
  $('#resource-search-page').hidden = nav !== 'resource-search';
  $('#downloads-page').hidden = ['settings', 'resource-search'].includes(nav);
  if (['settings', 'resource-search'].includes(nav)) return;
  const query = $('#search').value.trim().toLowerCase();
  const navTasks = state.tasks.filter(t => nav === 'all' || (nav === 'complete' ? taskComplete(t) : taskActive(t)));
  const tasks = navTasks.filter(t => (!query || t.name.toLowerCase().includes(query)) && (filter === 'all' || t.files.some(f => f.media)));
  $('#page-title').innerHTML = `${{ all: '全部任务', active: '正在下载', complete: '已完成' }[nav]}<span>${navTasks.length}</span>`;
  $('#empty-state').hidden = state.tasks.length > 0;
  $('#no-results').hidden = !state.tasks.length || tasks.length > 0;
  const html = tasks.map(t => {
    const connection = connectionState(t), progress = taskProgress(t);
    const status = t.status === 'complete' && !taskComplete(t) ? (t.ready ? 'downloading' : 'metadata') : t.status;
    const sizeLabel = t.awaitingSelection && t.files.length ? `${bytes(t.files.reduce((sum, f) => sum + f.length, 0))} · 待选择` : hasKnownSize(t) ? bytes(t.length) : t.ready && t.files.length ? '未选择文件' : '文件大小待解析';
    return `<article class="task-card ${selectedId === t.id ? 'selected' : ''}" data-task="${t.id}" tabindex="0" role="button" aria-label="查看 ${esc(t.name)} 的文件">
    <div class="task-file-icon">${icon(t.files.some(f => f.media) ? 'play' : 'file')}</div><div class="task-main"><div class="task-name-row"><span class="task-name" title="${esc(t.name)}">${esc(t.name)}</span><span class="status-pill ${status}">${labels[status] || '等待任务状态'}</span>${pendingPlay?.id === t.id ? '<span class="task-stage">等待自动播放</span>' : ''}</div><progress class="task-progress" value="${progress}" max="1" aria-label="${hasKnownSize(t) ? '下载进度' : '文件大小待解析'}"></progress><div class="task-meta"><span>${bytes(t.downloaded)} / ${sizeLabel}</span><span class="task-speed">↓ ${bytes(t.downloadSpeed)}/s</span><span>已连接 ${peerCount(t)} 个节点</span><span>${status === 'downloading' && t.downloadSpeed > 0 ? eta(t.eta) : !['paused', 'complete', 'error'].includes(status) ? `已运行 ${t.elapsedSeconds || 0} 秒` : ''}</span><span class="task-percent">${hasKnownSize(t) ? `${(progress * 100).toFixed(1)}%` : '—'}</span></div><div class="task-connection connection-stage-${connection.stage}"><strong>${connection.label}</strong><span title="${esc(connection.message)}">${esc(connection.message)}</span></div>${t.warning && t.warning !== connection.message ? `<div class="task-warning" title="${esc(t.warning)}">${esc(t.warning)}</div>` : ''}</div><div class="task-actions"><button class="icon-button play-action" data-command="play" title="边下边播" aria-label="播放">${icon('play')}</button><button class="icon-button" data-command="toggle" title="${['paused', 'error'].includes(t.status) ? '继续下载' : '暂停任务'}" aria-label="${['paused', 'error'].includes(t.status) ? '继续下载' : '暂停任务'}">${icon(['paused', 'error'].includes(t.status) ? 'download' : 'pause')}</button><button class="icon-button" data-command="refresh" title="${connection.retryable ? '重新寻找节点' : status === 'paused' ? '请先继续下载' : '当前无需重新查询'}" aria-label="重新寻找节点" ${connection.retryable ? '' : 'disabled'}>${icon('refresh')}</button><button class="icon-button" data-command="folder" title="打开文件夹" aria-label="打开文件夹">${icon('folder')}</button><button class="icon-button" data-command="remove" title="移除任务，保留文件" aria-label="移除任务">${icon('trash')}</button></div></article>`;
  }).join('');
  // Keep focused controls stable when nothing has changed.
  if ($('#task-list').innerHTML !== html) $('#task-list').innerHTML = html;
  renderDetail();
}
function selectTask(id) { if (selectedId !== id) draftKey = ''; selectedId = id; render(); }
function renderDetail() {
  const task = state.tasks.find(t => t.id === selectedId);
  $('#detail').hidden = !task;
  if (!task) return;
  const connection = connectionState(task);
  $('#detail-name').textContent = task.name;
  const key = task.id + ':' + task.files.map(f => `${f.index}/${f.selected}`).join(',');
  if (key !== draftKey) { draft = new Set(task.files.filter(f => f.selected).map(f => f.index)); draftKey = key; }
  const signature = task.id + ':' + task.awaitingSelection + ':' + task.files.map(f => `${f.index}/${f.name}/${f.selected}/${draft.has(f.index)}/${Math.floor(f.progress * 100)}`).join('|') + (task.files.length ? '' : `:${connection.stage}:${connection.message}`);
  if ($('#files').dataset.signature !== signature) {
    $('#files').innerHTML = task.files.length ? task.files.map(f => `<div class="file-row"><input type="checkbox" data-file="${f.index}" ${draft.has(f.index) ? 'checked' : ''} aria-label="下载 ${esc(f.name)}"><div class="file-info"><strong title="${esc(f.path)}">${esc(f.name)}</strong><small>${bytes(f.length)} · ${task.awaitingSelection ? '尚未开始下载' : `${(f.progress * 100).toFixed(0)}%`}</small></div>${f.media ? `<button class="icon-button" data-play-file="${f.index}" title="${task.awaitingSelection ? '确认下载后即可播放' : !f.selected ? '请先应用文件选择' : '播放此文件'}" aria-label="播放 ${esc(f.name)}" ${task.awaitingSelection || !f.selected ? 'disabled' : ''}>${icon('play')}</button>` : ''}</div>`).join('') : `<p class="hint empty-files-hint"><strong>${connection.label}</strong><br>${esc(connection.message)}<br>取得资源信息后，文件列表才会出现。</p>`;
    $('#files').dataset.signature = signature;
  }
  const chosen = task.files.filter(f => draft.has(f.index));
  $('#selection-note').hidden = !task.awaitingSelection;
  $('#selection-note').textContent = task.files.length ? '解析完成。请勾选需要的文件，再开始下载。' : '正在解析文件列表，确认选择后才会开始下载内容。';
  $('#selection-summary').textContent = `已选 ${chosen.length} / ${task.files.length} 个文件 · ${bytes(chosen.reduce((sum, f) => sum + f.length, 0))}`;
  $('#selection-actions').hidden = !task.files.length;
  $('#selection-autoplay-row').hidden = !task.awaitingSelection || !task.files.length;
  $('#selection-autoplay').checked = autoplayAfterSelection.has(task.id);
  const unchanged = task.files.every(f => f.selected === draft.has(f.index));
  $('#save-selection').disabled = !task.files.length || !chosen.length || savingSelection === task.id || (!task.awaitingSelection && unchanged);
  $('#save-selection').textContent = savingSelection === task.id ? '正在应用…' : task.awaitingSelection ? '下载所选文件' : '应用文件选择';
  $('#save-selection').className = task.awaitingSelection ? 'button primary' : 'button secondary';
  $('#external-player').disabled = Boolean(task.awaitingSelection);
  $('#detail-hint').textContent = task.warning || `保存于 ${task.path}`;
  renderSpeedDiagnosis(task);
  $('#metadata-timing').textContent = task.metadataMs !== null && task.metadataMs !== undefined ? `${sourceLabels[task.metadataSource] || '解析'} · ${(task.metadataMs / 1000).toFixed(2)} 秒` : `${connection.label} · ${task.elapsedSeconds || 0} 秒`;
  const sourceDescription = Object.entries(task.sources || {}).map(([name, count]) => `${discoveryLabels[name] || name}: ${Math.max(0, Number(count) || 0)}`).join(' · ') || '尚未收到';
  $('#connection-info').innerHTML = `<div class="connection-current connection-stage-${connection.stage}"><strong>${connection.label}</strong><p>${esc(connection.message)}</p></div><div class="connection-row"><span>已建立连接的资源节点</span><span>${peerCount(task)} 个</span></div><div class="connection-row connection-sources"><span>节点线索（可重复）</span><span>${esc(sourceDescription)}</span></div><div class="connection-row"><span>重新查询次数</span><span>${task.discoveryAttempts || 0}</span></div><p class="connection-explanation">DHT 节点负责查找资源；节点线索和 Tracker 报告的做种数均不等于已连接节点，也不能保证资源可下载。</p>` + (task.trackers || []).map(tracker => `<div class="connection-row tracker-row"><span title="${esc(tracker.url)}">${esc(tracker.url)}</span><span class="connection-${tracker.status === 'ok' ? 'good' : tracker.status === 'error' ? 'error' : 'waiting'}">${tracker.status === 'ok' ? `服务已响应${Number.isFinite(tracker.seeds) ? `<small>报告 ${Math.max(0, tracker.seeds)} 个做种 · 未验证</small>` : ''}` : tracker.status === 'error' ? '服务暂未连通' : '等待服务响应'}</span></div>`).join('');
  $('#reannounce-detail').disabled = !connection.retryable;
  $('#reannounce-detail').title = connection.retryable ? '重新查询可用节点' : task.status === 'paused' ? '请先继续下载' : '当前无需重新查询';
  if (pendingPlay?.id === task.id) {
    $('#player-status').textContent = task.status === 'checking' ? '正在校验，完成后自动播放' : `${connection.label} · 等待自动播放`;
    $('#player-hint').textContent = connection.message;
    $('#cancel-pending').hidden = false;
  }
}
function renderSpeedDiagnosis(task) {
  let panel = $('#speed-diagnosis');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'speed-diagnosis'; panel.className = 'speed-diagnosis';
    panel.setAttribute('aria-label', '速度诊断'); $('#detail-hint').after(panel);
    panel.onclick = event => {
      if (!event.target.closest('#remove-download-limit') || changingDownloadLimit) return;
      action(async () => {
        changingDownloadLimit = true; renderDetail();
        try { await api.limits({ downloadLimit: 0 }); state = await api.state(); toast('已取消全局下载限速，实际速度仍取决于可用节点与网络。'); }
        finally { changingDownloadLimit = false; renderDetail(); }
      });
    };
  }
  const diagnosis = task.speedDiagnosis;
  panel.hidden = !diagnosis;
  if (!diagnosis) return;
  const metrics = diagnosis.metrics || {};
  const count = value => Number.isFinite(value) ? Math.max(0, value) : 0;
  const limit = Number.isFinite(metrics.downloadLimitBps) ? Math.max(0, metrics.downloadLimitBps) : 0;
  panel.innerHTML = `<strong>速度诊断 · ${esc(diagnosis.title || '当前传输状态')}</strong><p>${esc(diagnosis.message || '')}</p><div class="connection-row"><span>正在传数据 / 已连接节点</span><span>${count(metrics.activeDataPeers)} / ${count(metrics.connectedPeers)} 个</span></div><div class="connection-row"><span>全局下载限速</span><span>${limit > 0 ? `${bytes(limit)}/s · 所有任务共享` : '不限速'}</span></div>${metrics.playbackPrioritized ? '<p>当前正在优先缓冲播放位置附近的片段。</p>' : ''}${limit > 0 ? `<button class="text-button" id="remove-download-limit" ${changingDownloadLimit ? 'disabled' : ''}>${changingDownloadLimit ? '正在取消…' : '取消下载限速'}</button>` : ''}`;
}
function stopPlayer(message = '选择媒体文件开始') {
  const old = player;
  player = null; pendingPlay = null; playRevision++; clearTimeout(retryTimer);
  $('#video').pause(); $('#video').removeAttribute('src'); $('#video').load();
  if (old) api.cancelPlayback?.(old.id).catch(() => {});
  $('#video-placeholder').hidden = false; $('#player-status').textContent = message; $('#retry-player').hidden = true;
  $('#cancel-pending').hidden = true; $('#compat-seek').hidden = true; $('#buffer-status').textContent = '等待播放';
  $('#playing-name').textContent = 'MP4 · WebM · 音频';
}
async function playFile(id, index = null, options = {}) {
  const current = state.tasks.find(t => t.id === id);
  if (current?.awaitingSelection) {
    selectTask(id);
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('请先勾选需要的文件，并点击“下载所选文件”。');
    return;
  }
  clearTimeout(retryTimer);
  const revision = ++playRevision;
  pendingPlay = { id, index, mode: options.mode || $('#play-mode').value, startSeconds: options.startSeconds || 0, attempts: options.attempts || 0, revision };
  selectTask(id);
  const task = state.tasks.find(t => t.id === id);
  if (task?.status === 'paused' || task?.status === 'error') await api.resume(id);
  await pumpPlayback();
}
async function pumpPlayback() {
  if (!pendingPlay || pumping) return;
  const request = pendingPlay, task = state.tasks.find(t => t.id === request.id);
  if (!task?.ready || task.awaitingSelection) return;
  const file = request.index === null ? task.files.filter(f => f.media && f.selected).sort((a, b) => b.length - a.length)[0] : task.files[request.index];
  if (!file?.media || !file.selected) { pendingPlay = null; $('#cancel-pending').hidden = true; toast('没有可播放且已勾选的媒体文件。'); return; }
  pumping = true;
  try {
    const stream = await api.stream(request.id, file.index, { mode: request.mode, startSeconds: request.startSeconds });
    if (request.revision !== playRevision) return;
    pendingPlay = null;
    player = { ...request, index: file.index, actualMode: stream.mode || 'direct', base: stream.mode === 'compat' ? request.startSeconds : 0 };
    $('#cancel-pending').hidden = true; $('#video-placeholder').hidden = true; $('#retry-player').hidden = true;
    $('#compat-seek').hidden = player.actualMode !== 'compat';
    $('#player-status').textContent = player.actualMode === 'compat' ? '正在转换并缓冲…' : '正在缓冲…';
    $('#playing-name').textContent = stream.name;
    $('#player-hint').textContent = player.actualMode === 'compat' ? '在本机转换格式后播放。可按秒跳转，跳转后会重新缓冲。' : '已优先缓冲播放位置附近的片段，拖动进度条可按需获取新片段。';
    const video = $('#video');
    video.src = stream.url;
    if (player.actualMode === 'direct' && request.startSeconds > 0) video.addEventListener('loadedmetadata', () => { if (player?.revision === request.revision) video.currentTime = request.startSeconds; }, { once: true });
    video.play().catch(err => { if (err.name === 'NotAllowedError') toast('点击视频中的播放按钮即可开始。'); });
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    if (request.revision === playRevision) { pendingPlay = null; $('#cancel-pending').hidden = true; $('#player-status').textContent = '暂时无法播放'; toast(error.message); }
  } finally { pumping = false; }
}
const playTask = id => playFile(id);
$('#new-task').onclick = () => openAdd(); $('#empty-add').onclick = () => openAdd();
$('#close-add').onclick = $('#cancel-add').onclick = () => $('#add-dialog').close();
$('#demo').onclick = () => openAdd('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent');
$('#add-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; $('#submit-add').disabled = true; $('#add-error').textContent = '';
  try {
    const result = await api.add($('#magnet-input').value);
    if (!result.duplicate && $('#auto-play').checked) autoplayAfterSelection.add(result.id);
    state = await api.state();
    $('#add-dialog').close(); nav = 'all'; selectedId = result.id; draftKey = ''; filter = 'all'; $('#search').value = '';
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    render(); $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(result.duplicate ? '这个任务已经在列表中。' : '正在解析文件列表。勾选并确认后才开始下载。');
  }
  catch (err) { $('#add-error').textContent = err.message; }
  finally { busy = false; $('#submit-add').disabled = false; }
};
$('#import-torrent').onclick = () => action(async () => { const result = await api.importTorrent(); if (result) { state = await api.state(); nav = 'all'; filter = 'all'; $('#search').value = ''; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all')); selectTask(result.id); $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); toast(result.duplicate ? '此种子已在任务列表中。' : '种子已解析。请勾选需要的文件并确认下载。'); } });
$('#open-downloads').onclick = () => action(() => api.folder());
$('#pause-all').onclick = () => action(async () => { for (const task of state.tasks.filter(t => !['paused', 'error'].includes(t.status))) await api.pause(task.id); toast('所有任务已暂停。'); });
document.querySelectorAll('[data-nav]').forEach(button => button.onclick = () => {
  nav = button.dataset.nav;
  if (nav === 'settings') { $('#download-limit').value = state.settings.downloadLimit; $('#upload-limit').value = state.settings.uploadLimit; $('#max-conns').value = state.settings.maxConns || 160; $('#extra-trackers').value = (state.settings.extraTrackers || []).join('\n'); $('#public-trackers').checked = state.settings.usePublicTrackers !== false; }
  render();
  if (nav === 'resource-search') resourceSearch.open();
});
document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button)); render(); });
$('#search').oninput = render;
$('#task-list').onclick = event => action(async () => {
  const card = event.target.closest('[data-task]'); if (!card) return;
  const id = card.dataset.task, command = event.target.closest('[data-command]')?.dataset.command;
  if (!command) { selectTask(id); return; }
  if (command === 'play') await playTask(id);
  if (command === 'folder') await api.folder(id);
  if (command === 'refresh') { const result = await api.reannounce(id); toast(result.message); }
  if (command === 'toggle') { const task = state.tasks.find(t => t.id === id); await (['paused', 'error'].includes(task.status) ? api.resume(id) : api.pause(id)); }
  if (command === 'remove') { removingId = id; $('#remove-name').textContent = state.tasks.find(t => t.id === id).name; $('#remove-dialog').showModal(); }
});
$('#task-list').onkeydown = event => { if (event.target.matches('[data-task]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectTask(event.target.dataset.task); } };
$('#cancel-remove').onclick = () => $('#remove-dialog').close();
$('#confirm-remove').onclick = () => action(async () => { await api.remove(removingId); autoplayAfterSelection.delete(removingId); $('#remove-dialog').close(); if (selectedId === removingId) selectedId = null; render(); toast('任务已移除，已下载文件保留在原目录。'); });
$('#close-detail').onclick = () => { selectedId = null; stopPlayer(); render(); };
$('#files').onchange = event => { if (event.target.matches('[data-file]')) { const index = Number(event.target.dataset.file); event.target.checked ? draft.add(index) : draft.delete(index); renderDetail(); } };
$('#files').onclick = event => { const button = event.target.closest('[data-play-file]'); if (button) action(() => playFile(selectedId, Number(button.dataset.playFile))); };
$('#select-all-files').onclick = () => { const task = state.tasks.find(t => t.id === selectedId); draft = new Set(task?.files.map(f => f.index)); renderDetail(); };
$('#clear-files').onclick = () => { draft.clear(); renderDetail(); };
$('#selection-autoplay').onchange = event => { if (selectedId) event.target.checked ? autoplayAfterSelection.add(selectedId) : autoplayAfterSelection.delete(selectedId); };
$('#save-selection').onclick = () => action(async () => {
  const id = selectedId, task = state.tasks.find(t => t.id === id);
  if (!task || !draft.size || savingSelection) return;
  const firstSelection = task.awaitingSelection;
  const shouldPlay = firstSelection && autoplayAfterSelection.has(id);
  const indexes = [...draft];
  savingSelection = id; renderDetail();
  try {
    await api.select(id, indexes);
    state = await api.state(); autoplayAfterSelection.delete(id); render();
    toast(firstSelection ? `已开始下载所选的 ${indexes.length} 个文件。` : '文件选择已更新。');
    if (shouldPlay && state.tasks.find(t => t.id === id)?.files.some(f => f.media && f.selected)) await playTask(id);
  } finally { savingSelection = null; renderDetail(); }
});
$('#external-player').onclick = () => action(async () => {
  const task = state.tasks.find(t => t.id === selectedId);
  const file = task?.files.filter(f => f.media && f.selected).sort((a, b) => b.length - a.length)[0];
  const target = player?.id === selectedId ? player : file ? { id: selectedId, index: file.index } : null;
  if (!target) throw new Error('请先选择一个媒体文件。');
  await api.externalPlayer(target.id, target.index); $('#video').pause(); toast('已在外部播放器打开本地视频流。请保持磁流运行。');
});
$('#retry-player').onclick = () => { if (player) action(() => playFile(player.id, player.index, { mode: player.mode, startSeconds: player.base + $('#video').currentTime })); };
function updateFullscreenControl() {
  const full = Boolean(document.fullscreenElement);
  $('#fullscreen-player').disabled = !$('#video').currentSrc;
  $('#fullscreen-player').textContent = full ? '退出全屏' : '全屏';
  $('#fullscreen-player').setAttribute('aria-label', full ? '退出视频全屏' : '视频全屏');
}
$('#fullscreen-player').onclick = () => action(async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('#video').currentSrc) await $('#video').requestFullscreen();
  } catch { throw new Error('暂时无法进入全屏，请重新点击全屏按钮。'); }
});
document.addEventListener('fullscreenchange', updateFullscreenControl);
for (const event of ['loadedmetadata', 'emptied']) $('#video').addEventListener(event, updateFullscreenControl);
for (const [event, text] of [['waiting', '正在缓冲…'], ['stalled', '等待资源片段…'], ['seeking', '跳转并缓冲…'], ['playing', '正在播放'], ['pause', '播放已暂停'], ['ended', '播放结束']]) $('#video').addEventListener(event, () => { if (player) $('#player-status').textContent = text; });
$('#video').addEventListener('error', () => {
  if (!player) return;
  const failure = { ...player }, code = $('#video').error?.code;
  $('#player-status').textContent = '暂时无法播放'; $('#retry-player').hidden = false;
  const nextMode = failure.actualMode === 'direct' && failure.mode === 'auto' && [3, 4].includes(code) && state.media?.available ? 'compat' : failure.actualMode;
  if (failure.attempts < 2 && (nextMode !== failure.actualMode || code === 2)) {
    $('#player-hint').textContent = nextMode === 'compat' ? '正在切换到内置兼容播放…' : '连接中断，稍后自动重新缓冲…';
    retryTimer = setTimeout(() => { if (player?.revision === failure.revision) action(() => playFile(failure.id, failure.index, { mode: nextMode, startSeconds: failure.base + $('#video').currentTime, attempts: failure.attempts + 1 })); }, 1500 * (failure.attempts + 1));
  } else $('#player-hint').textContent = '暂时无法解码或资源缓冲中断。可切换兼容播放、重试，或使用 VLC / mpv；任务会继续下载。';
});
$('#video').addEventListener('timeupdate', () => {
  if (!player) return;
  const video = $('#video'); let buffered = 0;
  for (let i = 0; i < video.buffered.length; i++) if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) buffered = video.buffered.end(i) - video.currentTime;
  $('#buffer-status').textContent = `已缓冲 ${buffered.toFixed(1)} 秒`;
  $('#play-clock').textContent = clockTime(player.base + video.currentTime);
});
$('#play-mode').onchange = () => { if (player) action(() => playFile(player.id, player.index, { mode: $('#play-mode').value, startSeconds: player.base + $('#video').currentTime })); };
$('#jump-player').onclick = () => action(async () => { const seconds = Number($('#seek-seconds').value); if (!Number.isFinite(seconds) || seconds < 0 || seconds > 604800) throw new Error('请输入有效的跳转秒数。'); if (player) await playFile(player.id, player.index, { mode: 'compat', startSeconds: seconds }); });
$('#cancel-pending').onclick = () => { pendingPlay = null; playRevision++; $('#cancel-pending').hidden = true; $('#player-status').textContent = '已取消等待，下载继续'; render(); };
$('#reannounce-detail').onclick = () => action(async () => { if (selectedId) toast((await api.reannounce(selectedId)).message); });
$('#save-network').onclick = () => action(async () => { await api.networkSettings({ extraTrackers: $('#extra-trackers').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean), usePublicTrackers: $('#public-trackers').checked, maxConns: Number($('#max-conns').value) }); toast('网络设置已保存。Tracker 变更在新建或继续任务时生效。'); });
$('#choose-directory').onclick = () => action(() => api.chooseDirectory());
$('#choose-player').onclick = () => action(() => api.choosePlayer());
$('#save-limits').onclick = () => action(async () => { await api.limits({ downloadLimit: Number($('#download-limit').value), uploadLimit: Number($('#upload-limit').value) }); toast('传输限速已保存。'); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!document.querySelector('dialog[open]')) openAdd(); } });
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => { event.preventDefault(); const text = event.dataTransfer.getData('text/plain').trim(); if (text.startsWith('magnet:') && !document.querySelector('dialog[open]')) openAdd(text); else if (event.dataTransfer.files.length) toast('请点击“导入种子”，选择 .torrent 文件。'); });
api.onUpdate(value => { state = value; render(); pumpPlayback(); });
api.onNotice(toast);
api.onInvalidate(id => { if (player?.id === id || pendingPlay?.id === id) stopPlayer('任务已变更，请重新播放'); });
api.state().then(value => { state = value; render(); for (const notice of value.notices || []) toast(notice); }).catch(err => toast(err.message));
