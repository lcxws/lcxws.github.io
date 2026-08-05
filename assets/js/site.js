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
    var grids = document.querySelectorAll('.grid, .econ-steps');
    var drag = null;

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

      drag = {
        grid: grid,
        item: item,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        ph: null,
        offX: 0,
        offY: 0,
        origStyle: item.getAttribute('style')   /* 记住原内联样式，落位后恢复 */
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
        draggedCard = item;              /* 探照灯跟随被拖的卡片 */
        var rr = item.getBoundingClientRect();   /* 先量位置，再动 DOM，避免错位 */
        /* 占位符顶替原位置 */
        drag.ph = document.createElement('div');
        drag.ph.className = 'drag-ph';
        drag.ph.style.minHeight = rr.height + 'px';
        drag.grid.insertBefore(drag.ph, item);
        /* 本体挪到 body 上悬浮 */
        item.classList.add('is-dragging', 'fly-clone');
        document.body.appendChild(item);
        item.style.cssText = '';
        item.style.position = 'fixed';
        item.style.width = rr.width + 'px';
        item.style.height = rr.height + 'px';
        item.style.left = rr.left + 'px';
        item.style.top = rr.top + 'px';
        item.style.margin = '0';
        item.style.zIndex = '999';
        item.style.pointerEvents = 'none';
        item.style.opacity = '.97';
        item.style.transform = 'rotate(2deg) scale(1.02)';
        item.style.transition = 'none';
        drag.offX = e.clientX - rr.left;
        drag.offY = e.clientY - rr.top;
      }
      drag.item.style.left = (e.clientX - drag.offX) + 'px';
      drag.item.style.top = (e.clientY - drag.offY) + 'px';

      var target = document.elementFromPoint(e.clientX, e.clientY);
      if (target){
        target = target.closest('.panel');
        if (target && target !== drag.item && target.parentNode === drag.grid){
          var tr = target.getBoundingClientRect();
          if (e.clientY > tr.top + tr.height / 2){
            drag.grid.insertBefore(drag.ph, target.nextSibling);
          } else {
            drag.grid.insertBefore(drag.ph, target);
          }
        }
      }
      e.preventDefault();
    }

    function onUp(){
      if (!drag) return;
      var d = drag;
      drag = null;
      draggedCard = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = '';

      if (!d.moved){
        return;
      }
      /* 落位：放回占位符位置，恢复原内联样式 */
      if (d.ph && d.ph.parentNode === d.grid){
        d.grid.insertBefore(d.item, d.ph);
        d.ph.remove();
      }
      if (d.origStyle != null) d.item.setAttribute('style', d.origStyle);
      else d.item.removeAttribute('style');
      d.item.classList.remove('is-dragging', 'fly-clone');
      /* 拖拽结束后抑制这次点击（防止误触卡片里的链接） */
      document.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
      }, {capture:true, once:true});
    }
  }
  initSortable();
})();
