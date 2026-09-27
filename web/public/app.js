const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), workspace = $('workspace');
let sourceFile, wav, objectUrl, analysis, envelope = [], exportBusy = false;
const RATE = 48000, CHUNK_FRAMES = 32768, PEAK_BINS = 1400;

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { const selected=fileInput.files[0];fileInput.value='';if(selected)loadFile(selected); });
$('replace').addEventListener('click', () => fileInput.click());
$('start').addEventListener('input', updateRange);
$('end').addEventListener('input', updateRange);
$('wave').addEventListener('pointerdown', moveBoundary);
$('wave').addEventListener('pointermove', e => { if (e.buttons & 1) moveBoundary(e); });
$('normalize').addEventListener('change', updateExportInfo);
$('target').addEventListener('change', updateExportInfo);
$('listen-start').addEventListener('click', () => preview(Number($('start').value)));
$('listen-end').addEventListener('click', () => preview(Math.max(0, Number($('end').value) - 8)));
$('export').addEventListener('click', exportWav);

async function loadFile(file) {
  clearError();
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=undefined;}
  if (!file.name.toLowerCase().endsWith('.wav')) return showError('WAV ファイルを選択してください。');
  sourceFile = file; $('filename').textContent = file.name;
  workspace.hidden = false; $('empty-note').hidden = true; $('editor').hidden = true; $('progress').hidden = false;
  $('progress-text').textContent = 'WAV形式を確認しています…'; $('export').disabled = true;
  try {
    wav = await parseWav(file);
    if (wav.sampleRate !== RATE || wav.bits !== 32 || wav.format !== 3 || ![1, 2].includes(wav.channels)) {
      throw Error('48 kHz・32-bit float・mono / stereo の WAV に対応しています。');
    }
    const secs = wav.frames / RATE;
    $('fileinfo').textContent = `${wav.channels === 2 ? 'Stereo' : 'Mono'} · 48 kHz · 32-bit float · ${clock(secs)} · ${formatBytes(file.size)}`;
    $('duration-label').textContent = clock(secs);
    $('progress-text').textContent = 'Rust / WASM で演奏区間を解析しています…';
    const wasm = await import('/wasm/audio_wasm.js');
    await wasm.default('/wasm/audio_wasm_bg.wasm');
    const analyzer = new wasm.WasmAnalyzer(wav.channels);
    envelope = new Array(PEAK_BINS).fill(0);
    const framesPerBin = Math.max(1, Math.ceil(wav.frames / PEAK_BINS));
    for (let offset = 0; offset < wav.frames; offset += CHUNK_FRAMES) {
      const count = Math.min(CHUNK_FRAMES, wav.frames - offset);
      const samples = await readSamples(file, wav, offset, count);
      analyzer.push(samples);
      for (let i = 0; i < samples.length; i++) {
        const frame = offset + Math.floor(i / wav.channels);
        const bin = Math.min(PEAK_BINS - 1, Math.floor(frame / framesPerBin));
        const value = Math.abs(samples[i]); if (value > envelope[bin]) envelope[bin] = value;
      }
      if (offset % (CHUNK_FRAMES * 10) === 0) {
        $('progress-text').textContent = `演奏区間を解析しています… ${Math.min(99, Math.floor(offset / wav.frames * 100))}%`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    analysis = JSON.parse(analyzer.finish());
    const begin = analysis.start_frame == null ? 0 : analysis.start_frame / RATE;
    const finish = analysis.end_frame == null ? secs : analysis.end_frame / RATE;
    $('start').value = begin.toFixed(2); $('end').value = finish.toFixed(2);
    $('status').textContent = analysis.status === 'ready' ? '自動検出 · 確認してください' : '要確認 · 手動調整してください';
    $('editor').hidden = false; $('progress').hidden = true; drawWave(); updateRange();
    objectUrl = URL.createObjectURL(file);
  } catch (err) { $('progress').hidden = true; showError(err.message || String(err)); }
}

async function parseWav(file) {
  const head = new DataView(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  const ascii = (o, n) => String.fromCharCode(...new Uint8Array(head.buffer, o, n));
  if (ascii(0,4) !== 'RIFF' || ascii(8,4) !== 'WAVE') throw Error('RIFF/WAVE 形式のファイルではありません。');
  let p=12, fmt=null, data=null;
  while (p + 8 <= head.byteLength) {
    const id=ascii(p,4), size=head.getUint32(p+4,true), start=p+8;
    if (id==='fmt ') {
      const tag=head.getUint16(start,true), channels=head.getUint16(start+2,true), sampleRate=head.getUint32(start+4,true), blockAlign=head.getUint16(start+12,true), bits=head.getUint16(start+14,true);
      let format=tag; if (tag===0xfffe && size>=40) format=head.getUint16(start+24,true);
      fmt={format,channels,sampleRate,blockAlign,bits};
    } else if (id==='data') { data={offset:start,size}; break; }
    p=start+size+(size&1);
  }
  if (!fmt || !data) throw Error('WAV の fmt/data チャンクが見つかりません。');
  if (fmt.blockAlign !== fmt.channels * 4 || data.offset + data.size > file.size) throw Error('WAV のチャンク情報が不正です。');
  return {...fmt, ...data, frames:Math.floor(data.size / fmt.blockAlign)};
}

async function readSamples(file, info, offset, frames) {
  const bytes=await file.slice(info.offset+offset*info.blockAlign, info.offset+(offset+frames)*info.blockAlign).arrayBuffer();
  const view=new DataView(bytes), out=new Float32Array(frames*info.channels);
  for(let i=0;i<out.length;i++) out[i]=view.getFloat32(i*4,true);
  return out;
}

function drawWave() {
  const canvas=$('wave'), ctx=canvas.getContext('2d'), w=canvas.width, h=canvas.height;
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#28342d'; ctx.fillRect(0,h/2,w,1);
  const step=w/envelope.length;
  envelope.forEach((peak,i)=>{const height=Math.max(1,Math.min(h*.45,peak*h*.45));ctx.fillStyle='#65766a';ctx.fillRect(i*step,h/2-height,Math.max(1,step*.72),height*2);});
  paintSelection();
}
function paintSelection(){
  const c=$('wave'),ctx=c.getContext('2d'),w=c.width,h=c.height;
  if(!wav)return;
  const a=Math.max(0,Math.min(1,Number($('start').value||0)/(wav.frames/RATE)))*w;
  const b=Math.max(0,Math.min(1,Number($('end').value||0)/(wav.frames/RATE)))*w;
  ctx.fillStyle='rgba(12,17,14,.61)';ctx.fillRect(0,0,a,h);ctx.fillRect(b,0,w-b,h);
  ctx.fillStyle='#d4ef83';ctx.fillRect(a,0,2,h);ctx.fillRect(b-2,0,2,h);
}
function moveBoundary(event){
  if(!wav||$('editor').hidden)return;
  const canvas=$('wave'),bounds=canvas.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width));
  const seconds=fraction*(wav.frames/RATE),start=Number($('start').value),end=Number($('end').value);
  const input=Math.abs(seconds-start)<=Math.abs(seconds-end)?$('start'):$('end');
  input.value=seconds.toFixed(2);updateRange();
}
function updateRange(){
  if(!wav)return; const duration=wav.frames/RATE;
  let a=Math.max(0,Math.min(duration,Number($('start').value)||0)), b=Math.max(0,Math.min(duration,Number($('end').value)||0));
  if(a>=b){$('export').disabled=true;$('selection-length').textContent='範囲が不正です';return;}
  $('selection-length').textContent=`${clock(b-a)} を書き出し`;
  $('export').disabled=false; drawWave(); updateExportInfo();
}
function updateExportInfo(){
  if(!wav)return; const a=Number($('start').value),b=Number($('end').value),gain=$('normalize').checked?'自動ノーマライズ':'ゲイン変更なし';
  $('export-info').textContent=`${clock(Math.max(0,b-a))} · ${gain}`;
}
function preview(seconds){
  if(!objectUrl)return;const player=new Audio(objectUrl);player.addEventListener('loadedmetadata',()=>{player.currentTime=seconds;player.play().catch(()=>showError('このブラウザでは WAV を試聴できません。'));},{once:true});
}
async function exportWav(){
  if(exportBusy||!wav)return;const start=Number($('start').value),end=Number($('end').value);
  const first=Math.round(start*RATE),last=Math.round(end*RATE),frames=last-first;
  if(first<0||last>wav.frames||frames<1)return showError('開始・終了位置を確認してください。');
  // Blob assembly holds output parts in memory; keep the browser export bounded.
  const outputBytes=44+frames*wav.channels*4;
  if(outputBytes>512*1024*1024)return showError('ブラウザでの書き出しは 512 MiB までです。長時間録音は Rust CLI 版をご利用ください。');
  exportBusy=true;$('export').disabled=true;$('export').textContent='書き出しています…';clearError();
  try{
    let peak=0;
    if($('normalize').checked){for(let o=first;o<last;o+=CHUNK_FRAMES){const a=await readSamples(sourceFile,wav,o,Math.min(CHUNK_FRAMES,last-o));for(const x of a)peak=Math.max(peak,Math.abs(x));}}
    const target=Number($('target').value),gain=$('normalize').checked&&peak>0?target/peak:1;
    if(gain>1e6||!Number.isFinite(gain))throw Error('音量を正規化できません。');
    const parts=[makeHeader(frames,wav.channels)];
    for(let o=first;o<last;o+=CHUNK_FRAMES){const a=await readSamples(sourceFile,wav,o,Math.min(CHUNK_FRAMES,last-o));if(gain!==1){for(let i=0;i<a.length;i++)a[i]=Math.max(-1,Math.min(1,a[i]*gain));}parts.push(a.buffer);}
    const blob=new Blob(parts,{type:'audio/wav'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=sourceFile.name.replace(/\.wav$/i,'')+'_clip.wav';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(err){showError(err.message||String(err));}
  finally{exportBusy=false;$('export').disabled=false;$('export').innerHTML='WAVを書き出す <span>↓</span>';}
}
function makeHeader(frames,channels){const buffer=new ArrayBuffer(44),v=new DataView(buffer),bytes=frames*channels*4;const tag=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));tag(0,'RIFF');v.setUint32(4,36+bytes,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,3,true);v.setUint16(22,channels,true);v.setUint32(24,RATE,true);v.setUint32(28,RATE*channels*4,true);v.setUint16(32,channels*4,true);v.setUint16(34,32,true);tag(36,'data');v.setUint32(40,bytes,true);return buffer;}
function clock(s){if(!Number.isFinite(s))return '0:00';const m=Math.floor(s/60),ss=Math.floor(s%60);return `${m}:${String(ss).padStart(2,'0')}`;}
function formatBytes(n){return n<1024*1024?`${(n/1024).toFixed(0)} KB`:`${(n/1024/1024).toFixed(1)} MB`;}
function showError(message){const el=$('error');el.textContent=message;el.hidden=false;}
function clearError(){$('error').hidden=true;}
