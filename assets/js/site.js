/* BLUE SHARK 全站共享脚本 */
(function(){
  'use strict';

  /* ---------- 生成气泡 ---------- */
  var bubblesHosts = document.querySelectorAll('.bubbles');
  bubblesHosts.forEach(function(host){
    for (var i = 0; i < 16; i++) {
      var s = document.createElement('span');
      var size = 6 + Math.random() * 16;
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.left = (Math.random() * 100) + '%';
      s.style.setProperty('--drift', ((Math.random() * 120) - 60) + 'px');
      s.style.animationDuration = (6 + Math.random() * 10) + 's';
      s.style.animationDelay = (Math.random() * 12) + 's';
      s.style.opacity = 0.4 + Math.random() * 0.5;
      host.appendChild(s);
    }
  });

  /* ---------- 导航滚动效果 + 回到顶部 ---------- */
  var nav = document.querySelector('.site-nav');
  var toTop = document.querySelector('.to-top');
  window.addEventListener('scroll', function(){
    var y = window.scrollY;
    if (nav) nav.classList.toggle('scrolled', y > 10);
    if (toTop) toTop.classList.toggle('show', y > 600);
  }, {passive:true});
  if (toTop) toTop.addEventListener('click', function(){ window.scrollTo({top:0, behavior:'smooth'}); });

  /* ---------- 滚动显现 ---------- */
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, {threshold:.12});
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });

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
      if (isNaN(target)) { el.textContent = el.textContent; return; }
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
})();
