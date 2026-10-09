import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const context = {Blob,TextDecoder,TextEncoder,DOMException,crypto:webcrypto,console};
vm.runInNewContext(fs.readFileSync(path.join(root,'dist','media.js'),'utf8'),context);
const api = context.OurChatMedia;
const cid = '0123456789abcdef01234567';
const image = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cgwAAAABJRU5ErkJggg==','base64'));
async function zip(entries,name='media-test.zip') {
  const parts = []; const directory = []; let offset = 0;
  for (const entry of entries) {
    const filename = new TextEncoder().encode(entry.path); const blob = entry.blob || new Blob([entry.bytes]);
    const crc = entry.crc32 == null ? await api.crcBlob(blob) : entry.crc32;
    const header = new Uint8Array(30 + filename.length); const h = new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true); h.setUint16(4,20,true); h.setUint16(6,0x800,true); h.setUint16(8,entry.method || 0,true);
    h.setUint32(14,crc,true); h.setUint32(18,blob.size,true); h.setUint32(22,blob.size,true); h.setUint16(26,filename.length,true); header.set(filename,30);
    const central = new Uint8Array(46 + filename.length); const c = new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true); c.setUint16(10,entry.method || 0,true);
    c.setUint32(16,crc,true); c.setUint32(20,blob.size,true); c.setUint32(24,blob.size,true); c.setUint16(28,filename.length,true); c.setUint32(42,offset,true); central.set(filename,46);
    parts.push(header,blob); directory.push(central); offset += header.length + blob.size;
  }
  const size = directory.reduce((sum,part) => sum + part.length,0); const end = new Uint8Array(22); const e = new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true); e.setUint16(8,entries.length,true); e.setUint16(10,entries.length,true); e.setUint32(12,size,true); e.setUint32(16,offset,true);
  const result = new Blob([...parts,...directory,end],{type:'application/zip'}); result.name = name; return result;
}
async function pack(assets = [{key:'photo.png',bytes:image,mime:'image/png'}],overrides={}) {
  const manifest = {kind:'our-chat-media',schemaVersion:1,conversationId:cid,assets:assets.map(item => ({key:item.key,path:`assets/${item.key}`,mime:item.mime,size:(item.blob || new Blob([item.bytes])).size})),messageAssets:assets.map((item,index) => ({id:`message_0.db:${index + 1}`,asset:item.key})),...overrides};
  const entries = [{path:'manifest.json',bytes:new TextEncoder().encode(JSON.stringify(manifest))},...assets.map(item => ({path:`assets/${item.key}`,bytes:item.bytes,blob:item.blob,crc32:item.crc32,method:item.method}))];
  return zip(entries);
}
function memoryStore() {
  const assets = new Map(); const packs = new Map(); const links = new Map(); let puts = 0; let quotaAfter = Infinity;
  return {assets,packs,links,get puts(){return puts;},set quotaAfter(value){quotaAfter=value;},
    async getPack(cid,id){return packs.get(`${cid}/${id}`);},
    async writePack(state){const key = `${state.conversationId}/${state.packId}`; const old = packs.get(key); if (old?.status === 'complete' && state.status === 'incomplete') return; packs.set(key,{...state});},
    async getAssetInfo(cid,key){const entry=assets.get(`${cid}/${key}`); return entry && {size:entry.size,crc32:entry.crc32,mime:entry.mime};},
    async putAsset(cid,item,blob,state){if (puts >= quotaAfter) throw new DOMException('quota','QuotaExceededError'); assert(blob instanceof Blob); assets.set(`${cid}/${item.key}`,{...item,blob}); puts++; await this.writePack(state);},
    async putLinks(cid,values){for(const item of values) links.set(`${cid}/${item.id}`,item);}
  };
}
const store = memoryStore(); const importer = api.createImporter(store); const good = await pack();
assert.equal((await importer(good,cid)).skipped,false); assert.equal(store.assets.size,1); assert.equal(store.links.size,1);
assert.equal((await importer(good,cid)).skipped,true); assert.equal(store.puts,1);
const filesStore=memoryStore();
const filesPack=await pack([{key:'test.pdf',bytes:new TextEncoder().encode('%PDF-1.4\n%%EOF'),mime:'application/pdf'},{key:'document.docx',bytes:new Uint8Array([80,75,3,4]),mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},{key:'download.html',bytes:new TextEncoder().encode('<script>window.__fileExecuted=true</script>'),mime:'application/octet-stream'}]);
await api.createImporter(filesStore)(filesPack,cid);assert.equal(filesStore.assets.size,3);assert.equal(filesStore.links.size,3);
const wrongStore = memoryStore(); await assert.rejects(api.createImporter(wrongStore)(good,'ffffffffffffffffffffffff'),/不属于/); assert.equal(wrongStore.assets.size,0); assert.equal(wrongStore.packs.size,0);
const originalCrc = await api.crcBlob(new Blob([image])); const changed = image.slice(); changed[10] ^= 3;
const corrupt = await pack([{key:'corrupt.png',bytes:changed,mime:'image/png',crc32:originalCrc}]);
const badStore = memoryStore(); await assert.rejects(api.createImporter(badStore)(corrupt,cid),/CRC/); assert.equal(badStore.assets.size,0); assert.equal([...badStore.packs.values()][0].status,'incomplete');
await assert.rejects(api.parseStoredZip(good.slice(0,good.size-5)),/结尾/);
const compressed = await pack([{key:'compressed.png',bytes:image,mime:'image/png',method:8}]); await assert.rejects(api.parseStoredZip(compressed),/ZIP_STORED/);
const dangerous = await zip([{path:'manifest.json',bytes:new TextEncoder().encode('{}')},{path:'../escape.png',bytes:image}]); await assert.rejects(api.parseStoredZip(dangerous),/危险/);
const secondImage = image.slice(); secondImage[20] ^= 1;
const two = await pack([{key:'one.png',bytes:image,mime:'image/png'},{key:'two.png',bytes:secondImage,mime:'image/png'}]);
const resumeStore = memoryStore(); const resume = api.createImporter(resumeStore); const controller = new AbortController();
await assert.rejects(resume(two,cid,{signal:controller.signal,onProgress(state){if(state.phase==='saving' && state.assetIndex===1) controller.abort();}}),error => error.name==='AbortError');
assert.equal(resumeStore.assets.size,1); assert.equal([...resumeStore.packs.values()][0].status,'incomplete');
await resume(two,cid); assert.equal(resumeStore.assets.size,2); assert.equal(resumeStore.puts,2); assert.equal(resumeStore.links.size,2);
const quotaStore = memoryStore(); quotaStore.quotaAfter=1; const quotaImport=api.createImporter(quotaStore);
await assert.rejects(quotaImport(two,cid),error => error.name==='QuotaExceededError'); assert.equal(quotaStore.assets.size,1);
quotaStore.quotaAfter=Infinity; await quotaImport(two,cid); assert.equal(quotaStore.assets.size,2); assert.equal(quotaStore.puts,2);
let largestRead=0; let wholeReads=0;
function boundReads(blob,whole=false) {
  const arrayBuffer=blob.arrayBuffer.bind(blob); const slice=blob.slice.bind(blob);
  blob.arrayBuffer=() => {if(whole){wholeReads++;throw new Error('Whole ZIP read forbidden');} largestRead=Math.max(largestRead,blob.size);assert(blob.size<=api.CHUNK_SIZE,'Media read exceeded 2 MiB');return arrayBuffer();};
  blob.slice=(start,end,type) => boundReads(slice(start,end,type)); return blob;
}
const megabyte = new Uint8Array(1024 * 1024); const largeBlob = new Blob(Array.from({length:64},() => megabyte),{type:'video/mp4'});
const large = boundReads(await pack([{key:'large.mp4',blob:largeBlob,mime:'video/mp4'}]),true);
const largeStore=memoryStore(); await api.createImporter(largeStore)(large,cid);
assert.equal(wholeReads,0);assert(largestRead<=api.CHUNK_SIZE);assert.equal(largeStore.assets.values().next().value.blob.size,64*1024*1024);
if(process.argv.includes('--fixtures')) {
  const fixtureRoot=path.join(root,'qa-media');fs.mkdirSync(fixtureRoot,{recursive:true});
  const chat={schemaVersion:1,title:'测试聊天',metadata:{conversationId:cid},participants:{husband:{name:'测试甲'},wife:{name:'测试乙'}},messages:[{id:'message_0.db:1',sender:'wife',timestamp:1234,type:'image',text:'仅供测试的单像素图片'}],assets:{}};
  fs.writeFileSync(path.join(fixtureRoot,'chat.json'),JSON.stringify(chat));
  fs.writeFileSync(path.join(fixtureRoot,'media-good.zip'),Buffer.from(await good.arrayBuffer()));
  fs.writeFileSync(path.join(fixtureRoot,'media-corrupt.zip'),Buffer.from(await corrupt.arrayBuffer()));
  const wrong=await pack(undefined,{conversationId:'ffffffffffffffffffffffff'});fs.writeFileSync(path.join(fixtureRoot,'media-wrong.zip'),Buffer.from(await wrong.arrayBuffer()));
  const fileChat={...chat,messages:[{id:'message_0.db:1',sender:'wife',timestamp:1234,type:'file',fileName:'测试文档.pdf'},{id:'message_0.db:2',sender:'husband',timestamp:1235,type:'file',fileName:'文件卡片.docx'},{id:'message_0.db:3',sender:'wife',timestamp:1236,type:'file',fileName:'仅下载不执行.html'}]};
  fs.writeFileSync(path.join(fixtureRoot,'chat-files.json'),JSON.stringify(fileChat));fs.writeFileSync(path.join(fixtureRoot,'media-files.zip'),Buffer.from(await filesPack.arrayBuffer()));
}
console.log('PASS: ZIP_STORED image/PDF/Office/opaque-file import, manifest/conversation validation, repeat skip, corrupt/truncated/unsafe/compressed rejection, cancellation/resume, quota resume, 64 MiB Blob with <=2 MiB reads and no whole-ZIP arrayBuffer.');
