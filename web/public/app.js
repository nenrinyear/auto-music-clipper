const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), workspace = $('workspace');
let sourceFile, wav, objectUrl, analysis, envelope = [], exportBusy = false, jobId;
const RATE = 48000, PEAK_BINS = 1400, UPLOAD_BYTES = 8 * 1024 * 1024;

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { const selected=fileInput.files[0];fileInput.value='';if(selected)loadFile(selected); });
$('replace').addEventListener('click', () => fileInput.click());
$('begin-analysis').addEventListener('click', startAnalysis);
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
  sourceFile=undefined;wav=undefined;jobId=undefined;workspace.hidden=true;$('empty-note').hidden=false;
  if (!file.name.toLowerCase().endsWith('.wav')) return showError('WAV ファイルを選択してください。');
  sourceFile = file; $('filename').textContent = file.name;
  workspace.hidden = false; $('empty-note').hidden = true; $('editor').hidden = true; $('progress').hidden = true; $('preflight').hidden = true;
  $('export').disabled = true;
  try {
    wav = await parseWav(file);
    if (wav.sampleRate !== RATE || wav.bits !== 32 || wav.format !== 3 || ![1, 2].includes(wav.channels)) {
      throw Error('48 kHz・32-bit float・mono / stereo の WAV に対応しています。');
    }
    const secs = wav.frames / RATE;
    $('fileinfo').textContent = `${wav.channels === 2 ? 'Stereo' : 'Mono'} · 48 kHz · 32-bit float · ${clock(secs)} · ${formatBytes(file.size)}`;
    $('duration-label').textContent = clock(secs);
    objectUrl = URL.createObjectURL(file);
    $('preflight').hidden = false;
    $('begin-analysis').disabled = false;
  } catch (err) { showError(err.message || String(err)); }
}

async function startAnalysis(){
  if(!sourceFile||!wav)return;
  $('preflight').hidden=true;$('progress').hidden=false;$('progress-text').textContent='Cloudflareへ録音を送信しています…';$('begin-analysis').disabled=true;clearError();
  try{
    const created=await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileBytes:sourceFile.size,dataOffset:wav.offset,dataBytes:wav.size,frames:wav.frames,channels:wav.channels,fileName:sourceFile.name})});
    jobId=created.jobId;const parts=Math.ceil(sourceFile.size/UPLOAD_BYTES);
    envelope=[];
    for(let part=0;part<parts;part++){
      const from=part*UPLOAD_BYTES,to=Math.min(sourceFile.size,from+UPLOAD_BYTES),blob=sourceFile.slice(from,to);
      const response=await fetch(`/api/jobs/${jobId}/input/${part}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:blob});
      if(!response.ok)throw Error(await responseError(response));
      $('progress-text').textContent=`録音を送信しています… ${Math.floor((part+1)/parts*100)}%`;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const started=await api(`/api/jobs/${jobId}/analyze`,{method:'POST'});
    for(let segment=0;segment<started.segments;segment++){
      await api(`/api/jobs/${jobId}/analyze/segment/${segment}`,{method:'POST'});
      $('progress-text').textContent=`Workers上でRust/WASM解析中… ${Math.floor((segment+1)/started.segments*90)}%`;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    await api(`/api/jobs/${jobId}/analyze/finish`,{method:'POST'});
    const report=await api(`/api/jobs/${jobId}/report`);analysis=report;
    if(Array.isArray(report.waveform))envelope=report.waveform;
    $('start').value=(report.start_frame==null?0:report.start_frame/RATE).toFixed(2);
    $('end').value=(report.end_frame==null?wav.frames/RATE:report.end_frame/RATE).toFixed(2);
    $('status').textContent=report.status==='ready'?'自動検出 · 確認してください':'要確認 · 手動調整してください';
    $('editor').hidden=false;$('progress').hidden=true;drawWave();updateRange();
  }catch(err){$('progress').hidden=true;$('preflight').hidden=false;$('begin-analysis').disabled=false;showError(err.message||String(err));}
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
  if (fmt.blockAlign !== fmt.channels * 4 || data.offset + data.size > file.size || data.size % fmt.blockAlign !== 0) throw Error('WAV のチャンク情報が不正です。');
  return {...fmt, ...data, frames:Math.floor(data.size / fmt.blockAlign)};
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
  if(exportBusy||!wav||!jobId)return;const start=Number($('start').value),end=Number($('end').value);
  const first=Math.round(start*RATE),last=Math.round(end*RATE),frames=last-first;
  if(first<0||last>wav.frames||frames<1)return showError('開始・終了位置を確認してください。');
  exportBusy=true;$('export').disabled=true;$('export').textContent='Workersで書き出し中…';$('progress').hidden=false;$('progress-text').textContent='WorkersでWAVを書き出しています…';clearError();
  try{
    const started=await api(`/api/jobs/${jobId}/render`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({startFrame:first,endFrame:last,targetDb:Number($('target').value),normalize:$('normalize').checked})});
    if($('normalize').checked)for(let segment=0;segment<started.segments;segment++){
      await api(`/api/jobs/${jobId}/render/measure/${segment}`,{method:'POST'});
      $('progress-text').textContent=`Workers上でピーク測定中… ${Math.floor((segment+1)/started.segments*45)}%`;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const prepared=await api(`/api/jobs/${jobId}/render/prepare`,{method:'POST'});
    for(let segment=0;segment<prepared.segments;segment++){
      await api(`/api/jobs/${jobId}/render/segment/${segment}`,{method:'POST'});
      $('progress-text').textContent=`Workers上でWAVを書き出し中… ${50+Math.floor((segment+1)/prepared.segments*50)}%`;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    await api(`/api/jobs/${jobId}/render/finish`,{method:'POST'});
    const link=document.createElement('a');link.href=`/api/jobs/${jobId}/download`;link.click();
  }catch(err){showError(err.message||String(err));}
  finally{exportBusy=false;$('progress').hidden=true;$('export').disabled=false;$('export').innerHTML='WAVを書き出す <span>↓</span>';}
}
async function api(url,options={}){const response=await fetch(url,options);if(!response.ok)throw Error(await responseError(response));return response.json();}
async function responseError(response){try{const body=await response.json();return body.error||`Request failed (${response.status})`;}catch{return `Request failed (${response.status})`;}}
function clock(s){if(!Number.isFinite(s))return '0:00';const m=Math.floor(s/60),ss=Math.floor(s%60);return `${m}:${String(ss).padStart(2,'0')}`;}
function formatBytes(n){return n<1024*1024?`${(n/1024).toFixed(0)} KB`:`${(n/1024/1024).toFixed(1)} MB`;}
function showError(message){const el=$('error');el.textContent=message;el.hidden=false;}
function clearError(){$('error').hidden=true;}
