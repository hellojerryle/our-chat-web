'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 70;
  const MAX_FILE_SIZE = 150 * 1024 * 1024;
  const DB_NAME = 'our-chat-private-v1';
  const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|gif|webp|avif)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|aac|webm|flac|x-m4a)|video\/(?:mp4|webm|quicktime)|application\/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}|text\/plain);base64,[A-Za-z0-9+/\s]*={0,2}$/;
  const MEDIA_TYPES = new Set(['image','audio','video','file']);
  const OLD_MEDIA_PLACEHOLDER = /^(?:\[(?:图片|语音|音频|视频|文件|表情)\]\s*)?[（(]?(?:图片|语音|音频|视频|文件|表情)?附件(?:尚)?未导入[）)]?$/;
  const EXAMPLE = {
    schemaVersion: 1, title: '我们的聊天',
    participants: {husband: {name: '我的先生', avatar: ''}, wife: {name: '另一半', avatar: ''}},
    messages: [
      {id: 'demo-1', sender: 'husband', timestamp: '2026-10-10T10:00:00+08:00', type: 'system', text: '以下仅为功能演示，尚未导入真实记录'},
      {id: 'demo-2', sender: 'husband', timestamp: '2026-10-10T10:01:00+08:00', type: 'text', text: '这是一条演示消息。导入后，这里会显示我们真实的聊天。'},
      {id: 'demo-3', sender: 'wife', timestamp: '2026-10-10T10:02:00+08:00', type: 'text', text: '现在是我的视角，我发出的消息在右边。'},
      {id: 'demo-4', sender: 'husband', timestamp: '2026-10-10T10:03:00+08:00', type: 'text', text: '点右上角，可以搜索内容或按日期翻看。'}
    ], assets: {}
  };
  let data = validatePackage(EXAMPLE);
  let isDemo = true;
  let viewpoint = 'wife';
  let filtered = data.messages;
  let indexedData = null;
  let dateIndex = new Map();
  let recordDays = [];
  let missingRawTypeCount = 0;
  let calendarMonth = '';
  let selectedDate = '';
  let searchMatches = [];
  let searchPage = 0;
  let searchType = 'all';
  let searchQuery = '';
  let searchGeneration = 0;
  let searchReturnView = 'details';
  let settingsReturnView = 'list';
  let chatScrollTop = 0;
  let contextTargetId = '';
  let contextTimer;
  let activeAudio = null;
  let pageEnd = data.messages.length;
  let dbPromise;
  let searchTimer;
  let toastTimer;
  let installPrompt;
  let currentView = 'list';
  let lastChangeToken = '';
  let renderVersion = 0;
  const mediaUrls = new Set();
  let mediaQueue = [];
  let mediaImportController = null;
  let videoPreviewError = null;
  let videoPreviewUrl = '';
  const mediaStore = OurChatMedia.createIndexedDBStore(openDatabase);
  const importMediaPack = OurChatMedia.createImporter(mediaStore);
  const recordsChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('our-chat-records') : null;
  try { viewpoint = localStorage.getItem('our-chat-viewpoint') === 'husband' ? 'husband' : 'wife'; } catch (_) {}

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function safeDataUrl(value, kind) {
    if (typeof value !== 'string' || !DATA_URL_PATTERN.test(value)) return '';
    return kind && !value.startsWith(`data:${kind}/`) ? '' : value;
  }
  function safeName(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.slice(0, 200) : fallback;
  }
  function safeFileName(value) {
    return (typeof value === 'string' ? value : '').replace(/[\\/\x00-\x1f:*?"<>|]/g,'_').trim().slice(0,180) || '聊天附件';
  }
  function validatePackage(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1) throw new Error('文件格式不符合要求：schemaVersion 必须为 1。');
    if (!input.participants || !input.participants.husband || !input.participants.wife) throw new Error('文件缺少双方的信息（participants）。');
    if (!Array.isArray(input.messages) || input.messages.length > 500000) throw new Error('messages 必须是消息数组，最多支持 50 万条。');
    const assets = Object.create(null);
    if (input.assets != null && (typeof input.assets !== 'object' || Array.isArray(input.assets))) throw new Error('assets 必须是附件映射表。');
    for (const [key, value] of Object.entries(input.assets || {})) {
      if (!key || key.length > 500 || /^(?:https?:|file:|javascript:|\/)/i.test(key) || !safeDataUrl(value)) throw new Error(`附件格式不支持：${key.slice(0, 80)}。附件应为文件内的图片、音频或视频 data URL。`);
      assets[key] = value;
    }
    const participants = {};
    for (const role of ['husband', 'wife']) {
      const item = input.participants[role];
      if (typeof item !== 'object' || Array.isArray(item)) throw new Error('双方信息格式不正确。');
      participants[role] = {name: safeName(item.name, role === 'wife' ? '另一半' : '我的先生'), avatar: typeof item.avatar === 'string' ? item.avatar : ''};
      const avatar = participants[role].avatar;
      if (avatar && !(safeDataUrl(avatar, 'image') || safeDataUrl(assets[avatar], 'image'))) participants[role].avatar = '';
    }
    const seenIds = new Set();
    const kinds = new Set(['text', 'image', 'audio', 'video', 'file', 'system']);
    const messages = input.messages.map((message, index) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(`第 ${index + 1} 条消息格式不正确。`);
      if (!['husband', 'wife'].includes(message.sender)) throw new Error(`第 ${index + 1} 条消息的 sender 必须为 husband 或 wife。`);
      if (!kinds.has(message.type)) throw new Error(`第 ${index + 1} 条消息类型不支持。`);
      const value = message.timestamp;
      if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new Error(`第 ${index + 1} 条消息缺少时间。`);
      const timestamp = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 4102444800000) throw new Error(`第 ${index + 1} 条消息时间无效，请用 ISO 时间或毫秒时间戳。`);
      const id = message.id == null ? `message-${index + 1}` : String(message.id).slice(0, 200);
      if (!id || seenIds.has(id)) throw new Error(`消息 ID 为空或重复（第 ${index + 1} 条）。`);
      seenIds.add(id);
      if (message.text != null && typeof message.text !== 'string') throw new Error(`第 ${index + 1} 条消息的 text 必须是文字。`);
      if (message.text && message.text.length > 1000000) throw new Error(`第 ${index + 1} 条消息文字过长。`);
      if (message.fileName != null && typeof message.fileName !== 'string') throw new Error(`第 ${index + 1} 条消息的 fileName 必须是文字。`);
      if (message.rawType !== undefined && (!Number.isSafeInteger(message.rawType) || message.rawType < 0)) throw new Error(`第 ${index + 1} 条消息的 rawType 必须是非负安全整数。`);
      const asset = typeof message.asset === 'string' ? message.asset : '';
      const duration = typeof message.duration === 'number' ? message.duration : NaN;
      return {id, sender: message.sender, timestamp, type: message.type, text: message.text || '', asset, rawType:message.rawType, fileName:message.type === 'file' ? safeFileName(message.fileName) : undefined, duration: Number.isFinite(duration) && duration >= 0 ? duration : null, _order: index};
    }).sort((a, b) => a.timestamp - b.timestamp || a._order - b._order);
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? {...input.metadata} : {};
    if (metadata.conversationId != null) {
      if (typeof metadata.conversationId !== 'string' || !/^[a-f0-9]{24}$/i.test(metadata.conversationId)) throw new Error('metadata.conversationId 必须为 24 位十六进制会话标识。');
      metadata.conversationId = metadata.conversationId.toLowerCase();
    }
    return {schemaVersion: 1, title: safeName(input.title, '我们的聊天'), participants, messages, assets, metadata};
  }
  function resolveAsset(reference, kind) {
    return safeDataUrl(data.assets[reference] || reference, kind === 'file' ? null : kind);
  }
  function otherRole() { return viewpoint === 'wife' ? 'husband' : 'wife'; }
  function conversationId() { return !isDemo && data.metadata ? data.metadata.conversationId || '' : ''; }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const unit = bytes >= 1024 ** 3 ? 'GB' : bytes >= 1024 ** 2 ? 'MB' : 'KB';
    const divisor = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
    return `${(bytes / divisor).toFixed(1)} ${unit}`;
  }
  async function refreshMediaStats() {
    const cid = conversationId();
    try { const stats = await mediaStore.stats(cid); if (cid === conversationId()) $('media-count').textContent = `${stats.count.toLocaleString()} 个 · ${formatBytes(stats.bytes)}${stats.packs ? ` · ${stats.packs} 包` : ''}`; }
    catch (_) { $('media-count').textContent = '暂无法统计'; }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const text = estimate.quota != null && estimate.usage != null ? `浏览器估计可用 ${formatBytes(Math.max(0,estimate.quota - estimate.usage))}；实际以保存结果为准。` : '浏览器未提供可用空间估计。';
        $('storage-estimate').textContent = text; $('media-space').textContent = text;
      } catch (_) { $('storage-estimate').textContent = '暂无法估计存储空间，请保留原始文件。'; }
    } else $('storage-estimate').textContent = '请保留原始 JSON 和媒体包作为备份。';
  }
  function releaseMediaUrls() {
    pauseOtherMedia();
    renderVersion++;
    mediaQueue = [];
    for (const media of document.querySelectorAll('audio,video')) { media.pause(); media.removeAttribute('src'); media.load(); }
    for (const image of document.querySelectorAll('.message-image,.search-media-thumb')) image.removeAttribute('src');
    if ($('image-dialog').open) $('image-dialog').close();
    $('full-image').removeAttribute('src');
    if ($('video-dialog').open) $('video-dialog').close();
    closeVideoPreview();
    for (const url of mediaUrls) URL.revokeObjectURL(url);
    mediaUrls.clear();
  }
  function makeAvatar(role, extra = '') {
    const avatar = node('div', `avatar ${role}-avatar ${extra}`);
    const participant = data.participants[role];
    const imageUrl = resolveAsset(participant.avatar, 'image');
    if (imageUrl) {
      const img = node('img'); img.src = imageUrl; img.alt = participant.name; img.loading = 'lazy'; avatar.append(img);
    } else {
      avatar.textContent = role === 'wife' ? '她' : '他';
      avatar.setAttribute('aria-label', participant.name);
    }
    return avatar;
  }
  function dateKey(timestamp) {
    const date = new Date(timestamp);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function dateLabel(timestamp) {
    return new Date(timestamp).toLocaleDateString('zh-CN', {year:'numeric', month:'long', day:'numeric', weekday:'short'});
  }
  function timeLabel(timestamp) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', hour12:false});
  }
  function messageCategory(message) {
    if (Number.isSafeInteger(message.rawType) && message.rawType >= 0) {
      const base = message.rawType % (2 ** 32);
      const subtype = Math.floor(message.rawType / (2 ** 32));
      if (message.type === 'image' && (base === 47 || base === 11000)) return 'emoji';
      if (message.type === 'text' && base === 49 && subtype === 2000) return 'transfer';
    }
    return message.type;
  }
  function transferDetails(message) {
    if (messageCategory(message) !== 'transfer') return null;
    const originalText = typeof message.text === 'string' ? message.text : '';
    // Count complete currency candidates, including unsupported signed or grouped amounts.
    // A malformed second amount must not make the first valid amount look unique.
    const candidates = Array.from(originalText.matchAll(/(?:[+\-][ \t]*)?(?:[¥￥][ \t]*)+[+\-]?[ \t]*[0-9]+(?:[.,][0-9]+)*(?:[ \t]*元)?|(?:[+\-][ \t]*)?[0-9]+(?:[.,][0-9]+)*[ \t]*元/gu));
    let amountText = '';
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const before = originalText.slice(0,candidate.index).replace(/[ \t]+$/,'').slice(-1);
      const after = originalText.slice(candidate.index + candidate[0].length).replace(/^[ \t]+/,'').slice(0,1);
      const blockedBoundary = /[0-9.,+\-¥￥A-Za-z]/;
      const amount = /^(?:[¥￥][ \t]*([0-9]+\.[0-9]{2})(?:[ \t]*元)?|([0-9]+\.[0-9]{2})[ \t]*元)$/u.exec(candidate[0]);
      if (amount && !blockedBoundary.test(before) && !blockedBoundary.test(after)) amountText = `￥${amount[1] || amount[2]}`;
    }
    return {amountText, originalText, statusText:'收款/退回状态未保留'};
  }
  function makeTransferSummary(message, className) {
    const details = transferDetails(message);
    const card = node('div',className);
    card.append(node('span','transfer-heading','历史转账'),node('strong','transfer-amount',details.amountText || '金额未识别'));
    const note = node('p','transfer-note'); appendHighlighted(note,details.originalText,searchQuery); card.append(note);
    card.append(node('p','transfer-status',details.statusText));
    return card;
  }
  function previewText(message) {
    if (!message) return '还没有消息，导入后就能开始翻看';
    const category = messageCategory(message);
    if (category === 'emoji') return '[表情]';
    if (category === 'transfer') return `[转账] ${transferDetails(message).amountText || '金额未识别'}`;
    if (message.type === 'file') return `[文件] ${message.fileName}`;
    const labels = {image:'[图片]', audio:'[语音]', video:'[视频]', system:'[提示]'};
    return mediaCaption(message) || labels[message.type] || '';
  }
  function refreshOverview() {
    ensureIndexes();
    if (currentView === 'details') renderDetails();
    const name = data.participants[otherRole()].name;
    $('contact-name').textContent = name;
    $('chat-name').textContent = name;
    const existingAvatar = $('contact-avatar');
    const avatar = makeAvatar(otherRole(), 'contact-avatar'); avatar.id = 'contact-avatar'; existingAvatar.replaceWith(avatar);
    const latest = data.messages.at(-1);
    $('contact-preview').textContent = previewText(latest);
    $('contact-last-time').textContent = latest ? dateKey(latest.timestamp).replaceAll('-', '.') : '';
    $('record-tag').textContent = `${isDemo ? '演示' : '本地记录'} · ${data.messages.length.toLocaleString()} 条消息`;
    $('chat-subtitle').textContent = `${isDemo ? '演示记录' : '本地保存'} · ${data.messages.length.toLocaleString()} 条消息`;
    $('dataset-status').textContent = isDemo ? '演示记录 · 尚未导入' : '已导入 · 本地保存';
    $('message-count').textContent = `${data.messages.length.toLocaleString()} 条`;
    $('home-demo').hidden = !isDemo;
    $('chat-demo').hidden = !isDemo;
    $('perspective-wife').classList.toggle('selected', viewpoint === 'wife');
    $('perspective-husband').classList.toggle('selected', viewpoint === 'husband');
    $('perspective-wife').setAttribute('aria-pressed', String(viewpoint === 'wife'));
    $('perspective-husband').setAttribute('aria-pressed', String(viewpoint === 'husband'));
    refreshMediaStats();
  }
  function ensureIndexes() {
    if (indexedData === data) return;
    indexedData = data; searchGeneration++;
    dateIndex = new Map(); recordDays = []; searchMatches = []; searchPage = 0; missingRawTypeCount = 0;
    filtered = data.messages; pageEnd = data.messages.length;
    contextTargetId = ''; clearTimeout(contextTimer);
    let nextBoundary = -1; let currentDay = '';
    for (let index = 0; index < data.messages.length; index++) {
      if (data.messages[index].rawType === undefined) missingRawTypeCount++;
      const timestamp = data.messages[index].timestamp;
      if (timestamp >= nextBoundary) {
        currentDay = dateKey(timestamp);
        const next = new Date(timestamp); next.setHours(0,0,0,0); next.setDate(next.getDate() + 1);
        nextBoundary = next.getTime();
        recordDays.push(currentDay); dateIndex.set(currentDay,{first:index,count:0});
      }
      dateIndex.get(currentDay).count++;
    }
    calendarMonth = recordDays.length ? recordDays.at(-1).slice(0,7) : dateKey(Date.now()).slice(0,7);
    selectedDate = '';
  }
  function pauseOtherMedia(except = null) {
    for (const media of document.querySelectorAll('audio,video')) if (media !== except) media.pause();
    if (activeAudio && activeAudio !== except) activeAudio = null;
  }
  function renderDetails() {
    const members = $('details-members'); if (!members) return;
    const fragment = document.createDocumentFragment();
    for (const role of [otherRole(),viewpoint]) {
      const member = node('div','details-member');
      member.append(makeAvatar(role,'details-member-avatar'),node('span','details-member-name',data.participants[role].name));
      fragment.append(member);
    }
    members.replaceChildren(fragment);
  }
  function showView(view, options = {}) {
    if (currentView === 'chat') chatScrollTop = $('message-list').scrollTop;
    if (view !== 'search') { searchGeneration++; clearTimeout(searchTimer); }
    releaseMediaUrls(); currentView = view;
    for (const name of ['list','chat','settings','details','search','calendar']) {
      const section = $(`${name}-view`); if (section) section.classList.toggle('active',name === view);
    }
    if (view === 'chat') {
      renderMessages();
      requestAnimationFrame(() => {
        if (contextTargetId) scrollToContext();
        else $('message-list').scrollTop = options.restore ? chatScrollTop : $('message-list').scrollHeight;
      });
    } else if (view === 'details') renderDetails();
    else if (view === 'search') { applyFilters(); requestAnimationFrame(() => $('search-input').focus()); }
    else if (view === 'calendar') renderCalendar();
  }
  function appendHighlighted(element, text, query = '') {
    if (!query) { element.textContent = text; return; }
    const lower = text.toLocaleLowerCase(); const needle = query.toLocaleLowerCase();
    let start = 0; let found;
    while ((found = lower.indexOf(needle,start)) !== -1) {
      element.append(document.createTextNode(text.slice(start,found)));
      element.append(node('mark','highlight',text.slice(found,found + query.length)));
      start = found + query.length;
    }
    element.append(document.createTextNode(text.slice(start)));
  }
  function scrollToContext() {
    if (!contextTargetId || currentView !== 'chat') return;
    const target = Array.from($('message-list').querySelectorAll('[data-message-id]')).find(item => item.dataset.messageId === contextTargetId);
    if (target) target.scrollIntoView({block:'center',behavior:'auto'});
  }
  function openChatAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= data.messages.length) return;
    filtered = data.messages;
    pageEnd = Math.min(data.messages.length,Math.max(PAGE_SIZE,index + Math.floor(PAGE_SIZE / 2) + 1));
    contextTargetId = data.messages[index].id; clearTimeout(contextTimer);
    showView('chat');
    contextTimer = setTimeout(() => {
      contextTargetId = '';
      for (const target of $('message-list').querySelectorAll('.context-target')) target.classList.remove('context-target');
    },3200);
  }
  function shiftChatPage(end) {
    contextTargetId = ''; clearTimeout(contextTimer);
    pageEnd = Math.min(data.messages.length,Math.max(0,end)); renderMessages();
  }
  function renderCalendar() {
    ensureIndexes();
    const picker = $('calendar-month'); const grid = $('calendar-grid'); if (!picker || !grid) return;
    const minimum = recordDays.length ? recordDays[0].slice(0,7) : calendarMonth;
    const maximum = recordDays.length ? recordDays.at(-1).slice(0,7) : calendarMonth;
    if (!/^\d{4}-\d{2}$/.test(calendarMonth)) calendarMonth = maximum;
    if (calendarMonth < minimum) calendarMonth = minimum;
    if (calendarMonth > maximum) calendarMonth = maximum;
    picker.min = minimum; picker.max = maximum; picker.value = calendarMonth;
    $('calendar-prev').disabled = !recordDays.length || calendarMonth <= minimum;
    $('calendar-next').disabled = !recordDays.length || calendarMonth >= maximum;
    const [year,month] = calendarMonth.split('-').map(Number);
    const first = new Date(year,month - 1,1); const days = new Date(year,month,0).getDate();
    const fragment = document.createDocumentFragment(); let activeDays = 0;
    for (let blank = 0; blank < first.getDay(); blank++) {
      const spacer = node('span','calendar-empty-cell'); spacer.setAttribute('aria-hidden','true'); fragment.append(spacer);
    }
    for (let day = 1; day <= days; day++) {
      const key = `${calendarMonth}-${String(day).padStart(2,'0')}`; const entry = dateIndex.get(key);
      const button = node('button',`calendar-day${entry ? ' has-records' : ''}${key === selectedDate ? ' selected' : ''}`,day);
      button.type = 'button'; button.dataset.date = key; button.disabled = !entry;
      button.setAttribute('aria-label',`${key}${entry ? `，${entry.count.toLocaleString()} 条记录` : '，没有记录'}`);
      if (entry) { activeDays++; button.addEventListener('click',() => { selectedDate = key; openChatAt(entry.first); }); }
      fragment.append(button);
    }
    grid.replaceChildren(fragment);
    $('calendar-empty').hidden = activeDays > 0;
    $('calendar-empty').textContent = recordDays.length ? '这个月没有留存的聊天记录' : '导入聊天记录后，可以按日期翻看';
  }
  function moveCalendarMonth(amount) {
    const [year,month] = calendarMonth.split('-').map(Number); const date = new Date(year,month - 1 + amount,1);
    calendarMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}`; renderCalendar();
  }
  function mediaCaption(message) {
    if (!MEDIA_TYPES.has(message.type)) return message.text;
    const text = message.text.trim();
    if (OLD_MEDIA_PLACEHOLDER.test(text) || /^\[(?:图片|语音|视频|表情|文件)\]$/.test(text)) return '';
    return text;
  }
  function searchText(message) {
    const text = mediaCaption(message);
    return message.type === 'file' ? `${message.fileName || ''}${text ? `\n${text}` : ''}` : text;
  }
  function resultExcerpt(message) {
    const text = searchText(message) || previewText(message); const match = searchQuery ? text.toLocaleLowerCase().indexOf(searchQuery.toLocaleLowerCase()) : -1;
    const begin = Math.max(0,match - 45); const end = Math.min(text.length,begin + Math.max(220,searchQuery.length + 90));
    return `${begin ? '…' : ''}${text.slice(begin,end)}${end < text.length ? '…' : ''}`;
  }
  function refreshClassificationNotice() {
    const notice = $('classification-notice');
    if (notice) notice.hidden = isDemo || !missingRawTypeCount || !['image','emoji','transfer'].includes(searchType);
  }
  function renderSearchResults() {
    const results = $('search-results'); if (!results) return;
    refreshClassificationNotice();
    releaseMediaUrls(); const version = renderVersion; const mediaJobs = [];
    const fragment = document.createDocumentFragment();
    const begin = searchPage * PAGE_SIZE; const end = Math.min(searchMatches.length,begin + PAGE_SIZE);
    if (!searchMatches.length) {
      const empty = node('div','empty-state');
      const hasCriteria = !!(searchQuery || searchType !== 'all' || $('date-from').value || $('date-to').value);
      empty.append(node('strong','',hasCriteria ? '没有找到相关记录' : '查找聊天记录'),node('p','',hasCriteria ? '换个关键词或调整日期再试试' : '输入关键词，也可以选择图片、语音或日期')); fragment.append(empty);
    } else {
      if (searchPage > 0) {
        const previous = node('button','search-prev-button','上一页结果'); previous.type = 'button';
        previous.addEventListener('click',() => { searchPage--; renderSearchResults(); results.scrollTop = 0; }); fragment.append(previous);
      }
      for (let offset = begin; offset < end; offset++) {
        const index = searchMatches[offset]; const message = data.messages[index];
        const result = node('article','search-result'); result.dataset.messageId = message.id; result.dataset.messageIndex = String(index);
        const context = node('button','search-result-context'); context.type = 'button'; context.setAttribute('aria-label','查看原聊天');
        context.append(makeAvatar(message.sender,'search-avatar'));
        const copy = node('div','search-result-copy'); const meta = node('div','search-result-meta');
        meta.append(node('strong','search-result-name',data.participants[message.sender].name),node('time','search-result-time',`${dateLabel(message.timestamp)} ${timeLabel(message.timestamp)}`));
        const text = node('p','search-result-text'); appendHighlighted(text,resultExcerpt(message),searchQuery);
        copy.append(meta);
        if (messageCategory(message) === 'transfer') copy.append(makeTransferSummary(message,'search-transfer-summary'));
        else copy.append(text);
        if (MEDIA_TYPES.has(message.type)) {
          const status = node('p','search-media-status media-loading','正在读取本机附件…'); status.setAttribute('aria-live','polite'); copy.append(status);
          const preview = node('button','search-media-preview'); preview.type = 'button'; preview.hidden = true;
          result.append(preview); mediaJobs.push({message,result,status,preview});
        }
        copy.append(node('span','search-context-link','查看原聊天 ›'));
        context.append(copy); context.addEventListener('click',() => openChatAt(index)); result.prepend(context); fragment.append(result);
      }
    }
    results.replaceChildren(fragment);
    $('search-count').textContent = searchMatches.length ? `${searchMatches.length.toLocaleString()} 条结果 · ${begin + 1}–${end}` : '';
    $('filter-count').textContent = `共 ${searchMatches.length.toLocaleString()} 条匹配记录`;
    $('search-more').hidden = end >= searchMatches.length;
    for (const tab of $('search-type-tabs').querySelectorAll('[data-search-type]')) {
      const selected = tab.dataset.searchType === searchType; tab.classList.toggle('selected',selected); tab.setAttribute('aria-pressed',String(selected));
    }
    if (mediaJobs.length && currentView === 'search') hydrateSearchMedia(mediaJobs,version);
  }
  async function hydrateSearchMedia(jobs, version) {
    const cid = conversationId(); let next = 0;
    const active = job => version === renderVersion && currentView === 'search' && cid === conversationId() && job.result.isConnected;
    const state = (job, name, text) => { if (active(job)) { job.status.className = `search-media-status media-${name}`; job.status.textContent = text; } };
    async function worker() {
      while (next < jobs.length && version === renderVersion && currentView === 'search') {
        const job = jobs[next++];
        try {
          let url = resolveAsset(job.message.asset,job.message.type);
          const saved = !url && cid ? await mediaStore.getMessageMedia(cid,job.message.id,job.message.asset) : null;
          if (!active(job)) continue;
          if (!url && !saved) { state(job,'missing','本机未找到附件'); continue; }
          if (saved && (job.message.type !== 'file' && !saved.mime.startsWith(`${job.message.type}/`))) { state(job,'unsupported','附件格式不支持'); continue; }
          state(job,'ready','本机已找到附件');
          if (job.message.type === 'image') {
            if (!url) { url = URL.createObjectURL(saved.blob); mediaUrls.add(url); }
            const emoji = messageCategory(job.message) === 'emoji';
            if (emoji) job.preview.classList.add('search-emoji-preview');
            const image = node('img','search-media-thumb'); image.alt = emoji ? '表情预览' : '图片预览'; image.loading = 'lazy'; image.decoding = 'async';
            image.addEventListener('error',() => { if (active(job)) { job.preview.hidden = true; state(job,'unsupported','图片格式无法显示'); } });
            image.src = url; job.preview.append(image); job.preview.hidden = false; job.preview.setAttribute('aria-label',emoji ? '预览表情' : '预览图片');
            job.preview.addEventListener('click',() => { if (active(job)) { pauseOtherMedia(); $('full-image').src = url; $('image-dialog').showModal(); } });
          } else if (job.message.type === 'video') {
            job.preview.append(node('span','search-video-play','▶'),node('span','search-video-label','预览'));
            job.preview.hidden = false; job.preview.setAttribute('aria-label','预览视频');
            job.preview.addEventListener('click',() => {
              if (!active(job)) return;
              // No video element or source is created for the results list. Load only on this click.
              // A video preview owns its URL until close; the next click creates a fresh one.
              const previewUrl = url || URL.createObjectURL(saved.blob);
              if (previewUrl.startsWith('blob:')) mediaUrls.add(previewUrl);
              openVideoPreview(previewUrl,() => state(job,'unsupported','此视频格式无法播放'));
            });
          }
        } catch (_) { state(job,'unavailable','暂无法读取本机附件，请重试'); }
      }
    }
    await Promise.all(Array.from({length:Math.min(4,jobs.length)},worker));
  }
  function openVideoPreview(url, onError) {
    closeVideoPreview(); pauseOtherMedia(); videoPreviewError = onError; videoPreviewUrl = url;
    const video = $('full-video'); $('video-preview-status').hidden = true;
    video.preload = 'metadata'; video.src = url; $('video-dialog').showModal(); video.load();
  }
  function closeVideoPreview() {
    videoPreviewError = null;
    const url = videoPreviewUrl; videoPreviewUrl = '';
    if (!url) return;
    const video = $('full-video');
    video.pause(); video.removeAttribute('src'); video.preload = 'none'; video.load();
    if (url.startsWith('blob:')) { URL.revokeObjectURL(url); mediaUrls.delete(url); }
  }
  async function applyFilters() {
    if (currentView !== 'search') return;
    releaseMediaUrls();
    const generation = ++searchGeneration; const messages = data.messages;
    searchQuery = $('search-input').value.trim().slice(0,500); searchPage = 0;
    refreshClassificationNotice();
    const query = searchQuery.toLocaleLowerCase(); const from = $('date-from').value; const to = $('date-to').value;
    if (from && to && from > to) { searchMatches = []; renderSearchResults(); toast('开始日期不能晚于结束日期'); return; }
    if (!query && searchType === 'all' && !from && !to) { searchMatches = []; renderSearchResults(); return; }
    const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    const finish = to ? new Date(`${to}T00:00:00`) : null;
    if (finish) finish.setDate(finish.getDate() + 1);
    const stop = finish ? finish.getTime() : Infinity; const kind = searchType; const matches = [];
    $('search-count').textContent = '正在查找…';
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if ((kind === 'all' || messageCategory(message) === kind) && message.timestamp >= start && message.timestamp < stop
          && (!query || searchText(message).toLocaleLowerCase().includes(query))) matches.push(index);
      if (index % 8192 === 0) {
        await new Promise(resolve => setTimeout(resolve,0));
        if (generation !== searchGeneration || data.messages !== messages) return;
      }
    }
    if (generation !== searchGeneration || data.messages !== messages) return;
    searchMatches = matches; renderSearchResults(); $('search-results').scrollTop = 0;
  }
  function resetFilters() {
    searchGeneration++; clearTimeout(searchTimer); ensureIndexes();
    $('search-input').value = ''; $('date-from').value = ''; $('date-to').value = '';
    searchQuery = ''; searchType = 'all'; searchMatches = []; searchPage = 0;
    filtered = data.messages; pageEnd = data.messages.length;
    contextTargetId = ''; clearTimeout(contextTimer);
    renderMessages();
    if (currentView === 'search') renderSearchResults();
    if (currentView === 'calendar') renderCalendar();
  }
  function missingMedia(message) {
    const names = {image:'图片', audio:'语音', video:'视频',file:'文件'};
    return node('div', 'missing-media', `${message.type === 'file' ? `${message.fileName} · ` : ''}${names[message.type]}附件未导入${message.duration != null ? ` · ${Math.round(message.duration)} 秒` : ''}`);
  }
  function downloadFile(url,fileName) {
    if (url.startsWith('data:')) {
      const encoded = url.slice(url.indexOf(',') + 1).replace(/\s/g,''); const parts = [];
      try {
        for (let offset = 0; offset < encoded.length; offset += 65536) {
          const decoded = atob(encoded.slice(offset,offset + 65536)); const bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i); parts.push(bytes);
        }
        url = URL.createObjectURL(new Blob(parts,{type:'application/octet-stream'})); mediaUrls.add(url);
      } catch (_) { toast('附件无法读取，请重新导入原文件'); return; }
    }
    if (!url.startsWith('blob:')) { toast('附件未导入'); return; }
    const link = node('a'); link.href = url; link.download = safeFileName(fileName); document.body.append(link); link.click(); link.remove();
    return url;
  }
  function fillMediaBubble(bubble,message,url,duration) {
    bubble.replaceChildren(); bubble.className = 'message-bubble';
    const emoji = messageCategory(message) === 'emoji';
    if (emoji) bubble.classList.add('emoji-bubble');
    if (!url) bubble.append(missingMedia(message));
    else if (message.type === 'file') {
      bubble.classList.add('file-bubble'); bubble.append(node('strong','file-name',message.fileName));
      let downloadUrl = url;
      const download = node('button','file-download','下载文件'); download.addEventListener('click',() => { downloadUrl = downloadFile(downloadUrl,message.fileName) || downloadUrl; }); bubble.append(download);
    } else if (message.type === 'image') {
      bubble.classList.add('media-bubble');
      if (/^\[表情[^\]]*\]/.test(message.text.trim())) bubble.classList.add('emoji-bubble');
      const button = node('button','message-image-button'); button.setAttribute('aria-label','放大聊天图片');
      const img = node('img','message-image'); img.src = url; img.alt = message.text || '聊天图片'; img.loading = 'lazy';
      img.addEventListener('load',() => { if (!contextTargetId && currentView === 'chat' && $('message-list').scrollHeight - $('message-list').scrollTop - $('message-list').clientHeight < 250) $('message-list').scrollTop = $('message-list').scrollHeight; });
      img.addEventListener('error',() => button.replaceWith(node('div','missing-media','图片无法显示，请检查原始附件')));
      button.append(img); button.addEventListener('click',() => { $('full-image').src = url; $('image-dialog').showModal(); }); bubble.append(button);
    } else if (message.type === 'audio') {
      bubble.classList.add('voice-bubble');
      const seconds = duration != null ? Math.round(duration) : null;
      const button = node('button',`voice-button ${seconds != null && seconds <= 10 ? 'voice-short' : seconds != null && seconds <= 30 ? 'voice-medium' : 'voice-long'}`);
      button.type = 'button'; button.setAttribute('aria-label',`播放语音${seconds != null ? `，${seconds} 秒` : ''}`); button.setAttribute('aria-pressed','false');
      const icon = document.createElementNS('http://www.w3.org/2000/svg','svg'); icon.setAttribute('class','voice-icon'); icon.setAttribute('viewBox','0 0 24 24'); icon.setAttribute('aria-hidden','true');
      for (const [index,path] of ['M7 10v4','M11 7a8 8 0 0 1 0 10','M15 4a12 12 0 0 1 0 16'].entries()) {
        const wave = document.createElementNS('http://www.w3.org/2000/svg','path'); wave.setAttribute('d',path); wave.setAttribute('class',`voice-wave voice-wave-${index + 1}`); icon.append(wave);
      }
      button.append(icon,node('span','voice-duration',seconds != null ? `${seconds}″` : '语音'));
      const audio = node('audio','voice-audio'); audio.src = url; audio.preload = 'none'; audio.hidden = true; audio.setAttribute('aria-hidden','true');
      const update = playing => { button.classList.toggle('playing',playing); button.setAttribute('aria-pressed',String(playing)); button.setAttribute('aria-label',`${playing ? '暂停' : '播放'}语音${seconds != null ? `，${seconds} 秒` : ''}`); };
      const failure = () => { update(false); if (activeAudio === audio) activeAudio = null; if (!bubble.querySelector('.missing-media')) bubble.append(node('div','missing-media','此语音格式无法播放，请保留原始附件')); };
      audio.addEventListener('play',() => { pauseOtherMedia(audio); activeAudio = audio; update(true); });
      audio.addEventListener('pause',() => { update(false); if (activeAudio === audio) activeAudio = null; });
      audio.addEventListener('ended',() => { update(false); if (activeAudio === audio) activeAudio = null; });
      audio.addEventListener('error',failure);
      button.addEventListener('click',async () => {
        if (!audio.paused) { audio.pause(); return; }
        pauseOtherMedia(audio); activeAudio = audio;
        try { await audio.play(); }
        catch (error) { update(false); if (activeAudio === audio) activeAudio = null; if (error && error.name === 'NotAllowedError') toast('请再点一次语音播放'); else if (!error || error.name !== 'AbortError') failure(); }
      });
      bubble.append(button,audio);
    } else if (message.type === 'video') {
      bubble.classList.add('media-bubble'); const video = node('video','message-video'); video.src = url; video.controls = true; video.preload = 'none'; video.playsInline = true;
      video.addEventListener('play',() => pauseOtherMedia(video));
      video.addEventListener('error',() => { if (!bubble.querySelector('.missing-media')) bubble.append(node('div','missing-media','此视频格式无法播放，请保留原始附件')); }); bubble.append(video);
    }
    const captionText = mediaCaption(message).replace(/^\[(?:图片|语音|视频|表情|文件)\](?=[（(](?:静态预览|仅缩略图))/, '');
    if (emoji) bubble.append(node('span','emoji-label','[表情]'));
    if (captionText && !/^\[(?:图片|语音|视频|表情|文件)\]$/.test(captionText)) { const caption = node('div','media-caption'); appendHighlighted(caption,captionText); bubble.append(caption); }
  }
  async function hydrateMedia(version) {
    const jobs = mediaQueue.splice(0); const cid = conversationId(); let next = 0;
    async function worker() {
      while (next < jobs.length && version === renderVersion && currentView === 'chat') {
        const job = jobs[next++];
        try {
          const saved = await mediaStore.getMessageMedia(cid,job.message.id,job.message.asset);
          if (!saved || version !== renderVersion || currentView !== 'chat' || cid !== conversationId() || !job.bubble.isConnected || (job.message.type !== 'file' && !saved.mime.startsWith(`${job.message.type}/`))) continue;
          const blob = job.message.type === 'file' ? saved.blob.slice(0,saved.blob.size,'application/octet-stream') : saved.blob;
          const url = URL.createObjectURL(blob); mediaUrls.add(url);
          fillMediaBubble(job.bubble,job.message,url,saved.duration == null ? job.message.duration : saved.duration);
        } catch (_) {}
      }
    }
    await Promise.all(Array.from({length:Math.min(4,jobs.length)},worker));
    if (version === renderVersion && contextTargetId) requestAnimationFrame(scrollToContext);
  }
  function makeMessage(message) {
    if (message.type === 'system') {
      const element = node('div',`system-message${message.id === contextTargetId ? ' context-target' : ''}`); element.dataset.messageId = message.id; appendHighlighted(element,message.text); return element;
    }
    const mine = message.sender === viewpoint;
    const row = node('article',`message-row${mine ? ' mine' : ''}${message.id === contextTargetId ? ' context-target' : ''}`);
    row.dataset.messageId = message.id; row.append(makeAvatar(message.sender));
    const content = node('div','message-content'); const bubble = node('div','message-bubble');
    if (messageCategory(message) === 'transfer') {
      bubble.classList.add('transfer-card'); bubble.append(makeTransferSummary(message,'transfer-card-content'));
      bubble.append(node('time','transfer-time',`${dateLabel(message.timestamp)} ${timeLabel(message.timestamp)}`));
    } else if (message.type === 'text') appendHighlighted(bubble,message.text);
    else {
      const url = resolveAsset(message.asset,message.type); fillMediaBubble(bubble,message,url,message.duration);
      if (!url && conversationId() && currentView === 'chat') mediaQueue.push({bubble,message});
    }
    content.append(bubble); row.append(content); return row;
  }
  function chatTimeLabel(timestamp,showDate) {
    if (!showDate) return timeLabel(timestamp);
    const date = new Date(timestamp); const today = new Date();
    if (dateKey(timestamp) === dateKey(today.getTime())) return timeLabel(timestamp);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (dateKey(timestamp) === dateKey(yesterday.getTime())) return `昨天 ${timeLabel(timestamp)}`;
    return `${date.getFullYear() !== today.getFullYear() ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日 ${timeLabel(timestamp)}`;
  }
  function renderMessages(preservePosition = false) {
    releaseMediaUrls(); const version = renderVersion;
    const list = $('message-list'); const oldHeight = list.scrollHeight; const oldTop = list.scrollTop;
    const fragment = document.createDocumentFragment(); const messages = data.messages;
    if (!messages.length) {
      const empty = node('div','empty-state'); empty.append(node('strong','','这里还没有聊天记录'),node('p','','导入保留的聊天文件后，就可以翻看了。')); fragment.append(empty);
    } else {
      const end = Math.min(pageEnd,messages.length); const begin = Math.max(0,end - PAGE_SIZE);
      if (begin > 0) {
        const wrap = node('div','load-more-wrap'); const button = node('button','load-more-button',`查看更早的消息 · 还有 ${begin.toLocaleString()} 条`);
        button.addEventListener('click',() => shiftChatPage(begin)); wrap.append(button); fragment.append(wrap);
      } else fragment.append(node('div','history-start',isDemo ? '演示记录开始' : '已到留存记录的开始'));
      let previousDay = ''; let lastMarker = -Infinity;
      for (let index = begin; index < end; index++) {
        const message = messages[index]; const day = dateKey(message.timestamp); const showDate = day !== previousDay;
        if (showDate || message.timestamp - lastMarker >= 5 * 60000) {
          fragment.append(node('div','message-date',chatTimeLabel(message.timestamp,showDate))); lastMarker = message.timestamp;
        }
        previousDay = day; fragment.append(makeMessage(message));
      }
      if (end < messages.length) {
        const wrap = node('div','load-more-wrap newer-messages'); const button = node('button','load-more-button','查看更新的消息');
        button.addEventListener('click',() => shiftChatPage(end + PAGE_SIZE)); wrap.append(button); fragment.append(wrap);
      }
    }
    list.replaceChildren(fragment);
    if (preservePosition) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
    else list.scrollTop = list.scrollHeight;
    if (currentView === 'chat' && conversationId()) hydrateMedia(version);
    if (contextTargetId && currentView === 'chat') requestAnimationFrame(scrollToContext);
  }
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4000);
  }
  function openDatabase() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('当前浏览器不支持本地存储，请使用 Safari 或 Chrome。')); return; }
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records');
        for (const name of ['media','mediaLinks','importedPacks']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name).createIndex('conversation','conversationId',{unique:false});
        }
        const records = request.transaction.objectStore('records'); const stored = records.get('current');
        stored.onsuccess = () => {
          const cid = stored.result && stored.result.metadata && stored.result.metadata.conversationId;
          if (typeof cid === 'string' && /^[a-f0-9]{24}$/i.test(cid)) records.put({conversationId:cid.toLowerCase()},'activeConversation');
        };
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('请关闭其他打开本查看器的页面后重试。'));
    }).catch(error => { dbPromise = null; throw error; });
    return dbPromise;
  }
  async function readStored() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('records', 'readonly').objectStore('records').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function persistPackage(value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['records','media','mediaLinks','importedPacks'], 'readwrite');
      const records = tx.objectStore('records'); const oldRequest = records.get('activeConversation');
      oldRequest.onsuccess = () => {
        const oldCid = oldRequest.result && oldRequest.result.conversationId;
        const nextCid = value && value.metadata && value.metadata.conversationId;
        if (oldCid && oldCid !== nextCid) {
          for (const name of ['media','mediaLinks','importedPacks']) {
            const store = tx.objectStore(name); const request = store.index('conversation').openKeyCursor(IDBKeyRange.only(oldCid));
            request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
          }
          records.delete(['mediaTotal',oldCid]);
        }
        if (value) records.put(value,'current'); else records.delete('current');
        if (nextCid) records.put({conversationId:nextCid},'activeConversation'); else records.delete('activeConversation');
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存未完成'));
    });
  }
  function announceRecordChange(kind = 'records') {
    const token = `${Date.now()}-${Math.random()}`;
    lastChangeToken = token;
    const payload = {token,kind,conversationId:conversationId()};
    if (recordsChannel) recordsChannel.postMessage(payload);
    try { localStorage.setItem('our-chat-records-change',JSON.stringify(payload)); } catch (_) {}
  }
  async function receiveRecordChange(payload) {
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { payload = {token:payload,kind:'records'}; } }
    const token = payload && payload.token;
    if (!token || token === lastChangeToken) return;
    lastChangeToken = token;
    if (payload.kind === 'media') {
      if (payload.conversationId === conversationId()) { refreshMediaStats(); if (currentView === 'chat') renderMessages(true); else if (currentView === 'search') renderSearchResults(); }
      return;
    }
    if (mediaImportController) mediaImportController.abort();
    try {
      const stored = await readStored();
      for (const media of document.querySelectorAll('audio,video')) media.pause();
      if ($('image-dialog').open) $('image-dialog').close();
      data = validatePackage(stored || EXAMPLE); isDemo = !stored;
      refreshOverview(); resetFilters();
    } catch (_) { toast('本地记录更新未能读取，请重新打开查看器'); }
  }
  function exportPackage(value = data) {
    return {schemaVersion:1, title:value.title, metadata:value.metadata, participants:value.participants, messages:value.messages.map(({_order, ...message}) => message), assets:value.assets};
  }
  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value)], {type:'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob); const link = node('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function openImport() {
    if (mediaImportController) { toast('媒体正在导入，完成或取消后再导入聊天 JSON'); return; }
    $('import-status').classList.remove('error'); $('import-status').textContent = '新文件会替换本设备上现有的记录。'; $('import-file').value = ''; $('import-dialog').showModal();
  }
  function openClassificationImport() {
    openImport();
    if ($('import-dialog').open) $('import-status').textContent = '重新选择原聊天 JSON 即可更新分类。同一段聊天（会话标识相同）的已导入媒体会保留，无需重导 ZIP。';
  }
  async function openMediaImport() {
    if (!conversationId()) { toast('请先导入包含会话标识的聊天 JSON'); return; }
    if ($('import-dialog').open) $('import-dialog').close();
    $('media-status').classList.remove('error');
    if (!mediaImportController) { $('media-status').textContent = '多个媒体包会合并；已经导入的包会自动跳过。'; $('media-files').value = ''; $('media-progress').hidden = true; }
    await refreshMediaStats(); $('media-dialog').showModal();
  }
  async function importMediaFiles(files) {
    if (!files.length || mediaImportController) return;
    const cid = conversationId(); if (!cid) { toast('请先导入聊天 JSON'); return; }
    const controller = new AbortController(); mediaImportController = controller;
    const status = $('media-status'); status.classList.remove('error'); $('media-file-zone').classList.add('busy'); $('media-files').disabled = true;
    $('cancel-media').hidden = false; $('cancel-media').disabled = false; $('media-progress').hidden = false; $('media-progress').value = 0; $('clear-data').disabled = true;
    let finished = 0; let skipped = 0; let lastPaint = 0;
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist().catch(() => false);
      for (let index = 0; index < files.length; index++) {
        if (controller.signal.aborted) throw new DOMException('已取消导入','AbortError');
        const file = files[index];
        const result = await importMediaPack(file,cid,{signal:controller.signal,getStorageEstimate:navigator.storage && navigator.storage.estimate ? () => navigator.storage.estimate() : undefined,onProgress:progress => {
          const now = Date.now();
          if (progress.phase === 'checking' && now - lastPaint < 120) return; lastPaint = now;
          const fraction = progress.totalBytes ? progress.bytesDone / progress.totalBytes : progress.phase === 'complete' ? 1 : 0;
          $('media-progress').value = Math.max(0,Math.min(100,(index + (Number.isFinite(fraction) ? fraction : 0)) / files.length * 100));
          const phase = {reading:'正在读取媒体包',checking:'正在校验附件',saving:'正在保存附件',complete:progress.skipped ? '已经导入，自动跳过' : '这包已完成'}[progress.phase];
          status.textContent = `${index + 1}/${files.length} · ${phase}：${progress.name || file.name}${progress.totalAssets != null ? ` · ${progress.assetIndex || 0}/${progress.totalAssets} 个 · ${formatBytes(progress.bytesDone || 0)}/${formatBytes(progress.totalBytes || 0)}` : ''}`;
        }});
        finished++; if (result.skipped) skipped++;
        announceRecordChange('media'); await refreshMediaStats();
      }
      $('media-progress').value = 100;
      status.textContent = `已处理 ${finished} 个媒体包${skipped ? `，其中 ${skipped} 个此前已导入` : ''}。附件保存在本机，请保留原媒体包。`;
      if (currentView === 'chat') renderMessages(true);
      else if (currentView === 'search') renderSearchResults();
    } catch (error) {
      const stopped = error && error.name === 'AbortError';
      status.classList.toggle('error',!stopped);
      status.textContent = stopped ? '已取消。之前保存的附件仍在，重新选择同一包可继续。' : error && ['StorageGrowthError','StorageSpaceError'].includes(error.name) ? `${error.message} 已保存的附件没有自动删除，请保留电脑上的原文件。` : error && error.name === 'QuotaExceededError' ? '本地空间不足。已保存的附件仍在；请先检查手机储存空间。若空间异常暴涨，不要反复重试导入。' : `${error.message || '媒体导入失败'} 已保存的附件仍在，重新选择同一包可继续。`;
      announceRecordChange('media'); await refreshMediaStats(); if (currentView === 'chat') renderMessages(true);
      else if (currentView === 'search') renderSearchResults();
    } finally {
      mediaImportController = null; $('media-file-zone').classList.remove('busy'); $('media-files').disabled = false; $('media-files').value = ''; $('cancel-media').hidden = true; $('clear-data').disabled = false;
    }
  }
  async function importFile(file) {
    if (!file) return;
    const status = $('import-status'); status.classList.remove('error'); $('file-zone').classList.add('busy'); $('import-file').disabled = true;
    try {
      if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 150 MB，请减少附件体积，并保留原始文件。');
      status.textContent = '正在读取文件…';
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch (_) { throw new Error('无法读取 JSON，请确认选择的是整理后的聊天文件。'); }
      status.textContent = '正在检查记录并保存到本设备…';
      await new Promise(resolve => setTimeout(resolve, 0));
      const next = validatePackage(parsed);
      try { await persistPackage(exportPackage(next)); }
      catch (error) { throw new Error(error && error.name === 'QuotaExceededError' ? '本设备的浏览器存储空间不足，文件未导入。请保留原始文件。' : '本地保存失败，请关闭无痕模式后重试。现有记录未替换。'); }
      data = next; isDemo = false; announceRecordChange(); refreshOverview(); resetFilters(); $('import-dialog').close(); showView('chat');
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast(`已导入 ${data.messages.length.toLocaleString()} 条消息，仅保存在本设备`);
    } catch (error) { status.textContent = error.message || '导入失败，请检查文件。'; status.classList.add('error'); }
    finally { $('file-zone').classList.remove('busy'); $('import-file').disabled = false; $('import-file').value = ''; }
  }

  $('open-chat').addEventListener('click', () => showView('chat'));
  $('chat-back').addEventListener('click', () => showView('list'));
  $('settings-back').addEventListener('click', () => showView(settingsReturnView,{restore:true}));
  $('nav-chat').addEventListener('click', () => showView('list'));
  for (const id of ['open-settings','nav-settings']) $(id).addEventListener('click', () => { settingsReturnView = 'list'; showView('settings'); });
  for (const id of ['nav-import','demo-import','chat-import','settings-import']) $(id).addEventListener('click', openImport);
  $('close-import').addEventListener('click', () => $('import-dialog').close());
  $('import-file').addEventListener('change', event => importFile(event.target.files[0]));
  for (const id of ['settings-media-import','dialog-media-import']) $(id).addEventListener('click',openMediaImport);
  $('media-files').addEventListener('change',event => importMediaFiles([...event.target.files]));
  $('cancel-media').addEventListener('click',() => { if (mediaImportController) { mediaImportController.abort(); $('cancel-media').disabled = true; } });
  $('close-media').addEventListener('click',() => { if (mediaImportController) mediaImportController.abort(); $('media-dialog').close(); });
  $('media-dialog').addEventListener('cancel',() => { if (mediaImportController) mediaImportController.abort(); });
  $('import-dialog').addEventListener('click', event => { if (event.target === $('import-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('import-dialog').close(); } });
  const on = (id,event,handler) => { const element = $(id); if (element) element.addEventListener(event,handler); };
  on('toggle-search','click',() => showView('details'));
  on('details-back','click',() => showView('chat',{restore:true}));
  on('details-search','click',() => { searchReturnView = 'details'; showView('search'); });
  on('details-import','click',openImport);
  on('details-settings','click',() => { settingsReturnView = 'details'; showView('settings'); });
  on('home-search','click',() => { searchReturnView = 'list'; showView('search'); });
  on('search-back','click',() => showView(searchReturnView));
  on('search-date','click',() => showView('calendar'));
  on('calendar-back','click',() => showView('search'));
  on('calendar-month','change',event => { calendarMonth = event.target.value; renderCalendar(); });
  on('calendar-prev','click',() => moveCalendarMonth(-1));
  on('calendar-next','click',() => moveCalendarMonth(1));
  on('search-more','click',() => { searchPage++; renderSearchResults(); $('search-results').scrollTop = 0; });
  on('classification-import','click',openClassificationImport);
  on('search-type-tabs','click',event => {
    const target = event.target.closest('[data-search-type]');
    if (target && ['all','image','emoji','transfer','audio','video','file'].includes(target.dataset.searchType)) { searchType = target.dataset.searchType; clearTimeout(searchTimer); applyFilters(); }
  });
  $('search-input').addEventListener('input',() => { searchGeneration++; releaseMediaUrls(); clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters,180); });
  $('date-from').addEventListener('change',applyFilters); $('date-to').addEventListener('change',applyFilters);
  $('clear-filters').addEventListener('click',() => { $('search-input').value = ''; $('date-from').value = ''; $('date-to').value = ''; searchType = 'all'; applyFilters(); });
  $('jump-latest').addEventListener('click',() => { contextTargetId = ''; pageEnd = data.messages.length; showView('chat'); });
  for (const role of ['wife', 'husband']) $(`perspective-${role}`).addEventListener('click', () => { viewpoint = role; try { localStorage.setItem('our-chat-viewpoint', role); } catch (_) {} refreshOverview(); renderMessages(); });
  $('export-data').addEventListener('click', () => { downloadJson(exportPackage(), `${isDemo ? '演示记录' : '我们的聊天'}-${dateKey(Date.now())}.json`); toast(isDemo ? '已导出演示记录，文件中没有真实聊天' : '已导出聊天 JSON；另行导入的媒体请保留原 ZIP 包'); });
  $('download-template').addEventListener('click', () => downloadJson({schemaVersion:1,title:'我们的聊天',participants:{husband:{name:'我的先生',avatar:''},wife:{name:'另一半',avatar:''}},messages:[],assets:{}}, '聊天导入格式模板.json'));
  $('clear-data').addEventListener('click', async () => {
    if (isDemo) { toast('当前只有演示记录，没有本地真实聊天'); return; }
    if (mediaImportController) { toast('请先完成或取消媒体导入'); return; }
    if (!window.confirm('移除这台设备上的聊天记录和已导入媒体？原始 JSON 和媒体包不会被删除。')) return;
    try { await persistPackage(null); data = validatePackage(EXAMPLE); isDemo = true; announceRecordChange(); refreshOverview(); resetFilters(); toast('本设备的记录已移除'); }
    catch (_) { toast('移除失败，请重试'); }
  });
  $('close-image').addEventListener('click', () => $('image-dialog').close());
  $('image-dialog').addEventListener('click', event => { if (event.target === $('image-dialog')) $('image-dialog').close(); });
  $('image-dialog').addEventListener('close', () => $('full-image').removeAttribute('src'));
  $('close-video').addEventListener('click',() => { $('video-dialog').close(); closeVideoPreview(); });
  $('video-dialog').addEventListener('click',event => { if (event.target === $('video-dialog')) { $('video-dialog').close(); closeVideoPreview(); } });
  $('video-dialog').addEventListener('close',() => { if (!$('video-dialog').open) closeVideoPreview(); });
  $('full-video').addEventListener('play',() => pauseOtherMedia($('full-video')));
  $('full-video').addEventListener('error',() => {
    if (!$('video-dialog').open || !$('full-video').hasAttribute('src')) return;
    $('video-preview-status').textContent = '此视频格式无法播放，请保留原始附件。'; $('video-preview-status').hidden = false;
    if (videoPreviewError) videoPreviewError();
  });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install-button').hidden = false; });
  $('install-button').addEventListener('click', async () => { if (!installPrompt) return; await installPrompt.prompt(); installPrompt = null; $('install-button').hidden = true; });
  window.addEventListener('appinstalled', () => { $('install-button').hidden = true; toast('已添加到桌面'); });
  document.addEventListener('visibilitychange',() => { if (document.hidden) pauseOtherMedia(); });
  if (recordsChannel) recordsChannel.onmessage = event => receiveRecordChange(event.data);
  window.addEventListener('storage', event => { if (event.key === 'our-chat-records-change') receiveRecordChange(event.newValue); });

  refreshOverview(); renderMessages();
  readStored().then(stored => {
    if (!stored) return;
    data = validatePackage(stored); isDemo = false;
    refreshOverview(); resetFilters();
  }).catch(() => toast('本地记录无法读取；可重新导入保留的文件'));
  if ('serviceWorker' in navigator && /^(https?:)$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => {});

  // Expose only deterministic validation for offline verification; contains no chat data.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') window.chatViewerValidation = {validatePackage, dateKey, mediaCaption, messageCategory, transferDetails};
})();
