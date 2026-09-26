// 表现层：单页界面。只调用 HTTP API，不含业务判定。
// 注意：本文件用模板字符串输出 HTML，内部脚本一律使用单引号与字符串拼接。

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蓝晒冲洗水回用台</title>
<style>
  :root { --bg:#eef2ea; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#4a6b3c; --warn:#9b4937; --hold:#a06a1c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
  header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
  h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0 0 6px; font-size:16px; }
  nav { display:flex; gap:8px; padding:14px 28px 0; flex-wrap:wrap; }
  nav button { border:1px solid var(--line); background:#fff; color:var(--ink); border-bottom:none; border-radius:8px 8px 0 0; padding:10px 16px; font-weight:700; cursor:pointer; }
  nav button.active { background:var(--panel); color:var(--accent); border-color:var(--accent); }
  main { padding:20px 28px; display:grid; grid-template-columns:360px 1fr; gap:18px; align-items:start; }
  form,.panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
  nav + main, main { background:transparent; }
  label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12.5px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
  button.act { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; margin-top:12px; }
  button.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  button.danger { background:var(--warn); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:end; }
  .row > div { flex:1; min-width:120px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:12px; }
  .card { display:grid; gap:6px; }
  .meta { color:var(--muted); font-size:12.5px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin-right:5px; }
  .pill.open { color:var(--accent); border-color:var(--accent); }
  .pill.pending { color:#fff; background:var(--warn); border-color:var(--warn); }
  .pill.stale { color:var(--hold); border-color:var(--hold); }
  .pill.bad { color:var(--warn); border-color:var(--warn); }
  .pill.returned { color:var(--warn); border-color:var(--warn); }
  .pill.confirmed { color:var(--accent); border-color:var(--accent); }
  #msg { position:fixed; right:20px; bottom:20px; max-width:380px; display:grid; gap:8px; z-index:9; }
  .toast { background:#20241f; color:#fff; padding:11px 14px; border-radius:8px; font-size:13.5px; }
  .toast.err { background:var(--warn); }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
  th,td { border-bottom:1px solid var(--line); padding:7px 6px; text-align:left; vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .timeline { border-left:3px solid var(--line); padding-left:14px; display:grid; gap:10px; }
  .timeline .ev { position:relative; }
  .timeline .ev::before { content:''; position:absolute; left:-21px; top:5px; width:9px; height:9px; border-radius:50%; background:var(--accent); }
  .timeline .ev.returned::before { background:var(--warn); }
  .timeline .ev.denied::before { background:var(--hold); }
  .inline { display:flex; gap:6px; align-items:center; }
  .inline input,.inline select { width:auto; }
  .full { grid-column:1 / -1; }
  @media (max-width:960px){ main{grid-template-columns:1fr; padding:14px;} header{padding:14px 16px;} nav{padding:10px 14px 0;} }
</style>
</head>
<body>
<header>
  <div><h1>蓝晒冲洗水回用台</h1><div class="meta">建缸登记 · 用途许可 · 八小时时效 · 双人复检放行 · 改单退回重算</div></div>
  <button class="act ghost" id="reload">刷新</button>
</header>
<nav>
  <button data-tab="tanks" class="active">水缸</button>
  <button data-tab="wash">登记冲洗</button>
  <button data-tab="pending">待复检</button>
  <button data-tab="history">底片用水履历</button>
</nav>
<main>
  <section id="left"></section>
  <section id="right"></section>
</main>
<div id="msg"></div>

<script>
'use strict';
var PURPOSE_LABEL = { prewash:'预洗', post_develop:'显影后', post_fix:'定影后' };
var LIMIT_TEXT = { prewash:'银盐≤50mg/L · 浊度≤20NTU', post_develop:'银盐≤20mg/L · 浊度≤10NTU', post_fix:'银盐≤10mg/L · 浊度≤5NTU' };
var state = { tab:'tanks', tanks:[], detailId:null };

function $(s){ return document.querySelector(s); }
function el(tag, attrs, html){
  var n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function(k){
    if (k === 'class') n.className = attrs[k]; else if (k.slice(0,2) === 'on') n[k] = attrs[k]; else n.setAttribute(k, attrs[k]);
  });
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function fmt(t){ return t ? new Date(t).toLocaleString('zh-CN') : '—'; }
function localNow(addMin){
  var d = new Date(Date.now() + (addMin || 0) * 60000);
  d.setSeconds(0,0);
  var p = function(x){ return String(x).padStart(2,'0'); };
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function toast(text, isErr){
  var box = $('#msg'); var t = el('div', { 'class':'toast' + (isErr ? ' err' : '') }, text);
  box.appendChild(t); setTimeout(function(){ t.remove(); }, 6000);
}
function api(path, opts){
  return fetch(path, Object.assign({ headers:{'Content-Type':'application/json'} }, opts || {}))
    .then(function(r){ return r.json().then(function(d){ if (!r.ok) throw Object.assign(new Error(d.error || '请求失败'), { data:d }); return d; }); });
}
function formObj(node){
  var o = {}; new FormData(node).forEach(function(v,k){ o[k] = v; }); return o;
}

// ---------- 水缸 ----------
function tankForm(){
  var f = el('form');
  f.innerHTML = '<h2>建缸登记</h2>'
    + '<label>缸号</label><input name="code" required placeholder="如 W-07">'
    + '<label>来源</label><input name="source" required placeholder="如 高银盐水回用 / 井水过滤">'
    + '<label>容量（升）</label><input name="capacityLiters" type="number" min="1" step="1" required>'
    + '<label>用途</label><select name="purpose">'
    + '<option value="prewash">预洗</option><option value="post_develop">显影后</option><option value="post_fix">定影后</option></select>'
    + '<button class="act">建立水缸</button>';
  f.onsubmit = function(e){
    e.preventDefault();
    api('/api/tanks', { method:'POST', body:JSON.stringify(formObj(f)) })
      .then(function(){ toast('水缸已建立'); f.reset(); loadTanks(); })
      .catch(function(err){ toast(err.message, true); });
  };
  return f;
}

function inspectionForm(tank, recheck){
  var f = el('form', { 'class':'panel', style:'margin-top:12px' });
  f.innerHTML = '<h2>' + (recheck ? '复检登记' : '登记检测') + '（' + tank.code + '）</h2>'
    + '<div class="row"><div><label>检测时间</label><input name="at" type="datetime-local" required></div>'
    + '<div><label>检测人</label><input name="inspector" required></div></div>'
    + '<div class="row"><div><label>银盐浓度 mg/L</label><input name="silverMgL" type="number" step="0.1" min="0" required></div>'
    + '<div><label>浊度 NTU</label><input name="turbidityNtu" type="number" step="0.1" min="0" required></div></div>'
    + '<label>备注</label><input name="note">'
    + '<button class="act">' + (recheck ? '提交复检' : '提交检测') + '</button>';
  f.querySelector('[name=at]').value = localNow();
  f.onsubmit = function(e){
    e.preventDefault();
    var o = formObj(f);
    o.tankId = tank.id;
    api('/api/inspections', { method:'POST', body:JSON.stringify(o) })
      .then(function(d){
        if (d.tank.status === 'open') toast(recheck ? '复检合格，缸已重新开放' : '检测已登记');
        else toast('已记录，缸仍需继续复检', true);
        loadTanks();
        if (state.tab === 'pending') renderTab();
        if (state.detailId === tank.id) openDetail(tank.id);
      })
      .catch(function(err){ toast(err.message + (err.data && err.data.code === 'recheck_same_inspector' ? '（连续两次复检须由另一人完成）' : ''), true); });
  };
  return f;
}

function tankCard(t){
  var pills = '';
  pills += '<span class="pill ' + t.status + '">' + (t.status === 'open' ? '开放中' : '待复检') + '</span>';
  if (t.status === 'open' && t.stale) pills += '<span class="pill stale">检测超八小时</span>';
  if (t.overLimit) pills += '<span class="pill bad">指标超限</span>';
  if (t.usableNow) pills += '<span class="pill open">当前可洗</span>';
  var c = el('div', { 'class':'card' });
  c.innerHTML = '<h3>' + t.code + '</h3><div>' + pills + '</div>'
    + '<div class="meta">来源：' + t.source + '</div>'
    + '<div class="meta">容量：' + t.capacityLiters + ' 升</div>'
    + '<div class="meta">用途：' + PURPOSE_LABEL[t.purpose] + '（' + LIMIT_TEXT[t.purpose] + '）</div>'
    + '<div class="meta">最近检测：' + (t.latest ? fmt(t.latest.at) + ' · 银 ' + t.latest.silverMgL + 'mg/L · 浊度 ' + t.latest.turbidityNtu + 'NTU · ' + t.latest.inspector : '无') + '</div>'
    + '<div class="meta">八小时有效至：' + fmt(t.freshUntil) + '</div>';
  var btns = el('div', { 'class':'row', style:'margin-top:6px' });
  btns.appendChild(el('button', { 'class':'act ghost', onclick:function(){ openDetail(t.id); } }, '详情 / 检测'));
  c.appendChild(btns);
  return c;
}

function openDetail(id){
  state.detailId = id;
  api('/api/tanks/' + encodeURIComponent(id)).then(function(d){
    var right = $('#right'); right.innerHTML = '';
    var t = d.tank;
    var head = el('div', { 'class':'panel full' });
    var purposeSel = '<select id="purpSel">' + Object.keys(PURPOSE_LABEL).map(function(k){
      return '<option value="' + k + '"' + (k === t.purpose ? ' selected' : '') + '>' + PURPOSE_LABEL[k] + '</option>';
    }).join('') + '</select>';
    head.innerHTML = '<h2>' + t.code + ' · 水缸档案</h2>'
      + '<div class="meta">' + t.source + ' · ' + t.capacityLiters + ' 升 · 状态：' + (t.status === 'open' ? '开放中' : '待复检') + '</div>'
      + '<div class="row" style="margin-top:10px"><div><label>改用途（原许可与后续冲洗退回重算）</label>' + purposeSel + '</div></div>';
    var chg = el('button', { 'class':'act danger' }, '变更用途并重算');
    chg.onclick = function(){
      api('/api/tanks/' + encodeURIComponent(t.id) + '/purpose', { method:'PATCH', body:JSON.stringify({ purpose:$('#purpSel').value }) })
        .then(function(){ toast('用途已变更，相关冲洗已退回重算'); loadTanks(); openDetail(t.id); })
        .catch(function(err){ toast(err.message, true); });
    };
    head.appendChild(chg);
    right.appendChild(head);

    var insp = el('div', { 'class':'panel' });
    var rows = d.inspections.map(function(x){
      return '<tr><td>' + fmt(x.at) + '</td><td>' + x.silverMgL + '</td><td>' + x.turbidityNtu + '</td><td>' + x.inspector + '</td>'
        + '<td>' + (x.kind === 'recheck' ? '复检' : '常规') + (x.editedAt ? '（已改）' : '') + '</td>'
        + '<td><button class="act ghost" data-edit="' + x.id + '">改检测</button></td></tr>';
    }).join('');
    insp.innerHTML = '<h2>检测记录</h2><table><thead><tr><th>时间</th><th>银盐mg/L</th><th>浊度NTU</th><th>检测人</th><th>类型</th><th></th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="6" class="meta">暂无检测</td></tr>') + '</tbody></table>'
      + '<div id="editBox"></div>';
    right.appendChild(insp);
    Array.prototype.forEach.call(insp.querySelectorAll('[data-edit]'), function(btn){
      btn.onclick = function(){ showEditInspection(d, btn.getAttribute('data-edit')); };
    });

    var wash = el('div', { 'class':'panel' });
    var wrows = d.washes.map(function(w){
      return '<tr><td>' + fmt(w.startAt) + '→' + fmt(w.endAt) + '</td><td>' + w.negativeId + '</td><td>' + PURPOSE_LABEL[w.purpose] + '</td>'
        + '<td>' + w.operator + '</td><td><span class="pill ' + w.status + '">' + (w.status === 'confirmed' ? '有效' : '退回') + '</span></td>'
        + '<td class="meta">依据检测 ' + (w.permit ? fmt(w.permit.testAt) : '无') + (w.returnReason ? '<br>退回原因：' + reasonText(w.returnReason) : '') + '</td></tr>';
    }).join('');
    wash.innerHTML = '<h2>本缸冲洗用量</h2><table><thead><tr><th>时段</th><th>底片</th><th>用途</th><th>操作人</th><th>状态</th><th>许可依据</th></tr></thead><tbody>'
      + (wrows || '<tr><td colspan="6" class="meta">暂无冲洗</td></tr>') + '</tbody></table>';
    right.appendChild(wash);

    var left = $('#left');
    left.appendChild(inspectionForm(t, t.status === 'pending'));
  }).catch(function(err){ toast(err.message, true); });
}

function showEditInspection(d, id){
  var x = d.inspections.filter(function(i){ return i.id === id; })[0];
  var box = $('#editBox');
  box.innerHTML = '';
  var f = el('form', { 'class':'panel', style:'border-color:var(--warn)' });
  var local = function(t){ var dt = new Date(t); var p=function(v){return String(v).padStart(2,'0');};
    return dt.getFullYear()+'-'+p(dt.getMonth()+1)+'-'+p(dt.getDate())+'T'+p(dt.getHours())+':'+p(dt.getMinutes()); };
  f.innerHTML = '<h2>修改检测 ' + fmt(x.at) + '</h2><div class="meta">保存后引用本检测的许可及之后的冲洗全部退回重算</div>'
    + '<div class="row"><div><label>检测时间</label><input name="at" type="datetime-local" value="' + local(x.at) + '"></div>'
    + '<div><label>银盐 mg/L</label><input name="silverMgL" type="number" step="0.1" min="0" value="' + x.silverMgL + '"></div>'
    + '<div><label>浊度 NTU</label><input name="turbidityNtu" type="number" step="0.1" min="0" value="' + x.turbidityNtu + '"></div>'
    + '<div><label>检测人</label><input name="inspector" value="' + x.inspector + '"></div></div>'
    + '<button class="act danger">保存修改并重算</button>';
  f.onsubmit = function(e){
    e.preventDefault();
    api('/api/inspections/' + encodeURIComponent(id), { method:'PATCH', body:JSON.stringify(formObj(f)) })
      .then(function(){ toast('检测已修改，相关冲洗已重算'); openDetail(d.tank.id); loadTanks(); })
      .catch(function(err){ toast(err.message, true); });
  };
  box.appendChild(f);
}

function reasonText(r){
  return ({ no_test:'无检测记录', test_stale:'检测超八小时', silver_exceeded:'银盐超限', turbidity_exceeded:'浊度过高',
    tank_pending:'缸待复检', purpose_mismatch:'用途不符', slot_occupied:'时段占用',
    inspection_changed:'检测被修改', purpose_changed:'用途被变更' })[r] || r;
}

// ---------- 登记冲洗 ----------
function washTab(){
  var left = $('#left'); left.innerHTML = '';
  var f = el('form');
  var tankOpts = state.tanks.map(function(t){
    return '<option value="' + t.id + '">' + t.code + ' · ' + PURPOSE_LABEL[t.purpose] + ' · ' + (t.usableNow ? '当前可洗' : (t.status === 'pending' ? '待复检' : '条件不足')) + '</option>';
  }).join('');
  f.innerHTML = '<h2>登记底片冲洗</h2>'
    + '<label>底片编号</label><input name="negativeId" required placeholder="返工也用同一编号，便于追溯">'
    + '<label>水缸</label><select name="tankId">' + tankOpts + '</select>'
    + '<label>冲洗用途</label><select name="purpose"><option value="prewash">预洗</option><option value="post_develop">显影后</option><option value="post_fix">定影后</option></select>'
    + '<div class="row"><div><label>开始</label><input name="startAt" type="datetime-local" required></div>'
    + '<div><label>结束</label><input name="endAt" type="datetime-local" required></div></div>'
    + '<label>操作人</label><input name="operator" required><label>备注</label><input name="note">'
    + '<button class="act">登记冲洗</button>';
  f.querySelector('[name=startAt]').value = localNow();
  f.querySelector('[name=endAt]').value = localNow(30);
  f.querySelector('[name=tankId]').onchange = function(){ syncPurpose(f); };
  function syncPurpose(){ var t = state.tanks.filter(function(x){ return x.id === f.querySelector('[name=tankId]').value; })[0];
    if (t) f.querySelector('[name=purpose]').value = t.purpose; }
  syncPurpose();
  f.onsubmit = function(e){
    e.preventDefault();
    api('/api/washes', { method:'POST', body:JSON.stringify(formObj(f)) })
      .then(function(){ toast('冲洗已登记，许可已发放'); f.querySelector('[name=negativeId]').value=''; loadTanks(); })
      .catch(function(err){
        var extra = '';
        if (err.data && err.data.code === 'slot_occupied') extra = '；占用底片：' + err.data.occupyingNegativeId + '（本次请求不写入用量）';
        toast(err.message + extra, true);
      });
  };
  left.appendChild(f);
  var hint = el('div', { 'class':'panel meta', style:'margin-top:12px' });
  hint.innerHTML = '判定顺序：① 同一缸同一时段只能有一张底片，重复请求只提示占用底片且不写入用量；'
    + '② 用途须与缸登记用途一致；③ 缸不能处于待复检；④ 冲洗开始前须有八小时内的检测，'
    + '且银盐、浊度不超过该用途限值。任一不达标，缸进入待复检。';
  left.appendChild(hint);

  var right = $('#right'); right.innerHTML = '';
  var list = el('div', { 'class':'panel' });
  list.innerHTML = '<h2>当前水缸一览</h2><div class="grid" id="washCards"></div>';
  right.appendChild(list);
  $('#washCards').appendChild.apply($('#washCards'), state.tanks.map(tankCard));
}

// ---------- 待复检 ----------
function pendingTab(){
  var left = $('#left'); var right = $('#right');
  left.innerHTML = ''; right.innerHTML = '';
  api('/api/pending').then(function(list){
    var info = el('div', { 'class':'panel' });
    info.innerHTML = '<h2>待复检缸（' + list.length + '）</h2>'
      + '<div class="meta">因无检测建档的缸：一次合格即开放；因浓度超限、浊度过高或检测超八小时打回的缸：'
      + '须由<b>另一名检测人连续两次</b>合格才重新开放，中间任一不合格则从头计数。</div>';
    if (!list.length) info.innerHTML += '<p>当前没有待复检缸。</p>';
    var grid = el('div', { 'class':'grid', style:'margin-top:10px' });
    list.forEach(function(t){
      var c = el('div', { 'class':'card' });
      c.innerHTML = '<h3>' + t.code + '</h3><div><span class="pill pending">待复检</span></div>'
        + '<div class="meta">用途：' + PURPOSE_LABEL[t.purpose] + '</div>'
        + '<div class="meta">打回原因：' + reasonText(t.tank.pendingReason || t.pendingReason) + '</div>'
        + '<div class="meta">复检进度：' + t.streak + ' / ' + t.needPasses + '（还差 ' + t.remaining + ' 次合格）</div>'
        + '<div class="meta">最近检测：' + (t.latest ? fmt(t.latest.at) + ' · ' + t.latest.inspector : '无') + '</div>';
      grid.appendChild(c);
    });
    info.appendChild(grid);
    left.appendChild(info);
    if (list.length) right.appendChild(inspectionForm(list[0].tank || list[0], true));
    // pending 列表项已带完整字段，tankId 可直接用
    var sel = el('div', { 'class':'panel', style: list.length ? 'margin-top:12px' : '' });
    sel.innerHTML = list.length ? '<label>右侧复检登记表当前对应：<b id="rcCode"></b>（点选切换）</label>' : '';
    var buttons = el('div', { 'class':'row' });
    list.forEach(function(t, i){
      var b = el('button', { 'class':'act ghost', onclick:function(){ right.innerHTML=''; right.appendChild(inspectionForm(t, true)); $('#rcCode').textContent = t.code; } }, t.code);
      buttons.appendChild(b);
    });
    sel.appendChild(buttons);
    if (list.length){ left.appendChild(sel); var code0 = list[0].code; setTimeout(function(){ var n=$('#rcCode'); if(n) n.textContent=code0; },0); }
  });
}

// ---------- 底片用水履历 ----------
function historyTab(){
  var left = $('#left'); var right = $('#right');
  left.innerHTML = ''; right.innerHTML = '';
  var f = el('form', { 'class':'panel' });
  f.innerHTML = '<h2>底片用水履历</h2><label>底片编号</label><input name="negativeId" required>'
    + '<button class="act">查询</button><div class="meta" style="margin-top:8px">含有效、退回重算的冲洗许可，以及被拒绝的占用/水质尝试。</div>';
  f.onsubmit = function(e){
    e.preventDefault();
    var id = formObj(f).negativeId;
    api('/api/negatives/' + encodeURIComponent(id) + '/history').then(function(d){
      right.innerHTML = '';
      var panel = el('div', { 'class':'panel' });
      var html = '<h2>' + d.negativeId + ' 的用水履历</h2><div class="timeline">';
      if (!d.washes.length && !d.denials.length) html += '<div class="meta">没有记录。</div>';
      d.washes.forEach(function(w){
        html += '<div class="ev ' + w.status + '"><b>' + fmt(w.startAt) + ' → ' + fmt(w.endAt) + '</b> · '
          + PURPOSE_LABEL[w.purpose] + ' · 缸 ' + (w.tank ? w.tank.code : w.tankId) + ' · 操作人 ' + w.operator
          + ' <span class="pill ' + w.status + '">' + (w.status === 'confirmed' ? '有效' : '退回') + '</span>'
          + '<div class="meta">许可依据：' + (w.permit ? '检测 ' + fmt(w.permit.testAt) + '（银 ' + w.permit.silverMgL + 'mg/L，浊度 ' + w.permit.turbidityNtu + 'NTU）' : '无') + '</div>';
        (w.history || []).forEach(function(h){
          html += '<div class="meta">· ' + fmt(h.at) + ' ' + ({confirmed:'登记确认',returned:'退回：'+h.detail,reconfirmed:'重算合格',recalc_failed:'重算未过：'+h.detail})[h.kind] + '</div>';
        });
        html += '</div>';
      });
      d.denials.forEach(function(x){
        html += '<div class="ev denied"><b>' + fmt(x.at || (new Date().toISOString())) + '</b> <span class="pill stale">未写入用量</span>'
          + '<div class="meta">' + (x.code === 'slot_occupied' ? '时段被底片 ' + x.occupyingNegativeId + ' 占用' : '水质/状态不达标：' + reasonText(x.code)) + '</div></div>';
      });
      html += '</div>';
      panel.innerHTML = html;
      right.appendChild(panel);
    }).catch(function(err){ toast(err.message, true); });
  };
  left.appendChild(f);
  right.appendChild(el('div', { 'class':'panel meta' }, '输入底片编号查询其全部用水与被拒记录。'));
}

// ---------- 框架 ----------
function renderTab(){
  $('#left').innerHTML = ''; $('#right').innerHTML = '';
  if (state.tab === 'tanks'){
    $('#left').appendChild(tankForm());
    var right = $('#right'); right.innerHTML = '';
    var panel = el('div', { 'class':'panel' });
    panel.innerHTML = '<h2>水缸（' + state.tanks.length + '）</h2><div class="grid" id="cards"></div>';
    right.appendChild(panel);
    var g = $('#cards');
    state.tanks.forEach(function(t){ g.appendChild(tankCard(t)); });
  }
  if (state.tab === 'wash') washTab();
  if (state.tab === 'pending') pendingTab();
  if (state.tab === 'history') historyTab();
}
function loadTanks(){ return api('/api/tanks').then(function(list){ state.tanks = list; renderTab(); }); }

document.querySelectorAll('nav button').forEach(function(b){
  b.onclick = function(){
    document.querySelectorAll('nav button').forEach(function(x){ x.classList.remove('active'); });
    b.classList.add('active'); state.tab = b.getAttribute('data-tab'); state.detailId = null; renderTab();
  };
});
$('#reload').onclick = function(){ loadTanks(); };
loadTanks();
</script>
</body>
</html>`;
}
