'use strict';

(() => {
  const CHUNK_SIZE = 2 * 1024 * 1024;
  const MAX_DIRECTORY = 32 * 1024 * 1024;
  const MAX_MANIFEST = 16 * 1024 * 1024;
  const MIME = /^(?:image\/(?:png|jpeg|jpg|gif|webp|avif)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|aac|webm|flac|x-m4a)|video\/(?:mp4|webm|quicktime)|application\/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}|text\/plain)$/;
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
  function updateCrc(crc, bytes) { for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8); return crc >>> 0; }
  function checkAbort(signal) { if (signal && signal.aborted) throw new DOMException('已取消导入', 'AbortError'); }
  function invalid(message) { throw new Error(`媒体包无效：${message}`); }
  function safePath(path) {
    return typeof path === 'string' && path.length > 0 && path.length <= 500 && !/[\\\x00-\x1f:]/.test(path) && !path.startsWith('/') && !path.endsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
  }
  async function readRange(file, start, size) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > file.size) invalid('文件范围越界');
    return new Uint8Array(await file.slice(start, start + size).arrayBuffer());
  }
  function decodeName(bytes) { try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch (_) { invalid('文件名不是有效 UTF-8'); } }
  function rejectZip64(extra) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    for (let p = 0; p < extra.length;) {
      if (p + 4 > extra.length) invalid('ZIP 扩展字段损坏');
      const id = view.getUint16(p, true); const length = view.getUint16(p + 2, true);
      if (p + 4 + length > extra.length || id === 1) invalid('不支持 Zip64 或损坏的扩展字段');
      p += 4 + length;
    }
  }
  async function crcBlob(blob, signal, progress) {
    let crc = 0xffffffff;
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      checkAbort(signal);
      const bytes = new Uint8Array(await blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size)).arrayBuffer());
      crc = updateCrc(crc, bytes);
      if (progress) progress(Math.min(offset + bytes.length, blob.size));
    }
    checkAbort(signal); return (crc ^ 0xffffffff) >>> 0;
  }
  async function copyAssetBytes(file, item, signal, progress) {
    const parts = []; let crc = 0xffffffff;
    for (let offset = 0; offset < item.size; offset += CHUNK_SIZE) {
      checkAbort(signal);
      const length = Math.min(CHUNK_SIZE,item.size - offset);
      const bytes = await readRange(file,item.dataOffset + offset,length);
      checkAbort(signal); crc = updateCrc(crc,bytes);
      // Materialize bytes before persisting. A Blob sliced from the selected ZIP
      // can retain the entire source file in WebKit's IndexedDB backing storage.
      // Wrapping that slice in another Blob would still retain the source.
      parts.push(new Blob([bytes]));
      if (progress) progress(offset + length);
    }
    checkAbort(signal);
    return {blob:new Blob(parts,{type:item.mime}),crc32:(crc ^ 0xffffffff) >>> 0};
  }
  async function storageEstimate(getEstimate) {
    if (typeof getEstimate !== 'function') return null;
    try {
      const value = await getEstimate();
      if (!value || !Number.isFinite(value.usage) || value.usage < 0) return null;
      return {usage:value.usage,quota:Number.isFinite(value.quota) && value.quota >= 0 ? value.quota : null};
    } catch (_) { return null; }
  }
  function storageError(name,message) { const error = new Error(message); error.name = name; return error; }
  function checkStorageGrowth(baseline,current,writtenBytes) {
    if (baseline && current && current.usage - baseline.usage > writtenBytes * 4 + 64 * 1024 * 1024) {
      throw storageError('StorageGrowthError','检测到浏览器存储异常增长，已停止导入。请先检查 iPhone 储存空间，不要继续导入大包。');
    }
  }
  async function parseStoredZip(file, signal) {
    checkAbort(signal);
    if (!file || !Number.isSafeInteger(file.size) || file.size < 22 || file.size >= 0xffffffff) invalid('需要小于 4 GB 的普通 ZIP 包');
    const tailLength = Math.min(file.size, 65557); const tail = await readRange(file, file.size - tailLength, tailLength);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength); let end = -1;
    for (let p = tail.length - 22; p >= 0; p--) {
      if (tailView.getUint32(p, true) === 0x06054b50 && p + 22 + tailView.getUint16(p + 20, true) === tail.length) { end = p; break; }
    }
    if (end < 0) invalid('找不到完整的 ZIP 结尾');
    const disk = tailView.getUint16(end + 4, true); const directoryDisk = tailView.getUint16(end + 6, true);
    const countOnDisk = tailView.getUint16(end + 8, true); const count = tailView.getUint16(end + 10, true);
    const directorySize = tailView.getUint32(end + 12, true); const directoryOffset = tailView.getUint32(end + 16, true);
    const endOffset = file.size - tailLength + end;
    if (disk || directoryDisk || countOnDisk !== count || count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) invalid('不支持分卷 ZIP 或 Zip64');
    if (!count || directorySize > MAX_DIRECTORY || directoryOffset + directorySize !== endOffset) invalid('中央目录范围不正确');
    const directory = await readRange(file, directoryOffset, directorySize);
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength); const entries = new Map(); let offset = 0;
    for (let i = 0; i < count; i++) {
      checkAbort(signal);
      if (offset + 46 > directory.length || view.getUint32(offset, true) !== 0x02014b50) invalid('中央目录损坏');
      const flags = view.getUint16(offset + 8, true); const method = view.getUint16(offset + 10, true);
      const crc32 = view.getUint32(offset + 16, true); const compressedSize = view.getUint32(offset + 20, true); const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true); const extraLength = view.getUint16(offset + 30, true); const commentLength = view.getUint16(offset + 32, true);
      const entryDisk = view.getUint16(offset + 34, true); const localOffset = view.getUint32(offset + 42, true);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length || !nameLength || entryDisk || localOffset === 0xffffffff || size === 0xffffffff || compressedSize === 0xffffffff) invalid('文件条目范围不正确或需要 Zip64');
      if (flags & 1 || flags & 0x40 || method !== 0 || compressedSize !== size) invalid('仅支持未加密的 ZIP_STORED 媒体包');
      const path = decodeName(directory.subarray(offset + 46, offset + 46 + nameLength));
      if (!safePath(path) || entries.has(path)) invalid('包含危险或重复的相对路径');
      rejectZip64(directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
      entries.set(path, {path, flags, method, crc32, size, localOffset}); offset = next;
    }
    if (offset !== directory.length || !entries.has('manifest.json')) invalid('中央目录条数不符或缺少 manifest.json');
    const ranges = [];
    for (const entry of entries.values()) {
      checkAbort(signal);
      const header = await readRange(file, entry.localOffset, 30); const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (h.getUint32(0, true) !== 0x04034b50 || h.getUint16(6, true) !== entry.flags || h.getUint16(8, true) !== 0) invalid('本地文件头与中央目录不一致');
      const nameLength = h.getUint16(26, true); const extraLength = h.getUint16(28, true);
      const nameExtra = await readRange(file, entry.localOffset + 30, nameLength + extraLength);
      if (decodeName(nameExtra.subarray(0, nameLength)) !== entry.path) invalid('本地文件名与中央目录不一致');
      rejectZip64(nameExtra.subarray(nameLength));
      if (!(entry.flags & 8) && (h.getUint32(14, true) !== entry.crc32 || h.getUint32(18, true) !== entry.size || h.getUint32(22, true) !== entry.size)) invalid('本地文件大小或 CRC 不一致');
      entry.dataOffset = entry.localOffset + 30 + nameLength + extraLength;
      if (entry.dataOffset + entry.size > directoryOffset) invalid('媒体文件超出数据区');
      ranges.push([entry.localOffset, entry.dataOffset + entry.size]);
    }
    ranges.sort((a,b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) invalid('文件范围重叠');
    const manifestEntry = entries.get('manifest.json');
    if (manifestEntry.size > MAX_MANIFEST) invalid('manifest.json 超过 16 MB');
    const manifestBytes = await readRange(file, manifestEntry.dataOffset, manifestEntry.size);
    if (((updateCrc(0xffffffff, manifestBytes) ^ 0xffffffff) >>> 0) !== manifestEntry.crc32) invalid('manifest.json 的 CRC 校验失败');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch (_) { invalid('manifest.json 不是有效 JSON'); }
    if (!globalThis.crypto || !crypto.subtle) throw new Error('请通过 HTTPS 或 localhost 打开应用，再导入媒体包。');
    const fingerprint = new TextEncoder().encode(JSON.stringify(manifest) + '\n' + JSON.stringify([...entries.values()].map(item => [item.path,item.size,item.crc32])));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprint));
    const packId = [...digest].map(value => value.toString(16).padStart(2,'0')).join('');
    return {entries, manifest, packId};
  }
  function validateManifest(raw, conversationId, entries) {
    if (!raw || typeof raw !== 'object' || raw.kind !== 'our-chat-media' || raw.schemaVersion !== 1) invalid('媒体清单格式不正确');
    if (!/^[a-f0-9]{24}$/i.test(raw.conversationId || '') || raw.conversationId.toLowerCase() !== conversationId) throw new Error('这个媒体包不属于当前聊天，请选择与聊天 JSON 对应的媒体包。');
    if (!Array.isArray(raw.assets) || raw.assets.length > 50000 || !Array.isArray(raw.messageAssets) || raw.messageAssets.length > 500000) invalid('附件或消息链接数组不正确');
    const keys = new Set(); const paths = new Set(); let totalBytes = 0;
    const assets = raw.assets.map(item => {
      if (!item || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.key || '') || !safePath(item.path) || !item.path.startsWith('assets/') || keys.has(item.key) || paths.has(item.path) || !MIME.test(item.mime || '') || !Number.isSafeInteger(item.size) || item.size < 0) invalid('附件信息不正确');
      const entry = entries.get(item.path);
      if (!entry || entry.size !== item.size || (item.crc32 != null && (!Number.isInteger(item.crc32) || item.crc32 < 0 || item.crc32 > 0xffffffff || item.crc32 !== entry.crc32))) invalid('附件大小或 CRC 与 ZIP 不一致');
      keys.add(item.key); paths.add(item.path); totalBytes += item.size;
      return {path:item.path,key:item.key,mime:item.mime,size:item.size,crc32:entry.crc32,dataOffset:entry.dataOffset};
    });
    const ids = new Set();
    const links = raw.messageAssets.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 || /\x00/.test(item.id) || ids.has(item.id) || !keys.has(item.asset)) invalid('消息与附件的对应信息不正确');
      if (item.duration != null && (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0)) invalid('附件时长不正确');
      ids.add(item.id); return {id:item.id,key:item.asset,duration:item.duration == null ? null : item.duration};
    });
    return {conversationId,assets,links,totalBytes};
  }
  function createImporter(store) {
    return async function importPack(file, conversationId, options = {}) {
      const {signal,onProgress = () => {},getStorageEstimate} = options;
      if (!/^[a-f0-9]{24}$/.test(conversationId || '')) throw new Error('请先导入包含会话标识的聊天 JSON。');
      onProgress({phase:'reading',name:file.name || '媒体包'});
      const parsed = await parseStoredZip(file, signal);
      const manifest = validateManifest(parsed.manifest, conversationId, parsed.entries);
      const previous = await store.getPack(conversationId,parsed.packId);
      if (previous && previous.status === 'complete') { onProgress({phase:'complete',name:file.name,skipped:true,totalBytes:manifest.totalBytes,bytesDone:manifest.totalBytes,totalAssets:manifest.assets.length,assetIndex:manifest.assets.length}); return {skipped:true,assets:manifest.assets.length,bytes:manifest.totalBytes}; }
      const baseline = await storageEstimate(getStorageEstimate); let writtenBytes = 0;
      const state = {conversationId,packId:parsed.packId,name:String(file.name || '媒体包').slice(0,200),status:'incomplete',assetsCompleted:0,totalAssets:manifest.assets.length,totalBytes:manifest.totalBytes};
      await store.writePack(state); let bytesDone = 0;
      for (let i = 0; i < manifest.assets.length; i++) {
        checkAbort(signal); const item = manifest.assets[i]; const existing = await store.getAssetInfo(conversationId,item.key);
        if (existing && (existing.size !== item.size || existing.crc32 !== item.crc32 || existing.mime !== item.mime)) invalid('同一附件键对应不同内容');
        if (!existing) {
          const available = await storageEstimate(getStorageEstimate); checkAbort(signal);
          checkStorageGrowth(baseline,available,writtenBytes);
          if (available && available.quota !== null && available.quota - available.usage < item.size + 32 * 1024 * 1024) {
            throw storageError('StorageSpaceError','浏览器估计可用空间不足，已停止导入。请检查设备储存空间后再继续。');
          }
          const copied = await copyAssetBytes(file,item,signal,done => onProgress({phase:'checking',name:state.name,assetIndex:i,totalAssets:manifest.assets.length,bytesDone:bytesDone + done,totalBytes:manifest.totalBytes}));
          if (copied.crc32 !== item.crc32) invalid(`附件 ${item.key} 的 CRC 校验失败，请重新复制原媒体包`);
          checkAbort(signal); state.assetsCompleted = i + 1;
          await store.putAsset(conversationId,item,copied.blob,{...state}); writtenBytes += item.size;
          const after = await storageEstimate(getStorageEstimate); checkAbort(signal);
          checkStorageGrowth(baseline,after,writtenBytes);
        }
        bytesDone += item.size; state.assetsCompleted = i + 1;
        onProgress({phase:'saving',name:state.name,assetIndex:i + 1,totalAssets:manifest.assets.length,bytesDone,totalBytes:manifest.totalBytes});
      }
      for (let i = 0; i < manifest.links.length; i += 250) { checkAbort(signal); await store.putLinks(conversationId,manifest.links.slice(i,i + 250)); }
      checkAbort(signal); state.status = 'complete'; state.assetsCompleted = manifest.assets.length; await store.writePack(state);
      onProgress({phase:'complete',name:state.name,totalAssets:manifest.assets.length,assetIndex:manifest.assets.length,bytesDone,totalBytes:manifest.totalBytes});
      return {skipped:false,assets:manifest.assets.length,bytes:manifest.totalBytes};
    };
  }
  function createIndexedDBStore(getDatabase) {
    async function read(storeName,key) {
      const db = await getDatabase();
      return new Promise((resolve,reject) => { const request = db.transaction(storeName,'readonly').objectStore(storeName).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    }
    async function write(names,setup) {
      const db = await getDatabase();
      return new Promise((resolve,reject) => {
        const tx = db.transaction(names,'readwrite'); let failure;
        const fail = error => { if (failure) return; failure = error; try { tx.abort(); } catch (_) {} };
        tx.oncomplete = resolve; tx.onerror = () => reject(failure || tx.error); tx.onabort = () => reject(failure || tx.error || new Error('本地保存已停止'));
        setup(tx,fail);
      });
    }
    function guard(tx,conversationId,fail,ready) {
      const request = tx.objectStore('records').get('activeConversation');
      request.onsuccess = () => { if (!request.result || request.result.conversationId !== conversationId) fail(new Error('当前聊天已更换或移除，媒体导入已停止。')); else ready(); };
    }
    const store = {
      getPack:(cid,id) => read('importedPacks',[cid,id]),
      async getAssetInfo(cid,key) { const item = await read('media',[cid,key]); return item && {size:item.size,crc32:item.crc32,mime:item.mime}; },
      async putAsset(cid,item,blob,state) {
        await write(['media','records','importedPacks'],(tx,fail) => guard(tx,cid,fail,() => {
          const media = tx.objectStore('media'); const request = media.get([cid,item.key]);
          request.onsuccess = () => {
            const old = request.result;
            if (old && (old.size !== item.size || old.crc32 !== item.crc32 || old.mime !== item.mime)) { fail(new Error('已有附件与媒体包不一致')); return; }
            if (!old) {
              const totalsRequest = tx.objectStore('records').get(['mediaTotal',cid]);
              totalsRequest.onsuccess = () => {
                const totals = totalsRequest.result || {count:0,bytes:0,packs:0}; totals.count++; totals.bytes += item.size;
                media.put({conversationId:cid,key:item.key,size:item.size,crc32:item.crc32,mime:item.mime,blob},[cid,item.key]);
                tx.objectStore('records').put(totals,['mediaTotal',cid]);
              };
            }
            const packs = tx.objectStore('importedPacks'); const packRequest = packs.get([cid,state.packId]);
            packRequest.onsuccess = () => { if (!packRequest.result || packRequest.result.status !== 'complete') packs.put(state,[cid,state.packId]); };
          };
        }));
      },
      putLinks:(cid,links) => write(['mediaLinks','records'],(tx,fail) => guard(tx,cid,fail,() => {
        const linksStore = tx.objectStore('mediaLinks');
        for (const link of links) {
          const request = linksStore.get([cid,link.id]);
          request.onsuccess = () => {
            const old = request.result;
            if (old && old.key !== link.key) { fail(new Error('媒体包与已有消息附件对应关系冲突，已有对应关系已保留。')); return; }
            linksStore.put({conversationId:cid,...link,duration:link.duration == null && old ? old.duration : link.duration},[cid,link.id]);
          };
        }
      })),
      writePack:state => write(['importedPacks','records'],(tx,fail) => guard(tx,state.conversationId,fail,() => {
        const packs = tx.objectStore('importedPacks'); const request = packs.get([state.conversationId,state.packId]);
        request.onsuccess = () => {
          if (request.result && request.result.status === 'complete' && state.status === 'incomplete') return;
          if (state.status === 'complete' && (!request.result || request.result.status !== 'complete')) {
            const totalsRequest = tx.objectStore('records').get(['mediaTotal',state.conversationId]);
            totalsRequest.onsuccess = () => { const totals = totalsRequest.result || {count:0,bytes:0,packs:0}; totals.packs++; tx.objectStore('records').put(totals,['mediaTotal',state.conversationId]); };
          }
          packs.put(state,[state.conversationId,state.packId]);
        };
      })),
      async getMessageMedia(cid,id,reference) {
        const link = await read('mediaLinks',[cid,id]); const key = link ? link.key : reference;
        if (!key) return null;
        const media = await read('media',[cid,key]); return media ? {blob:media.blob,mime:media.mime,duration:link ? link.duration : null} : null;
      },
      async stats(cid) { return cid ? await read('records',['mediaTotal',cid]) || {count:0,bytes:0,packs:0} : {count:0,bytes:0,packs:0}; }
    };
    return store;
  }
  globalThis.OurChatMedia = {parseStoredZip,validateManifest,createImporter,createIndexedDBStore,crcBlob,CHUNK_SIZE};
})();
