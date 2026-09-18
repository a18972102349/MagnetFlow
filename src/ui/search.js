(() => {
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const sourceName = source => source.name || source.id || '未命名来源';

  window.createResourceSearch = ({ api, formatBytes, notify, onResolved }) => {
    let settings = null, settingsPromise = null, settingRevision = 0;
    let items = [], query = '', sourceIds = [], page = 0, hasMore = false, request = null, revision = 0, lastOutcome = 'initial';
    const resolving = new Set(), updatingSources = new Set();
    let addingSource = false;
    const setStatus = message => { $('#resource-search-status').textContent = message; };
    const setSourceError = message => { $('#search-source-error').textContent = message; };

    function renderControls() {
      const searching = Boolean(request);
      $('#submit-resource-search').disabled = searching;
      $('#submit-resource-search').textContent = searching && !page ? '搜索中…' : '搜索';
      $('#cancel-resource-search').hidden = !searching;
      const sameSearch = $('#resource-query').value.trim() === query && $('#resource-source').value === (sourceIds[0] || '');
      $('#load-more-results').hidden = !hasMore || !sameSearch;
      $('#load-more-results').disabled = searching;
      $('#load-more-results').textContent = searching && page ? '正在加载…' : '加载更多';
      $('#resource-results').setAttribute('aria-busy', String(searching));
      $('#resource-result-count').textContent = items.length ? `${items.length} 条结果` : '';
      $('#resource-results-note').hidden = !items.length;
    }

    function renderResults() {
      $('#resource-results').innerHTML = items.map(item => {
        const size = Number.isFinite(item.size) && item.size >= 0 ? formatBytes(item.size) : '大小未知';
        const seeders = Number.isFinite(item.seeders) && item.seeders >= 0 ? `报告做种 ${item.seeders}` : '做种数未知';
        const date = item.date && Number.isFinite(Date.parse(item.date)) ? new Date(item.date).toLocaleDateString('zh-CN') : '';
        return `<article class="resource-result" data-result-id="${escape(item.id)}"><div class="resource-result-info"><h2>${escape(item.title || '未命名资源')}</h2><div class="resource-result-meta"><span class="resource-result-source">${escape((item.sources || []).join(' · ') || '来源未知')}</span><span>${size}</span><span>${seeders}</span>${date ? `<span>${escape(date)}</span>` : ''}${item.license ? `<span>来源标注许可：${escape(item.license)}</span>` : ''}</div>${item.description ? `<p class="resource-result-note">${escape(item.description)}</p>` : ''}</div><button class="button secondary" data-resolve-result="${escape(item.id)}" ${resolving.has(item.id) ? 'disabled' : ''}>${resolving.has(item.id) ? '正在解析…' : '解析文件'}</button></article>`;
      }).join('');
      $('#resource-search-empty').hidden = items.length > 0 || Boolean(request);
      if (!items.length && query) {
        const title = lastOutcome === 'cancelled' ? '搜索已取消' : lastOutcome === 'error' ? '搜索暂未完成' : lastOutcome === 'settings-changed' ? '搜索来源已更新' : '没有可显示的结果';
        $('#resource-search-empty').innerHTML = `<span class="resource-empty-icon"><svg><use href="#i-search"/></svg></span><h2>${title}</h2><p>可尝试更简短的关键词、切换来源，或检查自定义接口设置。</p>`;
      }
      renderControls();
    }

    function renderSourceNotices(sources = []) {
      const notices = sources.filter(source => source.status === 'error' || source.message);
      $('#resource-source-notices').hidden = !notices.length;
      $('#resource-source-notices').classList.toggle('neutral', !notices.some(source => source.status === 'error'));
      $('#resource-source-notices').innerHTML = notices.map(source => `<p class="${source.status === 'error' ? 'source-notice-error' : 'source-notice-info'}"><strong>${escape(sourceName(source))}</strong>：${escape(source.message || '暂时无法取得结果，可稍后重试。')}</p>`).join('');
    }

    function mergeResults(incoming = []) {
      const indexes = new Map(items.map((item, index) => [item.id, index]));
      for (const item of incoming) {
        if (!item?.id) continue;
        if (indexes.has(item.id)) items[indexes.get(item.id)] = item;
        else { indexes.set(item.id, items.length); items.push(item); }
      }
    }

    function renderSettings() {
      const sources = settings?.sources || [];
      const selection = $('#resource-source').value;
      $('#resource-source').innerHTML = '<option value="">全部启用来源</option>' + sources.filter(source => source.enabled).map(source => `<option value="${escape(source.id)}">${escape(sourceName(source))}</option>`).join('');
      if (sources.some(source => source.enabled && source.id === selection)) $('#resource-source').value = selection;
      $('#search-source-settings').innerHTML = sources.length ? sources.map(source => `<div class="search-source-setting"><label><input type="checkbox" data-search-source-toggle="${escape(source.id)}" ${source.enabled ? 'checked' : ''} ${updatingSources.has(source.id) ? 'disabled' : ''} aria-label="启用 ${escape(sourceName(source))}"><span class="search-source-description"><strong>${escape(sourceName(source))}</strong><small>${escape(source.description || (source.type === 'builtin' ? '内置搜索来源' : source.url || '自定义 Torznab 接口'))}${source.type !== 'builtin' ? ` · ${source.hasApiKey ? '已保存密钥' : '未设置密钥'}` : ''}</small></span></label><span class="search-source-tag">${source.type === 'builtin' ? '内置' : 'Torznab'}</span>${source.type !== 'builtin' ? `<button class="text-button" data-remove-search-source="${escape(source.id)}" ${updatingSources.has(source.id) ? 'disabled' : ''}>删除</button>` : ''}</div>`).join('') : '<p class="hint">尚无搜索来源，可以添加 Torznab 接口。</p>';
    }

    function applySettingsUpdate(value) {
      settings = value;
      // The backend invalidates result handles when source settings change.
      // Clear matching UI rows so users cannot click an expired result handle.
      revision++; request = null; items = []; page = 0; hasMore = false; lastOutcome = 'settings-changed';
      renderSourceNotices(); renderSettings(); renderResults();
      setStatus('来源设置已更新，请重新搜索。');
    }

    async function loadSettings(force = false) {
      if (settings && !force) return settings;
      if (settingsPromise) return settingsPromise;
      const current = settingRevision;
      settingsPromise = (async () => {
        if (typeof api.searchSettings !== 'function') throw new Error('搜索组件尚未就绪，请重新启动应用。');
        const result = await api.searchSettings();
        if (current === settingRevision) { settings = result; renderSettings(); }
        return settings;
      })();
      try { return await settingsPromise; } finally { settingsPromise = null; }
    }

    async function cancel() {
      if (!request) return;
      const cancelled = request;
      request = null; revision++;
      lastOutcome = 'cancelled';
      setStatus(items.length ? `搜索已取消，保留已取得的 ${items.length} 条结果。` : '搜索已取消，可以修改关键词后重试。');
      renderResults();
      try { await api.cancelResourceSearch(cancelled.id); } catch (error) { notify(error.message || '取消请求未能送达，已忽略此次搜索的后续结果。'); }
    }

    async function search(loadMore = false) {
      const nextQuery = $('#resource-query').value.trim();
      if (!nextQuery) { $('#resource-query').focus(); setStatus('请输入要搜索的关键词。'); return; }
      if (request) return;
      const searchRevision = ++revision;
      let current;
      try { current = await loadSettings(); } catch (error) { setStatus(error.message); return; }
      if (searchRevision !== revision) return;
      if (!(current?.sources || []).some(source => source.enabled)) {
        setStatus('请先启用至少一个搜索来源。'); $('#search-sources-panel').open = true; return;
      }
      if (!loadMore) {
        query = nextQuery;
        sourceIds = $('#resource-source').value ? [$('#resource-source').value] : [];
        page = 0; items = []; hasMore = false; renderSourceNotices();
      }
      const requestId = crypto.randomUUID();
      const nextPage = page + 1;
      request = { id: requestId, revision: searchRevision };
      lastOutcome = 'loading';
      setStatus(loadMore ? '正在查找更多结果…' : '正在并行查询所选来源…');
      renderResults();
      try {
        const result = await api.searchResources({ query, sourceIds, page: nextPage, requestId });
        if (request?.id !== requestId || searchRevision !== revision) return;
        if (result.cancelled) { lastOutcome = 'cancelled'; setStatus('搜索已取消。'); return; }
        mergeResults(result.items || []);
        page = nextPage; hasMore = Boolean(result.hasMore);
        lastOutcome = 'complete';
        renderSourceNotices(result.sources || []);
        const failures = (result.sources || []).filter(source => source.status === 'error').length;
        setStatus(items.length ? `已找到 ${items.length} 条结果${failures ? `，${failures} 个来源暂未返回结果。` : '。请选择资源解析文件。'}` : failures ? '部分来源未能响应，其余来源没有匹配结果。可调整关键词或稍后重试。' : '没有找到匹配结果，可换一个关键词或搜索来源。');
      } catch (error) {
        if (request?.id === requestId && searchRevision === revision) { lastOutcome = 'error'; setStatus(error.message || '搜索失败，请稍后重试。'); }
      } finally {
        if (request?.id === requestId) { request = null; renderResults(); }
      }
    }

    $('#resource-search-form').onsubmit = event => { event.preventDefault(); search(); };
    api.onSearchProgress?.(progress => {
      if (!request || progress.requestId !== request.id) return;
      mergeResults(progress.items || []);
      renderSourceNotices(progress.sources || []);
      const pending = Number.isFinite(progress.pending) ? Math.max(0, progress.pending) : 0;
      setStatus(pending ? `已返回 ${items.length} 条结果，仍在查询 ${pending} 个来源…` : `已返回 ${items.length} 条结果，正在整理…`);
      renderResults();
    });
    $('#resource-query').oninput = renderControls;
    $('#resource-source').onchange = renderControls;
    $('#cancel-resource-search').onclick = cancel;
    $('#load-more-results').onclick = () => search(true);
    $('#manage-search-sources').onclick = () => { $('#search-sources-panel').open = true; $('#search-sources-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    $('#resource-results').onclick = async event => {
      const button = event.target.closest('[data-resolve-result]');
      if (!button) return;
      const id = button.dataset.resolveResult;
      if (resolving.has(id) || !items.some(item => item.id === id)) return;
      resolving.add(id); renderResults();
      try { const result = await api.addSearchResult(id); await onResolved(result); }
      catch (error) { notify(error.message || '暂时无法解析此资源。'); }
      finally { resolving.delete(id); renderResults(); }
    };
    $('#search-source-settings').onchange = async event => {
      const input = event.target.closest('[data-search-source-toggle]');
      if (!input) return;
      const id = input.dataset.searchSourceToggle, enabled = input.checked;
      if (updatingSources.has(id)) return;
      updatingSources.add(id); renderSettings(); setSourceError('');
      try { settingRevision++; applySettingsUpdate(await api.saveSearchSource({ id, enabled })); }
      catch (error) { setSourceError(error.message || '来源设置未保存。'); }
      finally { updatingSources.delete(id); renderSettings(); }
    };
    $('#search-source-settings').onclick = async event => {
      const button = event.target.closest('[data-remove-search-source]');
      if (!button) return;
      const id = button.dataset.removeSearchSource;
      if (updatingSources.has(id)) return;
      updatingSources.add(id); renderSettings(); setSourceError('');
      try { settingRevision++; applySettingsUpdate(await api.removeSearchSource(id)); notify('搜索来源已删除。'); }
      catch (error) { setSourceError(error.message || '来源未能删除。'); }
      finally { updatingSources.delete(id); renderSettings(); }
    };
    $('#add-search-source-form').onsubmit = async event => {
      event.preventDefault();
      if (addingSource) return;
      addingSource = true; $('#save-search-source').disabled = true; setSourceError('');
      try {
        const name = $('#search-source-name').value.trim(), url = $('#search-source-url').value.trim(), apiKey = $('#search-source-token').value;
        settingRevision++; const updated = await api.saveSearchSource({ name, url, apiKey, enabled: true });
        $('#search-source-token').value = ''; $('#search-source-name').value = ''; $('#search-source-url').value = '';
        applySettingsUpdate(updated); notify('搜索来源已保存，密钥不会在界面回显。');
      } catch (error) { setSourceError(error.message || '来源未能保存。'); }
      finally { addingSource = false; $('#save-search-source').disabled = false; }
    };
    return {
      open() { loadSettings().catch(error => { setStatus(error.message); setSourceError(error.message); }); },
      cancel
    };
  };
})();
