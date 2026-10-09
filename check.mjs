import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const match of js.matchAll(/\$\('([^']+)'\)/g)) assert(ids.has(match[1]), `Missing DOM ID: ${match[1]}`);
const elements = new Map();
class Element {
  constructor() { this.children = []; this.value = ''; this.textContent = ''; this.hidden = false; this.scrollHeight = 500; this.scrollTop = 0; this.clientHeight = 400; this.dataset = {}; this.classList = {add(){},remove(){},toggle(){}}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  replaceWith() {} setAttribute() {} removeAttribute() {} addEventListener() {} remove() {} click() {} focus() {} querySelector() { return null; }
}
const document = {getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); }, createTextNode(text) { return {textContent:text}; }, createDocumentFragment() { return new Element(); }, addEventListener() {}, querySelectorAll() { return []; }, body: new Element()};
const window = {addEventListener() {}, confirm() { return true; }};
const context = {document, window, navigator: {}, location:{hostname:'localhost',protocol:'file:'}, localStorage:{getItem(){return null;},setItem(){}}, requestAnimationFrame(fn){fn();}, setTimeout(){return 1;}, clearTimeout(){}, URL, Blob, console,crypto:webcrypto,TextEncoder,TextDecoder,DOMException};
vm.runInNewContext(fs.readFileSync(path.join(root,'media.js'),'utf8'), context, {filename:'media.js'});
vm.runInNewContext(js, context, {filename:'app.js'});
const {validatePackage,dateKey,mediaCaption} = window.chatViewerValidation;
assert.equal(mediaCaption({type:'image',text:'图片附件尚未导入'}), '');
assert.equal(mediaCaption({type:'video',text:'视频附件尚未导入'}), '');
assert.equal(mediaCaption({type:'audio',text:'语音附件尚未导入'}), '');
assert.equal(mediaCaption({type:'image',text:'[图片]（附件未导入）'}), '');
assert.equal(mediaCaption({type:'image',text:'[图片]（仅缩略图）'}), '[图片]（仅缩略图）');
assert.equal(mediaCaption({type:'image',text:'图片附件尚未导入，请明天处理'}), '图片附件尚未导入，请明天处理');
assert.equal(mediaCaption({type:'text',text:'图片附件尚未导入'}), '图片附件尚未导入');
const empty = {schemaVersion:1,title:'我们的聊天',participants:{husband:{name:'我'},wife:{name:'她'}},messages:[],assets:{}};
const base = JSON.parse(JSON.stringify(empty));
base.messages = [
 {id:'2',sender:'wife',timestamp:'2026-10-10T00:01:00+08:00',type:'text',text:'第二条'},
 {id:'1',sender:'husband',timestamp:1791561600000,type:'image',asset:'missing-image'},
 {id:'3',sender:'husband',timestamp:'2026-10-10T00:02:00+08:00',type:'audio',duration:9}
];
const valid = validatePackage(base);
assert.equal(valid.messages.length,3);
assert(valid.messages[0].timestamp <= valid.messages[1].timestamp);
assert.equal(valid.messages[2].asset,'');
assert.equal(validatePackage(validatePackage({...empty,messages:[{sender:'wife',timestamp:123,type:'audio'}]})).messages[0].duration,null);
assert.equal(validatePackage({...empty,messages:[]}).messages.length,0);
assert.equal(validatePackage({...empty,metadata:{conversationId:'abcdef012345abcdef012345'}}).metadata.conversationId,'abcdef012345abcdef012345');
assert.throws(() => validatePackage({...empty,metadata:{conversationId:'invalid'}}));
assert.equal(validatePackage({...empty,messages:[{sender:'wife',timestamp:123,type:'file',fileName:'可读文件.pdf'}]}).messages[0].fileName,'可读文件.pdf');
assert.equal(validatePackage({...empty,messages:[{sender:'wife',timestamp:123,type:'file',fileName:'../bad.html'}]}).messages[0].fileName,'.._bad.html');
assert.throws(() => validatePackage({...empty,messages:[{sender:'wife',timestamp:123,type:'file',fileName:1}]}));
assert.equal(validatePackage({...empty,assets:{'file.pdf':'data:application/pdf;base64,YQ=='}}).assets['file.pdf'],'data:application/pdf;base64,YQ==');
assert.throws(() => validatePackage({...empty,schemaVersion:2}));
assert.throws(() => validatePackage({...empty,messages:[{sender:'wife',timestamp:'invalid',type:'text'}]}));
assert.throws(() => validatePackage({...empty,messages:[{sender:'unknown',timestamp:123,type:'text'}]}));
assert.throws(() => validatePackage({...empty,messages:[{id:'x',sender:'wife',timestamp:123,type:'text'},{id:'x',sender:'wife',timestamp:124,type:'text'}]}));
assert.throws(() => validatePackage({...empty,assets:{image:'https://example.com/private.png'}}));
assert.throws(() => validatePackage({...empty,assets:{image:'data:image/svg+xml;base64,PHN2Zz4='}}));
assert.equal(validatePackage({...empty,assets:{'assets/photo.png':'data:image/png;base64,YQ=='}}).assets['assets/photo.png'],'data:image/png;base64,YQ==');
assert.equal(validatePackage({...empty,participants:{husband:{avatar:'https://example.com/avatar.png'},wife:{}}}).participants.husband.avatar,'');
const malicious = '<img src=x onerror=alert(1)>';
assert.equal(validatePackage({...empty,messages:[{sender:'wife',timestamp:123,type:'text',text:malicious}]}).messages[0].text,malicious);
assert(!js.includes('innerHTML'));
assert(!js.includes('fetch('));
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));
assert.equal(manifest.display,'standalone');
assert.equal(manifest.start_url,'./');
const expected = new Date('2026-10-10T00:01:00+08:00');
const localKey = [expected.getFullYear(),String(expected.getMonth()+1).padStart(2,'0'),String(expected.getDate()).padStart(2,'0')].join('-');
assert.equal(dateKey(expected.getTime()),localKey);
console.log('PASS: DOM bindings, schema validation, sender/time/duplicate checks, safe attachments, XSS-safe record rendering, local date keys, PWA manifest.');
