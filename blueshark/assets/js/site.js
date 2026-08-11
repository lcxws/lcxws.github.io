/* ============================================================
   BLUE SHARK 全站共享脚本
   - 滚动显现 / 页内目录 / 统计数字 / 画廊灯箱（基础）
   - 深海粒子背景（canvas）：气泡 + 视差浮尘 + 光柱 + 鼠标交互
   - 鼠标探照灯：全局光源跟随，照亮背景与卡片
   - 卡片 3D 倾斜 / 面板光斑跟随 / 按钮磁吸扫光
   - 卡片网格鼠标拖拽排序（纯临时，刷新后恢复默认）
   ============================================================ */
(function(){
  'use strict';

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var draggedCard = null;   /* 拖拽中的卡片（供探照灯跟随） */

  /* PerfMonitor 接口配置（按 API 文档）
     默认地址：http://127.0.0.1:25566（仅本机绑定）
     固定地址优先级：URL ?api=...  >  window.PERFMON_API（在 site.js 之前设置）
     未固定地址时自动检测：记住的地址 > 127.0.0.1 > 10.6.22.1 > 扫描 192.168.1.1~254
     端口：URL ?port=... 或 window.PERFMON_PORT 或默认 25566 */
  var PINNED = null;
  var PERFMON_PORT = 25566;
  (function(){
    var q = location.search;
    var ma = q.match(/[?&]api=([^&]+)/);
    var mp = q.match(/[?&]port=(\d+)/);
    if (ma) PINNED = decodeURIComponent(ma[1]).replace(/\/+$/, '');
    else if (window.PERFMON_API) PINNED = String(window.PERFMON_API).replace(/\/+$/, '');
    var p = (mp && parseInt(mp[1], 10)) || parseInt(window.PERFMON_PORT, 10);
    if (p && p > 0 && p < 65536) PERFMON_PORT = p;
  })();

  /* ---------- 滚动显现 ---------- */
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, {threshold:.12});
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });

  /* ---------- 导航滚动效果 + 回到顶部 + 阅读进度条 ---------- */
  var nav = document.querySelector('.site-nav');
  var toTop = document.querySelector('.to-top');
  var progress = document.createElement('div');
  progress.id = 'scroll-progress';
  progress.setAttribute('aria-hidden','true');
  document.body.appendChild(progress);
  window.addEventListener('scroll', function(){
    var y = window.scrollY;
    if (nav) nav.classList.toggle('scrolled', y > 10);
    if (toTop) toTop.classList.toggle('show', y > 600);
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    progress.style.width = (max > 0 ? (y / max * 100) : 0) + '%';
  }, {passive:true});
  if (toTop) toTop.addEventListener('click', function(){ window.scrollTo({top:0, behavior:'smooth'}); });

  /* ---------- 页内小节导航高亮 ---------- */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length) {
    var secMap = {};
    tocLinks.forEach(function(a){
      var id = a.getAttribute('href').replace('#','');
      var el = document.getElementById(id);
      if (el) secMap[id] = el;
    });
    var tocIO = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) {
          tocLinks.forEach(function(a){
            a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id);
          });
        }
      });
    }, {rootMargin:'-40% 0px -55% 0px'});
    Object.keys(secMap).forEach(function(id){ tocIO.observe(secMap[id]); });
  }

  /* ---------- 统计数字动画 ---------- */
  var countIO = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (!e.isIntersecting) return;
      countIO.unobserve(e.target);
      var el = e.target, target = parseInt(el.dataset.count, 10), cur = 0;
      if (isNaN(target)) return;
      var step = Math.max(1, Math.round(target / 40));
      (function tick(){
        cur += step;
        if (cur >= target) { el.textContent = target; return; }
        el.textContent = cur;
        setTimeout(tick, 30);
      })();
    });
  }, {threshold:.6});
  document.querySelectorAll('[data-count]').forEach(function(el){ countIO.observe(el); });

  /* ---------- 截图画廊灯箱 ---------- */
  var shots = Array.prototype.slice.call(document.querySelectorAll('.shot img'));
  if (shots.length) {
    var lb = document.getElementById('lightbox');
    if (lb) {
      var lbImg = document.getElementById('lbImg');
      var lbCap = document.getElementById('lbCap');
      var idx = 0;
      function show(i){
        idx = (i + shots.length) % shots.length;
        lbImg.src = shots[idx].src;
        if (lbCap) lbCap.textContent = '截图 ' + (idx + 1) + ' / ' + shots.length;
        lb.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
      function close(){ lb.classList.remove('open'); document.body.style.overflow = ''; }
      shots.forEach(function(img, i){
        img.closest('.shot').addEventListener('click', function(){ show(i); });
      });
      document.getElementById('lbClose').addEventListener('click', close);
      document.getElementById('lbPrev').addEventListener('click', function(e){ e.stopPropagation(); show(idx - 1); });
      document.getElementById('lbNext').addEventListener('click', function(e){ e.stopPropagation(); show(idx + 1); });
      lb.addEventListener('click', function(e){ if (e.target === lb) close(); });
      document.addEventListener('keydown', function(e){
        if (!lb.classList.contains('open')) return;
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowLeft') show(idx - 1);
        if (e.key === 'ArrowRight') show(idx + 1);
      });
    }
  }

  /* ============================================================
     深海粒子背景（canvas）
     - 气泡：底部上升、左右摆动、鼠标靠近被推开
     - 浮游微粒：锚定在"世界坐标"，滚动时按深度差产生视差
     - 光柱：缓慢摆动的水下光带 + 整体暗角
     ============================================================ */
  function initOceanFx(){
    var canvas = document.getElementById('ocean-fx');
    if (!canvas || REDUCED) return;
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0;
    var bubbles = [], dust = [], rays = [];
    var mouse = { x:-1e4, y:-1e4 };
    var targetScroll = 0, scroll = 0;
    var t = 0;

    function resize(){
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var i, n;
      bubbles.length = 0;
      dust.length = 0;
      n = Math.max(14, Math.min(34, Math.round(W / 80)));
      for (i = 0; i < n; i++) bubbles.push(makeBubble());
      n = Math.max(30, Math.min(64, Math.round(W * H / 20000)));
      for (i = 0; i < n; i++) dust.push(makeDust());
      rays = [
        { x: W * 0.16, w: W * 0.07, sway: 7,  speed: 1.3, a: 0.055, l: H * 0.85 },
        { x: W * 0.62, w: W * 0.045, sway: 10, speed: 0.9, a: 0.045, l: H * 0.7 },
        { x: W * 0.87, w: W * 0.09, sway: 6,  speed: 1.1, a: 0.04,  l: H * 0.9 }
      ];
    }
    function makeBubble(){
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        r: 1.4 + Math.random() * 4.2,
        vy: 0.16 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        wobA: 7 + Math.random() * 18,
        wobS: 0.4 + Math.random() * 0.9,
        a: 0.1 + Math.random() * 0.2
      };
    }
    function makeDust(){
      return {
        x: Math.random() * W,
        y: Math.random(),
        r: 0.6 + Math.random() * 1.3,
        a: 0.12 + Math.random() * 0.2,
        depth: 0.2 + Math.random() * 0.8,
        tw: 0.4 + Math.random() * 1.6,
        ph: Math.random() * Math.PI * 2
      };
    }

    window.addEventListener('resize', resize);
    window.addEventListener('scroll', function(){ targetScroll = window.scrollY; }, {passive:true});
    window.addEventListener('pointermove', function(e){
      mouse.x = e.clientX; mouse.y = e.clientY;
    }, {passive:true});
    window.addEventListener('pointerleave', function(){ mouse.x = -1e4; mouse.y = -1e4; });

    function drawBubble(b, bobX){
      var x = b.x + bobX;
      var g = ctx.createRadialGradient(x - b.r*0.35, b.y - b.r*0.35, b.r*0.1, x, b.y, b.r);
      g.addColorStop(0, 'rgba(255,255,255,' + (b.a * 0.9) + ')');
      g.addColorStop(0.55, 'rgba(190,240,255,' + (b.a * 0.35) + ')');
      g.addColorStop(1, 'rgba(150,225,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, b.y, b.r, 0, 6.283);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + (b.a * 0.85) + ')';
      ctx.beginPath();
      ctx.arc(x - b.r*0.3, b.y - b.r*0.35, Math.max(0.6, b.r * 0.22), 0, 6.283);
      ctx.fill();
    }

    function tick(){
      t += 0.016;
      scroll += (targetScroll - scroll) * 0.08;
      ctx.clearRect(0, 0, W, H);

      /* 光柱 */
      for (var i = 0; i < rays.length; i++){
        var R = rays[i];
        var rx = R.x + Math.sin(t * R.speed * 0.5) * R.sway;
        var grad = ctx.createLinearGradient(rx, 0, rx + R.w, R.l);
        grad.addColorStop(0, 'rgba(120,230,255,' + (R.a * 0.6) + ')');
        grad.addColorStop(1, 'rgba(120,230,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(rx, 0);
        ctx.lineTo(rx + R.w * 0.3, 0);
        ctx.lineTo(rx + R.w * 0.8, R.l);
        ctx.lineTo(rx - R.w * 0.2, R.l);
        ctx.closePath();
        ctx.fill();
      }

      /* 气泡 */
      for (i = 0; i < bubbles.length; i++){
        var b = bubbles[i];
        b.y -= b.vy;
        if (b.y < -18){
          bubbles[i] = makeBubble();
          bubbles[i].y = H + 12;
          continue;
        }
        var bobX = Math.sin(t * b.wobS + b.phase) * b.wobA * 0.5;
        var dx = b.x + bobX - mouse.x, dy = b.y - mouse.y;
        var d2 = dx*dx + dy*dy, rep = 26000;
        if (d2 < rep){
          var d = Math.sqrt(d2) || 1;
          var f = (1 - d / Math.sqrt(rep)) * 1.1;
          b.x += (dx / d) * f * 3;
          b.y += (dy / d) * f * 2;
        }
        drawBubble(b, bobX);
      }

      /* 浮游微粒（滚动视差） */
      var span = H * 0.6;
      for (i = 0; i < dust.length; i++){
        var p = dust[i];
        var py = (p.y * span - scroll * p.depth) % span;
        if (py < 0) py += span;
        var tw = 0.5 + Math.sin(t * p.tw + p.ph) * 0.5;
        ctx.fillStyle = 'rgba(185,235,255,' + (p.a * tw) + ')';
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(t * 0.3 + p.ph) * 12 * p.depth, py, p.r, 0, 6.283);
        ctx.fill();
      }

      /* 暗角 */
      var v = ctx.createRadialGradient(W/2, H*0.4, Math.min(W,H)*0.45, W/2, H/2, Math.max(W,H)*0.75);
      v.addColorStop(0, 'rgba(1,6,16,0)');
      v.addColorStop(1, 'rgba(1,6,16,0.32)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);

      requestAnimationFrame(tick);
    }

    resize();
    requestAnimationFrame(tick);
  }
  initOceanFx();

  /* ---------- 鼠标探照灯：全局光源跟随，同时照亮背景与卡片 ---------- */
  function initSpotlight(){
    var fine = window.matchMedia && window.matchMedia('(pointer:fine)').matches;
    if (!fine || REDUCED) return;
    var spot = document.createElement('div');
    spot.id = 'spotlight';
    spot.setAttribute('aria-hidden','true');
    document.body.appendChild(spot);
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    window.addEventListener('resize', function(){
      vw = document.documentElement.clientWidth;
      vh = document.documentElement.clientHeight;
    }, {passive:true});

    var cx = vw / 2, cy = vh / 2;   /* 光心当前位置（带缓动拖尾） */
    var tx = cx, ty = cy;           /* 目标 = 鼠标 */
    var card = null;                /* 当前悬停/拖拽的卡片 */

    window.addEventListener('pointermove', function(e){
      tx = e.clientX;
      ty = e.clientY;
      card = draggedCard || (e.target && e.target.closest && e.target.closest('.panel')) || null;
      spot.classList.toggle('dim', !!card);
    }, {passive:true});

    function frame(){
      /* 缓动追光标，产生拖尾 */
      var dx = tx - cx, dy = ty - cy;
      if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4){
        cx += dx * 0.14;
        cy += dy * 0.14;
      } else {
        cx = tx;
        cy = ty;
      }
      if (card){
        /* 悬停/拖拽卡片：把光裁剪到卡片矩形内（用实际光心反算裁切，精确贴合） */
        var r = card.getBoundingClientRect();
        spot.style.clipPath = 'inset(' +
          (r.top + vh * 0.7 - cy) + 'px ' +
          (cx + vw * 0.7 - r.right) + 'px ' +
          (cy + vh * 0.7 - r.bottom) + 'px ' +
          (r.left + vw * 0.7 - cx) + 'px)';
      } else {
        spot.style.clipPath = '';
      }
      spot.style.transform = 'translate(' + (cx - vw / 2) + 'px,' + (cy - vh / 2) + 'px)';
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  initSpotlight();

  /* ============================================================
     实时数据引擎（状态页 + 主页共用）
     - 自动检测：记住的地址 > 127.0.0.1 > 10.6.22.1 > 扫描 192.168.1.1~254
     - 按 API 文档默认 127.0.0.1:25566，数据每 5s 取一次
     - 无法连接时关闭接口显示（整块隐藏），连接成功后自动恢复
     - 手动键入 IP / 端口模块（状态页）
     ============================================================ */
  var LIVE_RENDER = null;    /* 页面渲染回调：LIVE_RENDER(数据)；null 表示回退 */
  var ACTIVE = null;         /* 寻到端口后锁定的接口地址 */
  var lastData = null;       /* 最后一份成功数据：未回新数据时继续显示它 */
  var lastFetch = 0;         /* 上次真正请求的时间戳 */
  var FETCH_MS = 5000;       /* 数据每 5s 取一次（与服务端刷新对齐），显示仍每 1s 刷新 */
  var FAILS = 0;
  var detecting = false;
  var scannedOnce = false;
  var fetching = false;

  function savedApi(){ try { return localStorage.getItem('perfmon_api') || null; } catch(e){ return null; } }
  function saveApi(url){ try { localStorage.setItem('perfmon_api', url); } catch(e){} }
  function clearApi(){ try { localStorage.removeItem('perfmon_api'); } catch(e){} }

  function getMetrics(url){
    var ctrl = new AbortController();
    var timer = setTimeout(function(){ ctrl.abort(); }, 1500);
    return fetch(url + '/metrics', {cache:'no-store', signal:ctrl.signal})
      .then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(d){ clearTimeout(timer); return d; })
      .catch(function(err){ clearTimeout(timer); throw err; });
  }

  /* 探测单个地址是否可用，返回该地址或 null */
  function probe(url){
    return new Promise(function(resolve){
      var ctrl = new AbortController();
      var timer = setTimeout(function(){ ctrl.abort(); }, 700);
      fetch(url + '/metrics', {cache:'no-store', signal:ctrl.signal})
        .then(function(r){ if (!r.ok) throw new Error(); return r.json(); })
        .then(function(d){ clearTimeout(timer); resolve(d && typeof d.tps === 'number' ? url : null); })
        .catch(function(){ clearTimeout(timer); resolve(null); });
    });
  }
  /* 依序探测，返回第一个可用地址 */
  function probeSeq(urls){
    return urls.reduce(function(p, u){
      return p.then(function(found){ return found || probe(u); });
    }, Promise.resolve(null));
  }
  /* 并发扫描 192.168.1.1~254 */
  function scanLan(){
    var urls = [];
    for (var i = 1; i <= 254; i++) urls.push('http://192.168.1.' + i + ':' + PERFMON_PORT);
    return new Promise(function(resolve){
      var idx = 0, active = 0, done = false, CONC = 16;
      function next(){
        if (done) return;
        if (idx >= urls.length){ if (active === 0) resolve(null); return; }
        var u = urls[idx++];
        active++;
        probe(u).then(function(found){
          active--;
          if (found){ if (!done){ done = true; resolve(found); } return; }
          next();
        });
      }
      for (var k = 0; k < CONC; k++) next();
    });
  }

  /* 候选地址：固定地址(URL/变量) > 记住的地址 > 本机默认（按 API 文档 127.0.0.1:端口） */
  function fastCandidates(){
    var list = [];
    if (PINNED) list.push(PINNED);
    var s = savedApi();
    if (s) list.push(s);
    list.push('http://127.0.0.1:' + PERFMON_PORT);
    return list.filter(function(u, i, a){ return u && a.indexOf(u) === i; });
  }
  /* 完整候选：快速候选 + 10.6.22.1（全量检测用） */
  function fullCandidates(){
    var list = fastCandidates();
    list.push('http://10.6.22.1:' + PERFMON_PORT);
    return list.filter(function(u, i, a){ return u && a.indexOf(u) === i; });
  }
  function runDetect(full){
    var list = full ? fullCandidates() : fastCandidates();
    return probeSeq(list).then(function(found){
      if (found) return found;
      if (full) return scanLan();
      return null;
    });
  }

  function setActive(url){
    ACTIVE = url;
    FAILS = 0;
    saveApi(url);
    var st = document.getElementById('lc-status');
    if (st) st.textContent = '已连接 ' + url;
  }
  function clearActive(){
    ACTIVE = null;
    FAILS = 0;
    clearApi();
    var st = document.getElementById('lc-status');
    if (st) st.textContent = '连接中断，正在自动重试…';
  }

  function fmtUptime(sec){
    sec = Math.max(0, Math.floor(sec || 0));
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
    var mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
    if (d > 0) return d + ' 天 ' + h + ' 小时 ' + mm + ' 分';
    if (h > 0) return h + ' 小时 ' + mm + ' 分 ' + ss + ' 秒';
    return mm + ' 分 ' + ss + ' 秒';
  }
  /* 实时运行时长：服务器快照 + 距快照的流逝时间，让计时器每秒递增 */
  function liveUptime(d){
    return (d.uptime_seconds || 0) + (Date.now() - (d.timestamp || Date.now())) / 1000;
  }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function setTxt(id, v){
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }
  function paintTps(id, tps){
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = (tps || 0).toFixed(2);
    el.style.color = tps >= 19 ? '#2ee87c' : (tps >= 16 ? '#ffd54f' : '#ff6b6b');
  }

  /* 每 1 秒一帧：显示每秒刷新（用最后一份数据），真正请求每 5s 一次 */
  function doFetch(){
    fetching = true;
    lastFetch = Date.now();
    getMetrics(ACTIVE).then(function(d){
      fetching = false;
      FAILS = 0;
      lastData = d;
      LIVE_RENDER(d);
    }, function(){
      fetching = false;
      FAILS++;
      if (FAILS >= 3){ clearActive(); lastData = null; }
      LIVE_RENDER(lastData);          /* 失败时也显示已有的最后数据 */
    });
  }

  function tick(){
    if (LIVE_RENDER == null) return;
    if (ACTIVE){
      /* 地址已锁定：到 5s 点才真正请求，其余 1s 帧用缓存数据渲染 */
      if (!fetching && (lastData == null || Date.now() - lastFetch >= FETCH_MS)){
        doFetch();
      } else {
        LIVE_RENDER(lastData);
      }
    } else {
      if (detecting) return;
      detecting = true;
      probeSeq(fastCandidates()).then(function(found){
        detecting = false;
        if (found){ setActive(found); tick(); return; }
        if (!scannedOnce){               /* 全量扫描只做一次，避免反复扫网段 */
          scannedOnce = true;
          scanLan().then(function(f2){
            if (f2){ setActive(f2); tick(); }
            else if (LIVE_RENDER) LIVE_RENDER(null);   /* 无法连接：关闭接口显示 */
          });
          return;
        }
        if (LIVE_RENDER) LIVE_RENDER(null);   /* 无法连接：关闭接口显示 */
      });
    }
  }

  /* ---------- 状态页实时监控 + 手动 IP/端口配置 ---------- */
  function initLiveStatus(){
    var box = document.getElementById('live-box');
    if (!box) return;                       /* 仅状态页存在该区块 */
    var msg = document.getElementById('live-msg');
    var sec = document.getElementById('live');   /* 整个实时监控区 */

    LIVE_RENDER = function(d){
      if (!d){
        /* 无法连接：关闭接口显示，整块隐藏 */
        if (sec) sec.style.display = 'none';
        box.style.display = 'none';
        return;
      }
      if (sec) sec.style.display = '';
      box.style.display = '';
      if (msg) msg.style.display = 'none';

      paintTps('lv-tps', d.tps);
      setTxt('lv-players', d.online_players + ' / ' + d.max_players);
      setTxt('lv-entities', String(d.total_entities));
      setTxt('lv-chunks', String(d.total_chunks));

      var m = d.memory;
      if (m){
        var mb = function(b){ return (b / 1048576).toFixed(0) + ' MB'; };
        var bar = document.getElementById('lv-membar');
        var pct = Math.min(100, m.used_percent || 0);
        if (bar) bar.style.width = pct + '%';
        setTxt('lv-memtext', mb(m.used) + ' / ' + mb(m.max) + '（' + (m.used_percent || 0).toFixed(1) + '%）');
      }

      setTxt('lv-playernames', d.players && d.players.length ? d.players.join('、') : '暂无玩家在线');

      var meta = document.getElementById('live-meta');
      if (meta){
        var up = liveUptime(d);
        var hh = String(Math.floor(up / 3600)).padStart(2, '0');
        var mm = String(Math.floor(up % 3600 / 60)).padStart(2, '0');
        var ss = String(Math.floor(up % 60)).padStart(2, '0');
        meta.textContent = 'MC ' + (d.minecraft_version || '-')
                + ' · 运行 ' + hh + ':' + mm + ':' + ss
                + ' · ' + new Date(d.timestamp).toLocaleTimeString();
      }

      var wb = document.getElementById('lv-worlds');
      if (wb){
        wb.innerHTML = '';
        (d.worlds || []).forEach(function(w){
          var card = document.createElement('div');
          card.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:12px 16px;'
                + 'display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;';
          card.innerHTML =
                '<b style="color:var(--foam);font-size:14px;">' + esc(w.name) + '</b>'
                + '<span style="color:var(--muted);font-size:12.5px;">' + esc(w.environment) + '</span>'
                + '<span style="color:var(--cyan);font-size:12.5px;">👥 ' + w.players + '</span>'
                + '<span style="color:var(--muted);font-size:12.5px;">实体 ' + w.entities + '</span>'
                + '<span style="color:var(--muted);font-size:12.5px;">区块 ' + w.chunks_loaded + '</span>'
                + '<span style="color:var(--muted);font-size:12.5px;">' + esc(w.difficulty) + '</span>';
          wb.appendChild(card);
        });
      }
    };

    /* 手动 IP/端口 配置模块 */
    var form = document.getElementById('live-config');
    if (form){
      var ipEl = document.getElementById('lc-ip');
      var portEl = document.getElementById('lc-port');
      var stEl = document.getElementById('lc-status');
      var cur = ACTIVE || savedApi() || '';
      var mm2 = cur.match(/^https?:\/\/([^:]+):(\d+)/);
      if (mm2){ ipEl.value = mm2[1]; portEl.value = mm2[2]; }
      else { ipEl.value = '127.0.0.1'; portEl.value = String(PERFMON_PORT); }

      document.getElementById('lc-connect').addEventListener('click', function(){
        var ip = ipEl.value.trim();
        var port = parseInt(portEl.value, 10);
        if (!ip || !port || port < 1 || port > 65535){
          if (stEl) stEl.textContent = '请输入有效的 IP 和端口';
          return;
        }
        setActive('http://' + ip + ':' + port);
        tick();
      });
      document.getElementById('lc-scan').addEventListener('click', function(){
        if (stEl) stEl.textContent = '正在自动检测…';
        scannedOnce = false;
        runDetect(true).then(function(url){
          if (url){ setActive(url); tick(); }
          else if (stEl) stEl.textContent = '未检测到可用的 PerfMonitor 接口';
        });
      });
      if (stEl) stEl.textContent = ACTIVE ? ('已连接 ' + ACTIVE) : '自动检测中…';
    }
  }
  initLiveStatus();

  /* ---------- 主页服务器信息：实时 TPS / 在线 / 内存 / 运行时长 ---------- */
  function initHomeLive(){
    var box = document.getElementById('home-live');
    if (!box) return;                       /* 仅主页存在该区块 */

    LIVE_RENDER = function(d){
      if (!d){
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';

      paintTps('hl-tps', d.tps);
      setTxt('hl-online', d.online_players + ' / ' + d.max_players);
      var m = d.memory;
      if (m) setTxt('hl-mem', (m.used / 1048576).toFixed(0) + ' / ' + (m.max / 1048576).toFixed(0) + ' MB');
      setTxt('hl-uptime', fmtUptime(liveUptime(d)));

      /* 顺带更新下方静态卡片 */
      if (d.minecraft_version) setTxt('hl-card-version', d.minecraft_version.toUpperCase());
      setTxt('hl-card-uptime', fmtUptime(liveUptime(d)));
      setTxt('hl-card-online', d.online_players + ' 人在线');
    };
  }
  initHomeLive();

  /* ---------- 启动实时引擎：固定地址则直接用，否则进入自动检测 + 1s 轮询 ---------- */
  if (PINNED){
    ACTIVE = PINNED;
  }
  if (LIVE_RENDER != null){
    setInterval(tick, 1000);
    tick();
  }

  /* ============================================================
     卡片交互：面板光斑跟随 + 3D 微倾斜 + 按钮磁吸
     ============================================================ */

  /* 面板光斑跟随：鼠标在哪，青色光斑就跟到哪 */
  if (!REDUCED) {
    document.querySelectorAll('.panel').forEach(function(p){
      var glow = document.createElement('i');
      glow.className = 'glow';
      glow.setAttribute('aria-hidden','true');
      p.appendChild(glow);
      p.addEventListener('pointermove', function(e){
        var r = p.getBoundingClientRect();
        p.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
        p.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
      });
    });
  }

  /* 3D 微倾斜：卡片像在手里转动 */
  if (!REDUCED) {
    var TILT_SEL = '.gate-card,.feature-card,.mod-card,.member-card,.landmark-card,.econ-step';
    document.querySelectorAll(TILT_SEL).forEach(function(card){
      card.classList.add('tiltable');
      card.addEventListener('pointermove', function(e){
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty('--ry', (px * 8).toFixed(2) + 'deg');
        card.style.setProperty('--rx', (-py * 8).toFixed(2) + 'deg');
      });
      card.addEventListener('pointerleave', function(){
        card.style.setProperty('--ry', '0deg');
        card.style.setProperty('--rx', '0deg');
      });
    });
  }

  /* 按钮磁吸：向鼠标方向轻轻挪动 */
  if (!REDUCED) {
    document.querySelectorAll('.btn').forEach(function(btn){
      btn.addEventListener('pointermove', function(e){
        var r = btn.getBoundingClientRect();
        var dx = e.clientX - (r.left + r.width / 2);
        var dy = e.clientY - (r.top + r.height / 2);
        btn.style.setProperty('--mx', (dx * 0.18).toFixed(1) + 'px');
        btn.style.setProperty('--my', (dy * 0.18).toFixed(1) + 'px');
      });
      btn.addEventListener('pointerleave', function(){
        btn.style.setProperty('--mx', '0px');
        btn.style.setProperty('--my', '0px');
      });
    });
  }

  /* ============================================================
     卡片网格拖拽排序
     - 所有 .grid / .econ-steps 网格均可鼠标拖动排序
     - 纯临时：不写 localStorage，刷新页面即恢复原始布局
     ============================================================ */

  function initSortable(){
    /* 手机/触屏（pointer:coarse）上锁定拖拽，避免误触乱序 */
    if (!(window.matchMedia && window.matchMedia('(pointer:fine)').matches)) return;
    var grids = document.querySelectorAll('.grid, .econ-steps');
    var drag = null;

    /* 清理可能残留的幽灵克隆（防止上次拖拽没删干净，盖在页面上） */
    function clearGhost(){
      var g = document.getElementById('bs-ghost');
      if (g && g.parentNode) g.parentNode.removeChild(g);
    }

    Array.prototype.forEach.call(grids, function(grid){
      var items = Array.prototype.filter.call(grid.children, function(c){
        return c.nodeType === 1 && c.classList.contains('panel');
      });
      if (items.length < 2) return;

      grid.classList.add('is-sortable');
      grid.addEventListener('dragstart', function(e){ e.preventDefault(); });
      grid.addEventListener('pointerdown', onDown, {passive:false});
    });

    function onDown(e){
      if (e.button !== 0) return;
      var item = e.target.closest('.panel');
      if (!item) return;
      var grid = item.parentNode;
      if (!grid.classList.contains('is-sortable')) return;

      clearGhost();   /* 防止上一次拖拽的幽灵残留 */
      drag = {
        grid: grid,
        item: item,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        fly: null,
        offX: 0,
        offY: 0,
        target: null
      };
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove, {passive:false});
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    function onMove(e){
      if (!drag) return;
      var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (!drag.moved){
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        drag.moved = true;
        var item = drag.item;
        var rr = item.getBoundingClientRect();
        /* 幽灵克隆体：跟手漂浮，真卡留在网格里变半透明 */
        var fly = item.cloneNode(true);
        fly.id = 'bs-ghost';
        fly.className = item.className + ' fly-clone';
        fly.setAttribute('aria-hidden','true');
        document.body.appendChild(fly);
        fly.style.cssText = '';
        fly.style.position = 'fixed';
        fly.style.width = rr.width + 'px';
        fly.style.height = rr.height + 'px';
        fly.style.left = rr.left + 'px';
        fly.style.top = rr.top + 'px';
        fly.style.margin = '0';
        fly.style.zIndex = '999';
        fly.style.pointerEvents = 'none';
        fly.style.opacity = '.97';
        /* 拿起：弹性放大，磁吸到手边 */
        fly.style.transform = 'scale(1.06) rotate(2deg)';
        fly.style.transition = 'transform .28s cubic-bezier(.34,1.56,.64,1), box-shadow .28s ease-out';
        fly.style.willChange = 'transform';
        drag.fly = fly;
        draggedCard = fly;             /* 探照灯跟随幽灵 */
        item.classList.add('is-dragging');
        drag.offX = e.clientX - rr.left;
        drag.offY = e.clientY - rr.top;
      }
      var fly = drag.fly;
      fly.style.left = (e.clientX - drag.offX) + 'px';
      fly.style.top = (e.clientY - drag.offY) + 'px';

      /* 交换式排序：压在谁身上，就和谁换位置（两张真卡瞬间互换，不飞越） */
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var P = el ? el.closest('.panel') : null;
      if (P && P !== drag.item && P.parentNode === drag.grid && P !== drag.target){
        var kids = Array.prototype.slice.call(drag.grid.children);
        var ii = kids.indexOf(drag.item), ti = kids.indexOf(P);
        if (ii > -1 && ti > -1){
          kids[ii] = P;
          kids[ti] = drag.item;
          kids.forEach(function(k){ drag.grid.appendChild(k); });
          if (drag.target && drag.target !== P) drag.target.classList.remove('is-swap');
          drag.target = P;
          P.classList.add('is-swap');
        }
      }
      e.preventDefault();
    }

    function onUp(e){
      if (!drag) return;
      var d = drag;
      drag = null;
      draggedCard = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';

      if (!d.moved){
        if (d.fly && d.fly.parentNode) d.fly.remove();
        return;
      }

      if (d.target) d.target.classList.remove('is-swap');
      d.item.classList.remove('is-dragging');   /* 真卡淡回不透明 */

      /* 放下动画：幽灵飞回真卡所在格子，缩小淡出 */
      var fly = d.fly;
      if (fly && fly.parentNode){
        var slot = d.item.getBoundingClientRect();
        var fr = fly.getBoundingClientRect();
        var dx = slot.left - fr.left, dy = slot.top - fr.top;
        fly.style.transition = 'transform .3s cubic-bezier(.34,1.56,.64,1), opacity .3s ease-out';
        fly.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.92)';
        fly.style.opacity = '0';
        (function(f){
          setTimeout(function(){ if (f.parentNode) f.remove(); }, 330);
        })(fly);
      }

      /* 拖拽结束后抑制这次点击（防止误触卡片里的链接） */
      document.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
      }, {capture:true, once:true});
    }
  }
  initSortable();
})();
