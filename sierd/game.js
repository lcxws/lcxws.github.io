/*
 * 病原体进化模拟 · SIERD 核心引擎（JavaScript 移植）
 * ------------------------------------------------------
 * 由「神秘小程序/main.py」全套移植：SEIRD 机制层 + 接触场所状态机 +
 * ICU/Erlang 队列 + 检测隔离 + 疫苗研发 + 变异株 + 点数经济 + 政府自动响应 +
 * WHO 预警 + 随机事件 + 天气物理（绝对湿度 → 气溶胶半衰期）。
 *
 * 设计铁律（与 Python 原版一致）：
 * 1. 玩家驱动：无任何自动演示流程，推进/操作全部由玩家触发。
 * 2. 效果无量纲化：全部由机制参数（接触人次、物理量、天数、容量）与公式涌现。
 *
 * 本文件为纯引擎（不依赖 DOM），可在浏览器与 Node 中运行。
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.SIERD = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // =====================================================================
  // 可复现伪随机数（mulberry32，支持 Python random 常用接口的等价物）
  // =====================================================================
  class RNG {
    constructor(seed) {
      this.state = (seed >>> 0) || 1;
    }
    next() {
      let t = (this.state += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    random() { return this.next(); }
    uniform(a, b) { return a + (b - a) * this.next(); }
    randrange(n) { return Math.floor(this.next() * n); }
    randint(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
    choice(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    choices(arr, weights, k) {
      k = k || 1;
      const total = weights.reduce((a, b) => a + b, 0);
      const out = [];
      for (let i = 0; i < k; i++) {
        let r = this.next() * total;
        for (let j = 0; j < arr.length; j++) {
          r -= weights[j];
          if (r <= 0) { out.push(arr[j]); break; }
        }
        if (out.length <= i) out.push(arr[arr.length - 1]);
      }
      return out;
    }
    gauss(mu, sigma) {
      mu = mu || 0; sigma = sigma || 1;
      let u = 0, v = 0;
      while (u === 0) u = this.next();
      while (v === 0) v = this.next();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  }

  // =====================================================================
  // 常量与基准数据（来源注释见 Python 原版 data.py / model.py / config.py）
  // =====================================================================
  // 场所基线：人均日接触人次（Mossong et al. 2008, POLYMOD）
  // 键 → (接触人次/人/日, 室内暴露时长h, 关闭期限值)
  const VENUE_BASE = {
    home:      [3.5, 0.5, 3.5],
    work:      [1.1, 0.5, 0.4],
    school:    [0.8, 0.5, 0.1],
    community: [2.1, 0.1, 0.5],
    gathering: [0.3, 0.5, 0.0],
  };
  // 途径 → 气溶胶敏感性
  const ROUTE_SURV = {
    airborne: "air", droplet: "air", contact: "const",
    water: "const", vector: "const",
  };
  // 超额死亡 f(ρ) 数据点（COVID 超载地区报告拟合，x=ρ, y=μ倍数）
  const RHO_CURVE = [[0.0, 1.0], [0.7, 1.0], [1.0, 1.5], [1.5, 2.5], [2.0, 3.5], [3.0, 5.0]];

  // 难度参数表
  const DIFFICULTY = {
    easy:      { points: 112, gain_bonus: 5,  overdraft: true,  research_days: [365, 730], delay_scale: 2.0 },
    normal:    { points: 75,  gain_bonus: 0,  overdraft: true,  research_days: [180, 365], delay_scale: 1.0 },
    hard:      { points: 60,  gain_bonus: -2, overdraft: false, research_days: [120, 240], delay_scale: 0.5 },
    realistic: { points: 7,   gain_bonus: 1,  overdraft: false, research_days: [90, 180],  delay_scale: 0.3 },
  };
  const DIFFICULTY_CN = { easy: "简单", normal: "正常", hard: "困难", realistic: "现实" };
  const ROUTE_CN = { airborne: "空气", droplet: "飞沫", contact: "接触", water: "水媒", vector: "媒介" };
  const SEASON_LABEL = { winter: "冬季", spring: "春季", summer: "夏季", autumn: "秋季", wet: "雨季", dry: "干季" };

  // 国家库（真实数据近似，字段见 data.py）
  const COUNTRIES = {
    "CHN": ["China", "中国", 1425671000, 35.86, 104.19, 9600000, 12600, "temperate", ["cny"], 64000, 1500000, 0.92, 5500000, 1, 5, "Asia"],
    "IND": ["India", "印度", 1428627000, 20.59, 78.96, 3287000, 2480, "tropical_savanna", ["eid"], 69000, 1500000, 0.58, 3000000, 4, 3, "Asia"],
    "USA": ["United States", "美国", 339997000, 37.09, -95.71, 9834000, 81700, "temperate", [], 94000, 1500000, 0.45, 3000000, 7, 3, "North America"],
    "IDN": ["Indonesia", "印度尼西亚", 277534000, -2.55, 118.01, 1905000, 4870, "tropical_rain", ["cny", "eid"], 10000, 300000, 0.68, 100000, 6, 2, "Asia"],
    "PAK": ["Pakistan", "巴基斯坦", 240486000, 30.38, 69.35, 881000, 1580, "arid", ["eid"], 3500, 100000, 0.45, 50000, 6, 2, "Asia"],
    "NGA": ["Nigeria", "尼日利亚", 223804000, 9.08, 8.68, 924000, 1620, "tropical_savanna", ["eid"], 1500, 50000, 0.52, 5000, 9, 1, "Africa"],
    "BRA": ["Brazil", "巴西", 216422000, -14.24, -51.93, 8516000, 10040, "tropical_rain", [], 35000, 500000, 0.40, 200000, 6, 2, "South America"],
    "BGD": ["Bangladesh", "孟加拉国", 172954000, 23.68, 90.36, 148000, 2530, "tropical_savanna", ["eid"], 2500, 80000, 0.55, 30000, 7, 2, "Asia"],
    "RUS": ["Russia", "俄罗斯", 144444000, 61.52, 105.32, 17098000, 13000, "continental", [], 30000, 600000, 0.48, 500000, 4, 2, "Europe"],
    "MEX": ["Mexico", "墨西哥", 128455000, 23.63, -102.55, 1964000, 13800, "temperate", [], 12000, 150000, 0.38, 100000, 7, 3, "North America"],
    "ETH": ["Ethiopia", "埃塞俄比亚", 126527000, 9.15, 40.49, 1104000, 1020, "tropical_savanna", ["eid"], 1000, 30000, 0.62, 2000, 10, 1, "Africa"],
    "JPN": ["Japan", "日本", 123294000, 36.20, 138.25, 378000, 33800, "temperate", [], 15000, 400000, 0.55, 300000, 3, 5, "Asia"],
    "PHL": ["Philippines", "菲律宾", 117337000, 12.88, 121.77, 300000, 3870, "tropical_rain", ["cny"], 4000, 100000, 0.58, 50000, 6, 3, "Asia"],
    "EGY": ["Egypt", "埃及", 112717000, 26.82, 30.80, 1001000, 3150, "arid", ["eid"], 5000, 80000, 0.50, 20000, 8, 2, "Africa"],
    "COD": ["DR Congo", "刚果(金)", 102263000, -4.04, 21.76, 2345000, 660, "tropical_rain", [], 500, 10000, 0.55, 0, 12, 1, "Africa"],
    "VNM": ["Vietnam", "越南", 98859000, 14.06, 108.28, 331000, 4300, "tropical_savanna", ["cny"], 6000, 200000, 0.78, 150000, 2, 3, "Asia"],
    "IRN": ["Iran", "伊朗", 89173000, 32.43, 53.69, 1648000, 4600, "arid", ["eid"], 8000, 150000, 0.42, 100000, 5, 2, "Asia"],
    "TUR": ["Turkey", "土耳其", 85816000, 38.96, 35.24, 784000, 13100, "mediterranean", ["eid"], 12000, 300000, 0.48, 300000, 5, 2, "Europe"],
    "DEU": ["Germany", "德国", 83295000, 51.17, 10.45, 357000, 52700, "temperate", [], 28000, 500000, 0.62, 400000, 4, 3, "Europe"],
    "THA": ["Thailand", "泰国", 71801000, 15.87, 100.99, 513000, 7180, "tropical_savanna", [], 8000, 150000, 0.60, 80000, 5, 3, "Asia"],
    "GBR": ["United Kingdom", "英国", 67737000, 55.38, -3.44, 244000, 48900, "temperate", [], 7000, 800000, 0.55, 400000, 4, 4, "Europe"],
    "FRA": ["France", "法国", 64757000, 46.23, 2.21, 551000, 44500, "temperate", [], 10000, 600000, 0.52, 300000, 5, 3, "Europe"],
    "ITA": ["Italy", "意大利", 58871000, 41.87, 12.57, 301000, 38300, "mediterranean", [], 8500, 400000, 0.48, 250000, 5, 3, "Europe"],
    "ZAF": ["South Africa", "南非", 60414000, -30.56, 22.94, 1221000, 6200, "temperate", [], 6000, 150000, 0.45, 30000, 7, 2, "Africa"],
    "TZA": ["Tanzania", "坦桑尼亚", 67438000, -6.37, 34.89, 947000, 1200, "tropical_savanna", ["eid"], 300, 10000, 0.55, 0, 10, 1, "Africa"],
    "MMR": ["Myanmar", "缅甸", 54578000, 21.92, 95.96, 677000, 1170, "tropical_savanna", [], 1000, 30000, 0.50, 5000, 8, 1, "Asia"],
    "KEN": ["Kenya", "肯尼亚", 55101000, -0.02, 37.91, 580000, 2000, "tropical_savanna", ["eid"], 800, 40000, 0.52, 3000, 9, 1, "Africa"],
    "KOR": ["South Korea", "韩国", 51784000, 35.91, 127.77, 100000, 33100, "temperate", ["cny"], 10000, 400000, 0.65, 200000, 2, 4, "Asia"],
    "COL": ["Colombia", "哥伦比亚", 52086000, 4.57, -74.30, 1142000, 6900, "tropical_rain", [], 8000, 100000, 0.42, 30000, 7, 2, "South America"],
    "ESP": ["Spain", "西班牙", 47519000, 40.46, -3.75, 506000, 32700, "mediterranean", [], 8000, 400000, 0.50, 250000, 5, 3, "Europe"],
    "ARG": ["Argentina", "阿根廷", 45774000, -38.42, -63.62, 2780000, 13700, "temperate", [], 9000, 150000, 0.40, 50000, 6, 2, "South America"],
    "DZA": ["Algeria", "阿尔及利亚", 45606000, 28.03, 1.66, 2382000, 5300, "arid", ["eid"], 2000, 40000, 0.48, 20000, 8, 2, "Africa"],
    "SDN": ["Sudan", "苏丹", 48109000, 12.86, 30.22, 1886000, 1100, "arid", ["eid"], 500, 15000, 0.45, 1000, 10, 1, "Africa"],
    "UKR": ["Ukraine", "乌克兰", 36744000, 48.38, 31.17, 604000, 5000, "continental", [], 5000, 100000, 0.40, 30000, 6, 2, "Europe"],
    "CAN": ["Canada", "加拿大", 38781000, 56.13, -106.35, 9985000, 54800, "continental", [], 5000, 300000, 0.60, 150000, 5, 3, "North America"],
    "POL": ["Poland", "波兰", 41026000, 51.92, 19.15, 313000, 19800, "continental", [], 6000, 200000, 0.45, 100000, 5, 3, "Europe"],
    "MAR": ["Morocco", "摩洛哥", 37840000, 31.79, -7.09, 447000, 3900, "mediterranean", ["eid"], 2000, 50000, 0.55, 30000, 7, 2, "Africa"],
    "AFG": ["Afghanistan", "阿富汗", 42240000, 33.94, 67.71, 652000, 620, "arid", ["eid"], 300, 10000, 0.40, 0, 10, 1, "Asia"],
    "AGO": ["Angola", "安哥拉", 36684000, -11.20, 17.87, 1247000, 3800, "tropical_savanna", [], 400, 15000, 0.50, 1000, 10, 1, "Africa"],
    "UZB": ["Uzbekistan", "乌兹别克斯坦", 35164000, 41.38, 64.59, 447000, 2500, "arid", ["eid"], 1500, 40000, 0.52, 10000, 7, 2, "Asia"],
    "MYS": ["Malaysia", "马来西亚", 34308000, 4.21, 101.98, 330000, 11700, "tropical_rain", ["cny", "eid"], 3500, 150000, 0.62, 100000, 4, 3, "Asia"],
    "PER": ["Peru", "秘鲁", 34353000, -9.19, -75.02, 1285000, 7800, "tropical_savanna", [], 3000, 100000, 0.38, 30000, 6, 2, "South America"],
    "YEM": ["Yemen", "也门", 34450000, 15.55, 48.52, 528000, 650, "arid", ["eid"], 200, 5000, 0.42, 0, 12, 1, "Asia"],
    "GHA": ["Ghana", "加纳", 34122000, 7.95, -1.02, 239000, 2400, "tropical_savanna", [], 500, 30000, 0.55, 5000, 9, 1, "Africa"],
    "MOZ": ["Mozambique", "莫桑比克", 33898000, -18.67, 35.53, 799000, 580, "tropical_savanna", [], 300, 10000, 0.50, 1000, 10, 1, "Africa"],
    "NPL": ["Nepal", "尼泊尔", 30897000, 28.39, 84.12, 147000, 1370, "temperate", [], 1000, 30000, 0.58, 10000, 7, 2, "Asia"],
    "MDG": ["Madagascar", "马达加斯加", 30326000, -18.77, 46.87, 587000, 510, "tropical_savanna", [], 200, 8000, 0.48, 0, 11, 1, "Africa"],
    "CIV": ["Côte d'Ivoire", "科特迪瓦", 28873000, 7.54, -5.55, 322000, 2700, "tropical_savanna", [], 400, 20000, 0.50, 3000, 9, 1, "Africa"],
    "CMR": ["Cameroon", "喀麦隆", 28647000, 4.39, 12.35, 475000, 1700, "tropical_rain", [], 400, 20000, 0.52, 2000, 10, 1, "Africa"],
    "VEN": ["Venezuela", "委内瑞拉", 28839000, 6.42, -66.59, 916000, 3600, "tropical_savanna", [], 3000, 40000, 0.35, 10000, 8, 1, "South America"],
    "AUS": ["Australia", "澳大利亚", 26439000, -25.27, 133.78, 7692000, 65400, "arid", [], 4000, 250000, 0.68, 150000, 2, 5, "Oceania"],
    "PRK": ["North Korea", "朝鲜", 26161000, 40.34, 127.51, 120000, 660, "continental", [], 500, 5000, 0.75, 0, 1, 5, "Asia"],
    "NER": ["Niger", "尼日尔", 27203000, 17.61, 8.08, 1267000, 600, "arid", ["eid"], 200, 5000, 0.48, 0, 11, 1, "Africa"],
    "LKA": ["Sri Lanka", "斯里兰卡", 21893000, 7.87, 80.77, 66000, 3800, "tropical_savanna", [], 1500, 40000, 0.55, 20000, 6, 3, "Asia"],
    "BFA": ["Burkina Faso", "布基纳法索", 23251000, 12.24, -1.56, 274000, 870, "arid", ["eid"], 200, 5000, 0.45, 0, 11, 1, "Africa"],
    "MLI": ["Mali", "马里", 23294000, 17.57, -3.99, 1240000, 900, "arid", ["eid"], 200, 5000, 0.48, 0, 11, 1, "Africa"],
    "ROU": ["Romania", "罗马尼亚", 19893000, 45.94, 24.97, 238000, 17000, "continental", [], 3000, 80000, 0.42, 50000, 6, 2, "Europe"],
    "CHL": ["Chile", "智利", 19630000, -35.68, -71.54, 756000, 17900, "mediterranean", [], 4000, 100000, 0.45, 50000, 5, 3, "South America"],
    "KAZ": ["Kazakhstan", "哈萨克斯坦", 19606000, 48.02, 66.92, 2725000, 13300, "continental", ["eid"], 2000, 60000, 0.50, 20000, 6, 2, "Asia"],
    "NLD": ["Netherlands", "荷兰", 17618000, 52.13, 5.29, 42000, 62600, "temperate", [], 2500, 150000, 0.58, 100000, 4, 3, "Europe"],
    "ECU": ["Ecuador", "厄瓜多尔", 18190000, -1.83, -78.18, 276000, 6600, "tropical_rain", [], 2000, 50000, 0.40, 15000, 7, 2, "South America"],
    "GTM": ["Guatemala", "危地马拉", 18092000, 15.78, -90.23, 109000, 5400, "tropical_savanna", [], 1000, 30000, 0.38, 10000, 8, 1, "North America"],
    "BEL": ["Belgium", "比利时", 11686000, 50.50, 4.47, 31000, 54400, "temperate", [], 2000, 100000, 0.55, 80000, 4, 3, "Europe"],
    "CUB": ["Cuba", "古巴", 11194000, 21.52, -77.78, 110000, 9500, "tropical_savanna", [], 1500, 30000, 0.70, 50000, 3, 3, "North America"],
    "GRC": ["Greece", "希腊", 10341000, 39.07, 21.82, 132000, 23600, "mediterranean", [], 1500, 60000, 0.48, 40000, 5, 2, "Europe"],
    "PRT": ["Portugal", "葡萄牙", 10247000, 39.40, -8.22, 92000, 26700, "mediterranean", [], 1500, 60000, 0.50, 40000, 5, 2, "Europe"],
    "SWE": ["Sweden", "瑞典", 10612000, 60.13, 18.64, 450000, 58800, "continental", [], 1500, 100000, 0.55, 60000, 5, 2, "Europe"],
    "CHE": ["Switzerland", "瑞士", 8796000, 46.82, 8.23, 41000, 94700, "temperate", [], 1200, 80000, 0.62, 50000, 3, 3, "Europe"],
    "SAU": ["Saudi Arabia", "沙特阿拉伯", 36947000, 23.89, 45.08, 2150000, 32500, "arid", ["eid"], 8000, 150000, 0.55, 100000, 4, 3, "Asia"],
    "IRQ": ["Iraq", "伊拉克", 45505000, 33.22, 43.68, 438000, 5900, "arid", ["eid"], 2000, 40000, 0.42, 20000, 8, 2, "Asia"],
  };

  // 病原体基准库（文献参数）
  const PATHOGENS = {
    influenza: ["流感样", "virus", 1.3, 0.001, 0.143, 0.50, 0.35, "airborne", 0.02],
    covid:     ["新冠样", "virus", 2.5, 0.010, 0.160, 0.20, 0.40, "airborne", 0.05],
    measles:   ["麻疹样", "virus", 15.0, 0.001, 0.100, 0.20, 0.10, "airborne", 0.10],
    ebola:     ["埃博拉样", "virus", 2.0, 0.500, 0.067, 0.20, 0.00, "contact", 0.80],
    bacterial: ["细菌样", "bacteria", 1.0, 0.100, 0.033, 0.05, 0.50, "droplet", 0.05],
    parasite:  ["寄生虫样", "parasite", 2.0, 0.020, 0.050, 0.10, 0.50, "vector", 0.03],
    fungus:    ["真菌样", "fungus", 0.8, 0.300, 0.050, 0.10, 0.20, "airborne", 0.30],
    prion:     ["朊病毒样", "prion", 0.5, 1.000, 0.002, 0.001, 1.00, "contact", 0.90],
  };

  // 投放城市库
  const CITIES = {
    "武汉": ["WUH", "CHN", 11200000, 30.59, 114.31, 27150000, 8500],
    "北京": ["BJS", "CHN", 21800000, 39.90, 116.41, 100000000, 16410],
    "上海": ["SHA", "CHN", 24800000, 31.23, 121.47, 120000000, 6340],
    "广州": ["GUA", "CHN", 18700000, 23.13, 113.26, 73000000, 7434],
    "深圳": ["SZX", "CHN", 17500000, 22.54, 114.06, 53000000, 1997],
    "重庆": ["CKG", "CHN", 32000000, 29.56, 106.55, 46000000, 82400],
    "成都": ["CTU", "CHN", 21000000, 30.57, 104.07, 88000000, 14335],
    "纽约": ["NYC", "USA", 8400000, 40.71, -74.01, 140000000, 789],
    "洛杉矶": ["LAX", "USA", 3900000, 34.05, -118.24, 88000000, 1302],
    "伦敦": ["LON", "GBR", 8900000, 51.51, -0.13, 100000000, 1572],
    "巴黎": ["PAR", "FRA", 12000000, 48.86, 2.35, 100000000, 2845],
    "柏林": ["BER", "DEU", 3600000, 52.52, 13.40, 35000000, 892],
    "东京": ["TYO", "JPN", 14000000, 35.68, 139.69, 110000000, 2194],
    "大阪": ["OSA", "JPN", 2700000, 34.69, 135.50, 33000000, 225],
    "首尔": ["SEL", "KOR", 9700000, 37.57, 126.98, 100000000, 605],
    "新加坡": ["SIN", "SGP", 5700000, 1.35, 103.82, 68000000, 734],
    "雅加达": ["JKT", "IDN", 10600000, -6.21, 106.85, 54000000, 661],
    "孟买": ["BOM", "IND", 20400000, 19.08, 72.88, 48000000, 603],
    "德里": ["DEL", "IND", 16800000, 28.61, 77.21, 69000000, 1484],
    "班加罗尔": ["BLR", "IND", 12300000, 12.97, 77.59, 33000000, 741],
    "达卡": ["DAC", "BGD", 21000000, 23.81, 90.41, 6800000, 306],
    "卡拉奇": ["KHI", "PAK", 16100000, 24.86, 67.01, 7000000, 3530],
    "拉各斯": ["LOS", "NGA", 15400000, 6.52, 3.38, 7000000, 1171],
    "开罗": ["CAI", "EGY", 21300000, 30.04, 31.24, 20000000, 3085],
    "内罗毕": ["NBO", "KEN", 4700000, 1.29, 36.82, 9000000, 696],
    "约翰内斯堡": ["JNB", "ZAF", 5600000, -26.20, 28.05, 21000000, 1645],
    "圣保罗": ["SAO", "BRA", 12300000, -23.55, -46.63, 43000000, 1521],
    "墨西哥城": ["MEX", "MEX", 9200000, 19.43, -99.13, 47000000, 1485],
    "布宜诺斯艾利斯": ["BUE", "ARG", 3000000, -34.60, -58.38, 11000000, 203],
    "莫斯科": ["MOW", "RUS", 12600000, 55.76, 37.62, 80000000, 2511],
    "悉尼": ["SYD", "AUS", 5300000, -33.87, 151.21, 44000000, 12145],
    "伊斯坦布尔": ["IST", "TUR", 15500000, 41.01, 28.98, 100000000, 5343],
  };

  // =====================================================================
  // 小工具
  // =====================================================================
  function haversineKm(lat1, lon1, lat2, lon2) {
    const r = 6371.0;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  function densityFactor(densityKm2) {
    return Math.max(0.8, Math.min(2.0, 1.0 + 0.5 * Math.log10(Math.max(densityKm2, 30.0) / 300.0)));
  }

  function absoluteHumidity(temp, rh) {
    const esat = 6.112 * Math.exp(17.67 * temp / (temp + 243.5));
    return rh / 100.0 * esat * 216.7 / (temp + 273.15);
  }

  function aerosolHalfLife(ah) {
    return 2.5 * Math.exp(-0.09 * ah);
  }

  function venueSurvival(ah, exposureHours) {
    const tau = aerosolHalfLife(ah);
    return tau / (tau + exposureHours);
  }

  function seasonFor(lat, doy, climate) {
    climate = climate || "temperate";
    if (Math.abs(lat) < 23.5) {
      if (climate === "tropical_rain") return "wet";
      const northWet = 121 <= doy && doy <= 304;
      return (northWet ? lat >= 0 : lat < 0) ? "wet" : "dry";
    }
    if (lat >= 0) {
      if (doy >= 355 || doy <= 79) return "winter";
      if (doy <= 171) return "spring";
      if (doy <= 263) return "summer";
      return "autumn";
    }
    return { winter: "summer", spring: "autumn", summer: "winter", autumn: "spring" }[seasonFor(-lat, doy, climate)];
  }

  const CLIMATE_BASE = {
    tropical_rain:    [1.5, 82.0, 6.0, 4.0],
    tropical_savanna: [0.5, 66.0, 14.0, 5.0],
    arid:             [3.5, 32.0, 8.0, 9.0],
    mediterranean:    [-2.5, 64.0, 10.0, 6.0],
    temperate:        [-4.0, 72.0, 9.0, 4.0],
    continental:      [-8.0, 68.0, 8.0, 6.0],
  };

  function meanAnnualTemp(lat, climate) {
    const base = CLIMATE_BASE[climate] || CLIMATE_BASE.temperate;
    return 27.5 - 0.42 * Math.abs(lat) + base[0];
  }

  function annualAmplitude(lat, climate) {
    let base = 2.5 + 0.16 * Math.abs(lat);
    if (climate === "continental") base += 5.0;
    if (climate === "arid") base += 3.0;
    return Math.min(base, 22.0);
  }

  function dailyTemperature(doy, lat, climate, hour, rng, noise) {
    noise = noise == null ? 1.5 : noise;
    const amp = annualAmplitude(lat, climate);
    const hemi = lat >= 0 ? 1.0 : -1.0;
    const base = CLIMATE_BASE[climate] || CLIMATE_BASE.temperate;
    const diurnal = base[3];
    let t = meanAnnualTemp(lat, climate);
    t += hemi * amp * Math.cos(2 * Math.PI * (doy - 196) / 365);
    t += diurnal * Math.sin(2 * Math.PI * (hour - 9) / 24);
    t += rng.gauss(0.0, noise);
    return Math.round(t * 10) / 10;
  }

  function relativeHumidity(doy, lat, climate, temp, rng, noise) {
    noise = noise == null ? 4.0 : noise;
    const base = CLIMATE_BASE[climate] || CLIMATE_BASE.temperate;
    let baseRh = base[1], ampRh = base[2];
    const hemi = lat >= 0 ? 1.0 : -1.0;
    if (Math.abs(lat) < 23.5) {
      const season = seasonFor(lat, doy, climate);
      baseRh += season === "wet" ? 14.0 : -12.0;
    } else {
      baseRh += hemi * ampRh * Math.cos(2 * Math.PI * (doy - 196) / 365);
      baseRh -= 0.3 * (temp - 15.0);
    }
    const rh = baseRh + rng.gauss(0.0, noise);
    return Math.round(Math.min(100.0, Math.max(15.0, rh)) * 10) / 10;
  }

  // =====================================================================
  // 数据对象
  // =====================================================================
  function makeCountryData(iso3, t) {
    const [name, nameCn, pop, lat, lon, area, gdp, climate, tags, icu, tests, trust, vcap, delay, border, cont] = t;
    return { iso3, name, name_cn: nameCn, pop, lat, lon, area_km2: area, gdp_usd: gdp,
             climate, tags: tags.slice(), icu_beds: icu, daily_tests: tests, trust,
             vaccine_capacity: vcap, response_delay: delay, border_control: border, continent: cont };
  }
  function builtinCountries() {
    const out = {};
    for (const iso3 of Object.keys(COUNTRIES)) out[iso3] = makeCountryData(iso3, COUNTRIES[iso3]);
    return out;
  }
  function makePathogen(key, t) {
    const [nameCn, category, r0, ifr, gamma, sigma, f, route, sev] = t;
    return { key, name_cn: nameCn, category, r0_bench: r0, ifr, gamma, sigma, asymp_frac: f, route, sev_rate: sev };
  }
  function pathogenLibrary() {
    const out = {};
    for (const k of Object.keys(PATHOGENS)) out[k] = makePathogen(k, PATHOGENS[k]);
    return out;
  }
  function makeCity(nameCn, t) {
    const [code, iso3, pop, lat, lon, annual, area] = t;
    return { name_cn: nameCn, code, iso3, pop, lat, lon, airport_annual: annual, area_km2: area };
  }
  function cityLibrary() {
    const out = {};
    for (const k of Object.keys(CITIES)) out[k] = makeCity(k, CITIES[k]);
    return out;
  }
  function _levRatio(a, b) {
    const m = a.length, n = b.length;
    if (m === 0 && n === 0) return 1.0;
    const dp = [];
    for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return 1.0 - dp[m][n] / Math.max(m, n);
  }
  function matchCity(query) {
    const lib = cityLibrary();
    const q = (query || "").trim();
    if (!q) return [];
    const names = Object.keys(lib);
    const exact = names.filter(k => k === q || lib[k].code.toLowerCase() === q.toLowerCase() ||
                                      lib[k].iso3.toLowerCase() === q.toLowerCase());
    if (exact.length) return exact.map(k => lib[k]);
    const contains = names.filter(k => q.length === 1 ? k.includes(q) :
                                    (k.includes(q) || lib[k].code.toLowerCase().includes(q.toLowerCase())));
    if (contains.length) return contains.map(k => lib[k]);
    const scored = names.map(k => [lib[k], _levRatio(q, k)])
      .sort((x, y) => y[1] - x[1]).slice(0, 3)
      .filter(x => x[1] >= 0.4);
    return scored.map(x => x[0]);
  }

  // =====================================================================
  // 配置
  // =====================================================================
  class Config {
    constructor() {
      this.difficulty = "normal";
      this.dt_substeps = 4;
      // 点数经济
      this.points_per_10k_new_infected = 10;
      this.points_per_1k_deaths = 5;
      this.points_per_new_country = 5;
      this.points_per_10_influence = 10;
      this.influence_weights = [0.4, 0.3, 0.2, 0.1];
      this.overdraft_limit = 50;
      this.overdraft_interest = 0.05;
      this.overdraft_days_to_degrade = 3;
      // 病程/队列
      this.quarantine_days = 14;
      this.erlang_death_stages = 3;
      this.death_delay_mean_days = 14.0;
      this.icu_delay_mean_days = 7.0;
      this.erlang_icu_stages = 3;
      // 接触与传播
      this.commute_fraction = 0.0005;
      this.gathering_essential_people_day = 200.0;
      // 封锁疲劳行为模型
      this.fatigue_logistic = { a: 0.06, b: 2.5, c: 25.0, d: -1.2 };
      this.fatigue_plateau_days = 14;
      // WHO 阈值
      this.who1_countries = 1;
      this.who2_countries = 5;
      this.who2_continents = 2;
      this.who3_countries = 20;
      this.who3_infected = 1000000;
      this.who4_infected = 100000000;
      this.who4_deaths = 1000000;
      this.quarantine_capacity_base = 50000;
      this.quarantine_capacity_who1 = 300000;
      this.research_boost_who2_days = 90;
      this.research_boost_who3_days = 90;
      // 政府响应
      this.response_threshold_infection_rate = 0.0001;
      this.response_threshold_rho = 0.7;
      this.response_relax_days = 14;
      this.response_relax_rate = 0.00005;
      this.icu_expansion_per_month = 1000.0;
      this.test_routine_volume = 100000.0;
      this.border_close_neighbor_rate = 0.0005;
      // 疫苗
      this.sequencing_days = 30;
      this.vaccination_priority_elderly = 0.1;
      this.elderly_coverage_cap = 0.9;
      // 变异株
      this.antigen_drift_natural = 0.0008;
      this.escape_speed_per_level = 0.002;
      this.ve_decay_halfway = 30.0;
      this.escape_reinfection_threshold = 3.0;
      this.new_vaccine_start_progress = 0.30;
      // 事件
      this.event_daily_prob = 1.0;
      this.event_intervals = { mutation: [7, 10, 20, 100], gathering: 15, disaster: 30,
        unrest: 40, mass_testing: 25, treatment: 60, animal_reservoir: 45, research_incident: 30 };
      this.mutation_interval_index = { easy: 0, normal: 1, hard: 2, realistic: 3 };
      // 胜负
      this.win_infection_total = 0.99;
      // TUI 相关
      this.top_n = 12;
      this.log_max = 500;
    }
  }

  // =====================================================================
  // 场所与队列
  // =====================================================================
  class ErlangDelay {
    constructor(stages, meanDays) {
      this.stages = Math.max(1, stages);
      this.mean = Math.max(0.5, meanDays);
      this.rate = this.stages / this.mean;
      this.buffer = new Array(this.stages).fill(0);
    }
    push(amount) {
      if (amount > 0) this.buffer[0] += amount;
    }
    step() {
      const out = this.buffer[this.buffer.length - 1];
      this.buffer[this.buffer.length - 1] = 0.0;
      for (let i = this.stages - 1; i > 0; i--) {
        const flow = Math.min(this.buffer[i - 1], this.buffer[i - 1] * this.rate);
        this.buffer[i - 1] -= flow;
        this.buffer[i] += flow;
      }
      return out;
    }
  }

  class Venue {
    constructor(name, rate, exposureHours, limit) {
      this.name = name;
      this.rate = rate;
      this.exposure_hours = exposureHours;
      this.limit = limit;
      this.mode = "normal";
    }
    targetPeople(pop, densFac, gatheringCap, compliance) {
      const base = pop * this.rate * densFac;
      let target;
      if (this.mode === "normal") return base;
      if (this.mode === "half") {
        target = base / 3.0;
      } else if (this.name === "home") {
        return base;
      } else if (this.name === "gathering") {
        target = gatheringCap;
      } else {
        target = pop * this.rate * densFac * this.limit;
      }
      const comp = Math.min(1.0, Math.max(0.0, compliance));
      return target + (base - target) * (1.0 - comp);
    }
  }

  class CountryState {
    constructor(d) {
      this.d = d;
      this.S = d.pop; this.E = 0; this.I = 0; this.R = 0; this.D = 0;
      this.Q = 0.0; this.V = 0.0;
      this.cum_infected = 0.0;
      this.cum_detected = 0.0;
      this.cum_deaths = 0.0;
      this.new_today = 0.0;
      this.venues = {};
      this.lockdown_days = 0;
      this.compliance = 1.0;
      this.icu_occ = 0.0;
      this.icu_beds_eff = 0.0;
      this.icu_queue = null;
      this.death_queue = null;
      this.borders = {};
      this.test_volume = 0.0;
      this.test_sensitivity = 1.0;
      this.vaccinated_doses = 0.0;
      this.vac_elderly = 0.0;
      this.vac_adult = 0.0;
      this.gov_actions = [];
      this.relax_days = 0;
      this.emergency = false;
      this.beta_trace = [];
      this.beta = 0.0;
      this.q_beta = 0.0;
      this.r_eff = 0.0;
      this.mu_eff = 0.0;
      this.temp = 0.0;
      this.hum = 0.0;
      this.ah = 0.0;
      this.season = "spring";
    }
    get iso3() { return this.d.iso3; }
    get pop() { return this.d.pop; }
    get infection_rate() { return this.pop ? this.I / this.pop : 0.0; }
  }

  class WeatherState {
    constructor(temp, hum, season, ah) {
      this.temp = temp; this.hum = hum; this.season = season; this.ah = ah;
    }
    get season_cn() { return SEASON_LABEL[this.season] || this.season; }
  }

  class WeatherEngine {
    constructor(cfg, countries, rng) {
      this.cfg = cfg;
      this.countries = countries;
      this.rng = rng;
      this.hour = rng.randrange(24);
      this.current = {};
    }
    step(day) {
      this.hour = (this.hour + 6) % 24;
      for (const iso3 of Object.keys(this.countries)) {
        const c = this.countries[iso3];
        const temp = dailyTemperature(day, c.d.lat, c.d.climate, this.hour, this.rng, 1.5);
        const hum = relativeHumidity(day, c.d.lat, c.d.climate, temp, this.rng, 4.0);
        this.current[iso3] = new WeatherState(
          temp, hum, seasonFor(c.d.lat, day, c.d.climate), absoluteHumidity(temp, hum));
      }
    }
  }

  // =====================================================================
  // 进化面板（3 类 × 5 分支，等级上限 100，每类最多 5 激活）
  // =====================================================================
  const CATEGORY_CN = { spread: "传播", lethal: "致命", stealth: "隐蔽" };
  const S = {};
  S.fx_aerosol = (world, level, base) => { world.tau_bonus = base.tau_bonus + level * 0.15; };
  S.fx_contact = (world, level, base) => { world.p_trans = base.p_trans + level * 0.001; };
  S.fx_water = (world, level, base) => { world.water_frac = level > 0 ? (0.5 + (level - 1) * 0.04) : 0.0; };
  S.fx_vector = (world, level, base) => { world.vector_frac = level > 0 ? (0.5 + (level - 1) * 0.05) : 0.0; };
  S.fx_hardiness = (world, level, base) => { world.env_sens = Math.max(0.1, base.env_sens - level * 0.02); };
  S.fx_cytopathy = (world, level, base) => {};
  S.fx_immunosuppress = (world, level, base) => {};
  S.fx_secondary = (world, level, base) => {};
  S.fx_neurotropism = (world, level, base) => {};
  S.fx_resistance = (world, level, base) => {
    world.treatment_effective = level === 0;
    if (level > 0) { world.treatment_death_delay = 0.0; world.treatment_sev_delta = 0.0; }
  };
  S.fx_asymp = (world, level, base) => { world.asymp_frac = Math.min(0.95, base.asymp_frac + level * 0.08); };
  S.fx_latency = (world, level, base) => { world.sigma = 1.0 / Math.min(14.0, 1.0 / base.sigma + level); };
  S.fx_evasion = (world, level, base) => { world.test_sensitivity = Math.max(0.1, base.test_sensitivity - level * 0.05); };
  S.fx_carrier = (world, level, base) => { world.reinfection_contacts = 0.005 + level * 0.001; };
  S.fx_drift = (world, level, base) => { world.escape_level = level; };
  // 缺陷效果
  S.fx_cytopathy_drawback = (world, level, base) => {
    world.cfg.response_threshold_infection_rate = Math.max(0.00001, base.threshold - level / 100000.0);
  };
  S.fx_neuro_drawback = (world, level, base) => {
    world.cfg.test_routine_volume = base.routine_tests + level * 2000.0;
  };
  const DRAWBACK_FX = {
    cytopathy: S.fx_cytopathy_drawback,
    neurotropism: S.fx_neuro_drawback,
  };

  function Branch(bid, category, name, basePrice, effectDesc, opts) {
    opts = opts || {};
    this.bid = bid; this.category = category; this.name = name;
    this.base_price = basePrice; this.effect_desc = effectDesc;
    this.level_cap = opts.level_cap || 100;
    this.conflicts = opts.conflicts || [];
    this.drawback = opts.drawback || "";
    this.effect = opts.effect || null;
  }
  Branch.prototype.activatePrice = function (rng) {
    return this.base_price * rng.uniform(1.0, 4.0) + rng.uniform(0.0, 5.0);
  };
  Branch.prototype.upgradePrice = function (prev, rng) {
    return prev * rng.uniform(1.10, 1.30);
  };

  const BRANCHES = {};
  (function () {
    const B = BRANCHES;
    B.aerosol = new Branch("aerosol", "spread", "气溶胶耐久", 12.0,
      "气溶胶半衰期 +0.15 小时/级（τ 绝对量）",
      { drawback: "干燥与潮湿环境同时受益，无选择性", effect: S.fx_aerosol });
    B.contact = new Branch("contact", "spread", "接触增强", 15.0,
      "单次接触传播概率 +0.001/级（绝对概率）",
      { effect: S.fx_contact });
    B.water = new Branch("water", "spread", "水源传播", 25.0,
      "开辟水媒通道：不安全饮水接触（WHO 数据估计），每级 +0.04 次/人·日（按各国人口）",
      { effect: S.fx_water });
    B.vector = new Branch("vector", "spread", "畜媒传播", 22.0,
      "开辟媒介通道：媒介暴露人次随温度活跃（蚊媒拟合），每级 +0.05 次/人·日",
      { effect: S.fx_vector });
    B.hardiness = new Branch("hardiness", "spread", "环境耐受", 10.0,
      "湿度敏感性 −0.02/级（绝对量，干燥环境存活提升）",
      { effect: S.fx_hardiness });
    B.cytopathy = new Branch("cytopathy", "lethal", "细胞破坏", 14.0,
      "死亡率 +0.0005/级（绝对量）",
      { drawback: "重症暴露更明显：政府响应阈值提前 0.00001/级", effect: S.fx_cytopathy });
    B.immunosuppress = new Branch("immunosuppress", "lethal", "免疫抑制", 16.0,
      "重症率 +0.005/级（绝对量）",
      { effect: S.fx_immunosuppress });
    B.secondary = new Branch("secondary", "lethal", "继发感染", 12.0,
      "死亡率 +0.0002/级 且 死亡延迟 −0.3 天/级（更快致死）",
      { effect: S.fx_secondary });
    B.neurotropism = new Branch("neurotropism", "lethal", "神经侵袭", 13.0,
      "重症率 +0.002/级（绝对量）",
      { drawback: "检测意愿上升：全球常规检测投入 +2000 剂/日/级", effect: S.fx_neurotropism });
    B.resistance = new Branch("resistance", "lethal", "耐药性", 30.0,
      "特效药物失效（治疗参数归零，机制更新）",
      { effect: S.fx_resistance });
    B.asymp = new Branch("asymp", "stealth", "无症状携带", 15.0,
      "无症状比例 +0.08/级（绝对比例）",
      { conflicts: ["cytopathy", "immunosuppress", "neurotropism"],
        drawback: "关注度增长放缓（检出减少）", effect: S.fx_asymp });
    B.latency = new Branch("latency", "stealth", "潜伏期延长", 10.0,
      "潜伏期 +1 天/级（绝对天数，上限 14 天）",
      { effect: S.fx_latency });
    B.evasion = new Branch("evasion", "stealth", "检测逃逸", 16.0,
      "检测灵敏度 −0.05/级（绝对量）",
      { effect: S.fx_evasion });
    B.carrier = new Branch("carrier", "stealth", "慢性携带", 18.0,
      "死亡延迟 +1 天/级（病程延长）且免疫者复发接触 +0.001/级",
      { effect: S.fx_carrier });
    B.drift = new Branch("drift", "stealth", "抗原漂移", 20.0,
      "免疫逃逸等级 +1/级 → 抗原距离增速 +0.002/日/级（绝对量）",
      { drawback: "显著漂移触发新疫苗研发（从 30% 进度重启）", effect: S.fx_drift });
  })();

  class EvolutionState {
    constructor(cfg, rng) {
      this.cfg = cfg;
      this.rng = rng;
      this.levels = {};
      for (const b of Object.keys(BRANCHES)) this.levels[b] = 0;
      this.prices = {};
      for (const b of Object.keys(BRANCHES)) this.prices[b] = 0.0;
      this.paid = {};
      for (const b of Object.keys(BRANCHES)) this.paid[b] = [];
      this.base = {};
      this._captured = false;
    }
    capture(world) {
      this.base = {
        p_trans: world.p_trans, mu_base: world.mu_base,
        sigma: world.sigma, asymp_frac: world.asymp_frac,
        sev_rate: world.sev_rate, tau_bonus: world.tau_bonus,
        env_sens: world.env_sens, test_sensitivity: world.test_sensitivity,
        threshold: world.cfg.response_threshold_infection_rate,
        routine_tests: world.cfg.test_routine_volume,
        pop: world.countries[world.home_iso3].pop,
      };
      this._captured = true;
    }
    currentPrice(bid) {
      const b = BRANCHES[bid];
      if (this.levels[bid] === 0) {
        if (!(this.prices[bid] > 0)) this.prices[bid] = b.activatePrice(this.rng);
      }
      return this.prices[bid];
    }
    activeBranches() {
      return Object.keys(this.levels).filter(b => this.levels[b] > 0);
    }
    upgrade(bid, world) {
      const b = BRANCHES[bid];
      if (this.levels[bid] >= b.level_cap) return [false, `${b.name} 已达等级上限 ${b.level_cap}`];
      const conflicts = new Set(b.conflicts);
      for (const other of Object.keys(BRANCHES)) {
        if (BRANCHES[other].conflicts.indexOf(bid) >= 0) conflicts.add(other);
      }
      for (const other of conflicts) {
        if (this.levels[other] > 0) return [false, `${b.name} 与 ${BRANCHES[other].name} 冲突（互斥激活）`];
      }
      if (this.levels[bid] === 0) {
        let catActive = 0;
        for (const o of Object.keys(this.levels)) {
          if (this.levels[o] > 0 && BRANCHES[o].category === b.category) catActive++;
        }
        if (catActive >= 5) return [false, `${CATEGORY_CN[b.category]}类已达 5 分支激活上限`];
      }
      const price = this.currentPrice(bid);
      if (world.points < price) return [false, `点数不足：需要 ${price.toFixed(1)}，当前 ${world.points.toFixed(1)}`];
      this.paid[bid].push(price);
      world.points -= price;
      world.ledger.push([world.day, "进化", -price, `${b.name} 升级到 ${this.levels[bid] + 1} 级`]);
      this.levels[bid] += 1;
      this.prices[bid] = b.upgradePrice(this.prices[bid] || price, this.rng);
      this.applyTo(world);
      return [true, `${b.name} 升至 ${this.levels[bid]} 级（−${price.toFixed(1)} 点）`];
    }
    downgrade(bid, world) {
      if (this.levels[bid] <= 0) return [false, "该分支未激活"];
      const refund = this.paid[bid].length ? this.paid[bid].pop() : this.prices[bid];
      this.levels[bid] -= 1;
      this.prices[bid] = refund;
      world.points += refund;
      world.ledger.push([world.day, "退化", refund, `${BRANCHES[bid].name} 降级返还`]);
      this.applyTo(world);
      return [true, `${BRANCHES[bid].name} 降级（+${refund.toFixed(1)} 点）`];
    }
    randomDegrade(rng, world) {
      const actives = this.activeBranches();
      if (!actives.length) return null;
      const bid = rng.choice(actives);
      if (this.paid[bid].length) this.paid[bid].pop();
      this.levels[bid] -= 1;
      this.prices[bid] = this.paid[bid].length ? this.paid[bid][this.paid[bid].length - 1] : 0.0;
      this.applyTo(world);
      return BRANCHES[bid].name;
    }
    applyTo(world) {
      if (!this._captured) this.capture(world);
      const base = this.base;
      for (const bid of Object.keys(BRANCHES)) {
        const br = BRANCHES[bid];
        if (br.effect) br.effect(world, this.levels[bid], base);
      }
      world.mu_base = base.mu_base
        + this.levels.cytopathy * 0.0005
        + this.levels.secondary * 0.0002;
      world.sev_rate_delta = this.levels.immunosuppress * 0.005
        + this.levels.neurotropism * 0.002;
      world.death_delay_extra = this.levels.carrier * 1.0
        - this.levels.secondary * 0.3;
      for (const bid of Object.keys(DRAWBACK_FX)) {
        DRAWBACK_FX[bid](world, this.levels[bid], base);
      }
    }
  }

  // =====================================================================
  // 疫苗研发（5 阶段流程模型，绝对天数）
  // =====================================================================
  const RESEARCH_STAGES = ["临床前", "ⅠⅡ期", "Ⅲ期", "审批量产", "完成"];
  const RESEARCH_STAGE_WEIGHTS = [0.30, 0.35, 0.25, 0.10];
  const RESEARCH_STAGE_FAIL = [0.40, 0.30, 0.20, 0.10];
  const RESEARCH_STAGE_ROLLBACK = [0.0, 0.20, 0.50, 0.50];

  class ResearchSystem {
    constructor(cfg, rng) {
      this.cfg = cfg;
      this.rng = rng;
      const [low, high] = DIFFICULTY[cfg.difficulty].research_days;
      this.total_days = low + Math.floor(rng.next() * (high - low + 1));
      this.progress_days = 0.0;
      this.stage = 0;
      this.unlocked = false;
      this.done = false;
      this.failures = 0;
      this.stalled = false;
      this.cooperation_used = false;
      this._boosts = 0.0;
      this._pending_boost = 0.0;
      this._logs = [];
    }
    get stage_name() { return this.stage < RESEARCH_STAGES.length ? RESEARCH_STAGES[this.stage] : "完成"; }
    _stageEnd() {
      let acc = 0;
      for (let i = 0; i <= this.stage; i++) acc += RESEARCH_STAGE_WEIGHTS[i];
      return this.total_days * acc;
    }
    progressFrac() { return Math.min(1.0, this.progress_days / Math.max(1.0, this.total_days)); }
    remainingDays() {
      if (this.stage >= RESEARCH_STAGE_WEIGHTS.length) return 0.0;
      return Math.max(0.0, this._stageEnd() - this.progress_days);
    }
    step(world) {
      if (!this.unlocked || this.done || this.stalled) return [];
      const events = [];
      this.progress_days += 1.0;
      while (this.stage < RESEARCH_STAGE_WEIGHTS.length && this.progress_days >= this._stageEnd()) {
        this._advanceStage(world, events);
      }
      return events;
    }
    _advanceStage(world, events) {
      if (this.rng.random() < RESEARCH_STAGE_FAIL[this.stage]) {
        this.failures += 1;
        const failedStage = this.stage_name;
        const rollback = RESEARCH_STAGE_ROLLBACK[this.stage];
        this.progress_days = this.total_days * rollback;
        this.stage = rollback <= 0.2 ? 0 : 1;
        const msg = `🔬 疫苗研发 ${failedStage}阶段失败（第 ${this.failures} 次），进度退回 ${rollback * 100}% 位置重新研发`;
        events.push(msg);
        if (world) { world.logLine(world.day, msg, "research"); world.addNews("international", msg); }
        if (this.failures >= 3) {
          this.stalled = true;
          if (world) world.logLine(world.day, "🔬 研发宣告停滞", "research");
        }
      } else {
        this.stage += 1;
        if (this.stage >= RESEARCH_STAGE_WEIGHTS.length) {
          this.done = true;
          const msg = "💉 疫苗研发完成，进入量产（人类获得控制疫情的手段）";
          events.push(msg);
          if (world) { world.logLine(world.day, msg, "research"); world.addNews("international", msg); }
        } else {
          const msg = `🔬 疫苗研发进入 ${this.stage_name} 阶段`;
          events.push(msg);
          if (world) { world.logLine(world.day, msg, "research"); }
        }
      }
    }
    boostDays(days, reason) {
      if (this.done || this.stalled) return;
      this._boosts += days;
      const msg = `🔬 ${reason}：研发提速 ${days} 天`;
      this._logs.push(msg);
      if (!this.unlocked) { this._pending_boost += days; return; }
      this.progress_days = Math.min(this.total_days, this.progress_days + days);
    }
    unlock() {
      this.unlocked = true;
      if (this._pending_boost > 0) {
        this.progress_days = Math.min(this.total_days, this.progress_days + this._pending_boost);
        this._pending_boost = 0.0;
      }
    }
    delayDays(days, reason) {
      if (this.done || this.stalled) return;
      this.progress_days = Math.max(0.0, this.progress_days - days);
      this._logs.push(`🔬 ${reason || "研发失误"}：进度倒退 ${days} 天`);
    }
    restartFrom(frac, reason) {
      this.progress_days = this.total_days * frac;
      this.stage = 0;
      this.done = false;
      this.stalled = false;
      this.failures = 0;
      this._logs.push(`🔬 现有疫苗效力不足，${reason || "新变异株"}触发新疫苗研发（从 ${frac * 100}% 进度重启）`);
    }
  }

  // =====================================================================
  // 随机事件系统
  // =====================================================================
  const EVENT_KEYS = ["mutation", "gathering", "disaster", "unrest",
    "mass_testing", "treatment", "animal_reservoir", "research_incident"];
  const EVENT_LABEL = {
    mutation: "有益变异", gathering: "大规模聚集", disaster: "天灾/战乱",
    unrest: "暴乱", mass_testing: "全民检测", treatment: "特效药物",
    animal_reservoir: "动物宿主排查", research_incident: "研发失误/全球合作",
  };

  class EventSystem {
    constructor(cfg, world, rng) {
      this.cfg = cfg;
      this.world = world;
      this.rng = rng;
      this.last = {};
      this.modifiers = {};
    }
    interval(key) {
      if (key === "mutation") {
        const idx = this.cfg.mutation_interval_index[this.cfg.difficulty];
        return this.cfg.event_intervals[key][idx];
      }
      return this.cfg.event_intervals[key];
    }
    autoTick(day) {
      if (this.cfg.event_daily_prob <= 0) return;
      for (const key of EVENT_KEYS) {
        const interval = this.interval(key);
        const last = this.last[key] == null ? -999 : this.last[key];
        if (day - last >= interval && this.rng.random() < 1.0 / interval) {
          this.last[key] = day;
          this.trigger(key, day);
        }
      }
    }
    trigger(key, day) {
      switch (key) {
        case "mutation": return this._mutation(day);
        case "gathering": return this._gathering(day);
        case "disaster": return this._disaster(day);
        case "unrest": return this._unrest(day);
        case "mass_testing": return this._massTesting(day);
        case "treatment": return this._treatment(day);
        case "animal_reservoir": return this._animalReservoir(day);
        case "research_incident": return this._researchIncident(day);
      }
      return "未知事件: " + key;
    }
    triggerRandom(day) {
      const key = this.rng.choice(EVENT_KEYS);
      return this.trigger(key, day);
    }
    _pickCountry(weighted) {
      const cs = Object.values(this.world.countries);
      if (weighted === false) return this.rng.choice(cs);
      const w = cs.map(c => Math.max(c.I, 0.0) + 1.0);
      return this.rng.choices(cs, w, 1)[0];
    }
    _log(text, day) {
      this.world.logLine(day, text, "event");
      this.world.addNews("international", text);
      return text;
    }
    _mutation(day) {
      const evo = this.world.evolution;
      const active = evo.activeBranches();
      const pool = (active.length && this.rng.random() < 0.5)
        ? active.slice() : Object.keys(BRANCHES);
      const legal = [];
      for (const bid of pool) {
        const b = BRANCHES[bid];
        if (evo.levels[bid] >= b.level_cap) continue;
        const conflicts = new Set(b.conflicts);
        for (const other of Object.keys(BRANCHES)) {
          if (BRANCHES[other].conflicts.indexOf(bid) >= 0) conflicts.add(other);
        }
        let blocked = false;
        for (const o of conflicts) if (evo.levels[o] > 0) { blocked = true; break; }
        if (blocked) continue;
        if (evo.levels[bid] === 0) {
          let catActive = 0;
          for (const o of Object.keys(evo.levels)) {
            if (evo.levels[o] > 0 && BRANCHES[o].category === b.category) catActive++;
          }
          if (catActive >= 5) continue;
        }
        legal.push(bid);
      }
      if (!legal.length) return this._log("🧬 变异尝试：当前无可强化分支（冲突/上限限制）", day);
      const bid = this.rng.choice(legal);
      const gains = this.rng.random() < 0.4 ? 2 : 1;
      evo.levels[bid] = Math.min(BRANCHES[bid].level_cap, evo.levels[bid] + gains);
      evo.applyTo(this.world);
      return this._log(`🧬 有益变异：${BRANCHES[bid].name} +${gains} 级`, day);
    }
    _gathering(day) {
      const c = this._pickCountry();
      const boost = c.pop * 2.0;
      const mod = this.modifiers[c.iso3] || (this.modifiers[c.iso3] = {});
      mod.gathering_boost = [boost, day + 5];
      return this._log(`🎪 ${c.d.name_cn} 爆发大规模聚集：聚集场所人次升至 ${fmt0(boost)} 人次/日（持续 5 天）`, day);
    }
    _disaster(day) {
      const c = this._pickCountry(false);
      const mod = this.modifiers[c.iso3] || (this.modifiers[c.iso3] = {});
      mod.icu_mult = [0.25, day + 10];
      mod.test_min = [5000.0, day + 10];
      mod.delay_add = [5.0, day + 10];
      return this._log(`🌪 ${c.d.name_cn} 遭遇天灾/战乱：ICU 可运转床位下降、检测降至最低运转量、响应延迟 +5 天`, day);
    }
    _unrest(day) {
      const c = this._pickCountry();
      const mod = this.modifiers[c.iso3] || (this.modifiers[c.iso3] = {});
      mod.compliance_zero = [0.0, day + 7];
      return this._log(`🔥 ${c.d.name_cn} 发生暴乱：封锁遵从人次归零（持续 7 天）`, day);
    }
    _massTesting(day) {
      const c = this._pickCountry(false);
      const mod = this.modifiers[c.iso3] || (this.modifiers[c.iso3] = {});
      mod.test_full = [c.d.daily_tests, day + 5];
      return this._log(`🔬 ${c.d.name_cn} 开展全民检测：日检测量升至产能极限 ${fmt0(c.d.daily_tests)} 剂/日（持续 5 天）`, day);
    }
    _treatment(day) {
      if (!this.world.research.unlocked) return this._log("💊 特效药物研发失败：病原体尚未测序确认", day);
      if (!this.world.treatment_effective) return this._log("💊 特效药物发现，但病原体耐药：治疗参数未生效", day);
      this.world.treatment_death_delay += 5.0;
      this.world.treatment_sev_delta -= 0.01;
      return this._log("💊 特效药物上市：死亡延迟 +5 天、重症率 −0.01（文献药物参数）", day);
    }
    _animalReservoir(day) {
      const mod = this.modifiers.global || (this.modifiers.global = {});
      mod.reservoir_clear = [0.3, day + 10];
      return this._log("🐾 全球动物宿主排查：媒介/水源通道人次下降", day);
    }
    _researchIncident(day) {
      const r = this.world.research;
      if (r.done || !r.unlocked) return this._log("🔬 研发体系暂未启动，无效果", day);
      if (this.rng.random() < 0.5) {
        const days = this.rng.randint(30, 100);
        r.delayDays(days, "研发失误");
        return this._log(`🔬 研发重大失误：进度倒退 ${days} 天`, day);
      }
      r.boostDays(90.0, "全球合作");
      return this._log("🤝 全球科研合作：研发提速 90 天", day);
    }
    icuBedsEffective(c) {
      const mod = this.modifiers[c.iso3];
      if (mod && mod.icu_mult) {
        const [mult, until] = mod.icu_mult;
        if (this.world.day <= until) return c.icu_beds_eff * mult;
      }
      return c.icu_beds_eff;
    }
    testVolumeEffective(c) {
      const mod = this.modifiers[c.iso3];
      if (mod && mod.test_full) {
        const [vol, until] = mod.test_full;
        if (this.world.day <= until) return vol;
      }
      return null;
    }
    testVolumeCap(c, vol) {
      const mod = this.modifiers[c.iso3];
      if (mod && mod.test_min) {
        const [minVol, until] = mod.test_min;
        if (this.world.day <= until) return Math.min(vol, minVol);
      }
      return vol;
    }
    responseDelayEffective(c, baseDelay) {
      const mod = this.modifiers[c.iso3];
      let add = 0.0;
      if (mod && mod.delay_add) {
        const [a, until] = mod.delay_add;
        if (this.world.day <= until) add = a;
      }
      return Math.max(1, Math.round(baseDelay + add));
    }
    complianceEffective(c, compliance) {
      const mod = this.modifiers[c.iso3];
      if (mod && mod.compliance_zero) {
        const [val, until] = mod.compliance_zero;
        if (this.world.day <= until) return val;
      }
      return compliance;
    }
    gatheringBoostPeople(c) {
      const mod = this.modifiers[c.iso3];
      if (mod && mod.gathering_boost) {
        const [people, until] = mod.gathering_boost;
        if (this.world.day <= until) return people;
      }
      return 0.0;
    }
    reservoirMult() {
      const mod = this.modifiers.global;
      if (mod && mod.reservoir_clear) {
        const [mult, until] = mod.reservoir_clear;
        if (this.world.day <= until) return mult;
      }
      return 1.0;
    }
  }

  // =====================================================================
  // 世界（游戏主状态）
  // =====================================================================
  class World {
    constructor(cfg, countries, pathogen, city, seed) {
      this.cfg = cfg;
      this.seed = seed != null ? seed : Math.floor(Math.random() * 0x7fffffff);
      this.rng = new RNG(this.seed);
      this.day = 0;
      this.city = city;
      this.pathogen = pathogen;
      this.countries = {};
      for (const iso3 of Object.keys(countries)) {
        const d = countries[iso3];
        const c = new CountryState(d);
        c.icu_beds_eff = d.icu_beds;
        c.icu_queue = new ErlangDelay(cfg.erlang_icu_stages, cfg.icu_delay_mean_days);
        c.death_queue = new ErlangDelay(cfg.erlang_death_stages, cfg.death_delay_mean_days);
        for (const k of Object.keys(VENUE_BASE)) {
          c.venues[k] = new Venue(k, VENUE_BASE[k][0], VENUE_BASE[k][1], VENUE_BASE[k][2]);
        }
        this.countries[iso3] = c;
      }
      this.home_iso3 = city.iso3;
      if (!(this.home_iso3 in this.countries)) this.home_iso3 = Object.keys(this.countries)[0];
      const home = this.countries[this.home_iso3];
      home.I = 100.0;
      home.S = Math.max(0.0, home.pop - 100.0);
      home.cum_infected = 100.0;

      this._initPathogenParams();
      this.evolution = new EvolutionState(cfg, this.rng);
      this.research = new ResearchSystem(cfg, this.rng);
      this.events = new EventSystem(cfg, this, this.rng);
      this.weather = new WeatherEngine(cfg, this.countries, this.rng);
      this.reinfection_contacts = 0.005;
      this.evolution.applyTo(this);

      this.antigen_distance = 0.0;
      this.escape_level = 0;
      this.variant_announced = false;

      this.points = DIFFICULTY[cfg.difficulty].points;
      this.initial_points = this.points;
      this.ledger = [];
      this.overdraft_days = 0;
      this.debt = 0.0;

      this.attention = 0.0;
      this.sequencing_progress = 0.0;
      this.sequenced = 0.0;
      this._seq_start_day = null;
      this.influence = 0.0;
      this.influence_accum = 0.0;
      this._last_attention = 0.0;
      this._last_influence = 0.0;
      this._daily_deaths_delta = 0.0;
      this._last_det_home = 0.0;

      this.who_level = 0;
      this.who_announced = new Set();
      this.log = [];
      this.news = [];
      this.announcements = [];
      this.game_over = null;
      this.history = {};
      this.global_history = [];
      this._announced_countries = new Set();
      this._daily_new = 0.0;
      this._daily_deaths = 0.0;

      this.logLine(0, `🦠 病原体投放至 ${this.city.name_cn}（${this.home_iso3}）`, "outbreak");
    }

    _initPathogenParams() {
      const p = this.pathogen;
      let mu = p.ifr * p.gamma / Math.max(1e-9, 1.0 - p.ifr);
      mu = Math.min(mu, 1.0);
      const totalRate = p.r0_bench * (p.gamma + mu);
      const tau7 = aerosolHalfLife(7.0);
      let survTyp = 0;
      for (const k of Object.keys(VENUE_BASE)) {
        survTyp += VENUE_BASE[k][0] * (tau7 / (tau7 + VENUE_BASE[k][1]));
      }
      this.p_trans = Math.min(1.0, totalRate / survTyp);
      this.mu_base = mu;
      this.gamma = p.gamma;
      this.sigma = p.sigma;
      this.asymp_frac = p.asymp_frac;
      this.sev_rate = p.sev_rate;
      this.route = p.route;
      this.tau_bonus = 0.0;
      this.env_sens = 1.0;
      this.test_sensitivity = 1.0;
      this.escape_level = 0;
      this.water_frac = 0.0;
      this.vector_frac = 0.0;
      this.death_delay_extra = 0.0;
      this.treatment_death_delay = 0.0;
      this.treatment_effective = true;
      this.sev_rate_delta = 0.0;
      this.treatment_sev_delta = 0.0;
    }

    logLine(day, text, style) {
      this.log.push([day, text, style || "info"]);
      if (this.log.length > this.cfg.log_max) this.log.splice(0, this.log.length - this.cfg.log_max);
    }
    addNews(layer, text) {
      this.news.push([this.day, layer, text]);
      if (this.news.length > this.cfg.log_max) this.news.splice(0, this.news.length - this.cfg.log_max);
    }

    venuePeople(c, name) {
      const v = c.venues[name];
      const dens = densityFactor(c.pop / (c.d.area_km2 || 1));
      let people = v.targetPeople(c.pop, dens, this.cfg.gathering_essential_people_day, c.compliance);
      if (name === "gathering") {
        const boost = this.events.gatheringBoostPeople(c);
        if (boost > 0) people = Math.max(people, boost);
      }
      return people;
    }
    venueSurv(c, v) {
      if (ROUTE_SURV[this.route] === "const") return 1.0;
      const tau = aerosolHalfLife(c.ah * this.env_sens) + this.tau_bonus;
      return tau / (tau + v.exposure_hours);
    }
    countryBeta(c) {
      const dens = densityFactor(c.pop / (c.d.area_km2 || 1));
      let contrib = 0.0, qBeta = 0.0;
      c.beta_trace = [];
      for (const name of Object.keys(c.venues)) {
        const v = c.venues[name];
        const people = this.venuePeople(c, name);
        let surv = this.venueSurv(c, v);
        if (this.route === "contact" && name === "community") surv = 1.0;
        const perCap = people / c.pop;
        const k = perCap * this.p_trans * surv;
        contrib += k;
        c.beta_trace.push([name, people, surv, k]);
        if (name === "home") qBeta = k;
      }
      if (this.water_frac > 0) {
        const water = c.pop * this.water_frac * this.events.reservoirMult();
        const k = (water / c.pop) * this.p_trans;
        contrib += k;
        c.beta_trace.push(["water", water, 1.0, k]);
      }
      if (this.vector_frac > 0) {
        const m = this.vectorActivity(c.temp);
        const vector = c.pop * this.vector_frac * m * this.events.reservoirMult();
        const k = (vector / c.pop) * this.p_trans;
        contrib += k;
        c.beta_trace.push(["vector", vector, 1.0, k]);
      }
      return [contrib, qBeta];
    }
    vectorActivity(temp) {
      if (temp >= 25) return 1.0;
      if (temp <= 15) return 0.1;
      return 0.1 + 0.9 * (temp - 15) / 10.0;
    }
    smugglingPeople(c) {
      const base = { 5: 50.0, 4: 200.0, 3: 800.0, 2: 3000.0, 1: 8000.0 };
      return base[c.d.border_control] != null ? base[c.d.border_control] : 800.0;
    }
    borderFlow(src, dst) {
      if (dst.borders[src.iso3] === false) {
        if (dst.d.border_control >= 5) return 0.0;
        return this.smugglingPeople(dst);
      }
      const d = Math.max(1.0, haversineKm(src.d.lat, src.d.lon, dst.d.lat, dst.d.lon));
      return src.pop * this.cfg.commute_fraction * Math.exp(-d / 2500.0);
    }
    fatigueCompliance(c) {
      if (c.lockdown_days <= 0) return 1.0;
      if (c.lockdown_days <= this.cfg.fatigue_plateau_days) return 1.0;
      const f = this.cfg.fatigue_logistic;
      const days = c.lockdown_days - this.cfg.fatigue_plateau_days;
      const z = f.b * c.d.trust + f.c * c.infection_rate + f.d - f.a * days;
      return 1.0 / (1.0 + Math.exp(-z));
    }
    rhoExcessMortality(rho) {
      const xs = RHO_CURVE.map(p => p[0]);
      const ys = RHO_CURVE.map(p => p[1]);
      if (rho <= xs[0]) return ys[0];
      if (rho >= xs[xs.length - 1]) return ys[ys.length - 1];
      for (let i = 0; i < xs.length - 1; i++) {
        if (xs[i] <= rho && rho <= xs[i + 1]) {
          const t = (rho - xs[i]) / (xs[i + 1] - xs[i]);
          return ys[i] + t * (ys[i + 1] - ys[i]);
        }
      }
      return 1.0;
    }
    vaccinationUptake(c) {
      const fatigue = c.lockdown_days > 0 ? this.fatigueCompliance(c) : 1.0;
      const deathFactor = 1.0 + c.cum_deaths / Math.max(1.0, c.pop * 0.001);
      const want = c.d.trust * fatigue * Math.min(deathFactor, 3.0);
      return c.pop * 8.0 / 1000.0 * want;
    }
    veEffective(ve0) {
      return ve0 * Math.pow(0.5, this.antigen_distance / this.cfg.ve_decay_halfway);
    }

    // ---------- 主流程 ----------
    stepDay() {
      this.day += 1;
      this.announcements = [];
      this.weather.step(this.day);
      for (const c of Object.values(this.countries)) {
        const w = this.weather.current[c.iso3];
        c.temp = w.temp; c.hum = w.hum; c.ah = w.ah; c.season = w.season;
      }
      this._variantStep();
      this.research.step(this);
      this.events.autoTick(this.day);
      this._governmentStep();
      this._applyMobility();
      this._integrateAll();
      this._settlePoints();
      this._attentionStep();
      this._whoStep();
      this._checkWinloss();
      this._recordHistory();
    }

    _variantStep() {
      this.antigen_distance += (this.cfg.antigen_drift_natural
        + this.escape_level * this.cfg.escape_speed_per_level
        + this.rng.gauss(0.0, 0.0005));
      this.antigen_distance = Math.max(0.0, this.antigen_distance);
      if (this.antigen_distance > 5.0 && !this.variant_announced) {
        this.variant_announced = true;
        this.addNews("international", `🧬 检测到显著抗原漂移的新变异株（抗原距离 ${this.antigen_distance.toFixed(1)}）`);
        this.logLine(this.day, "🧬 显著抗原漂移出现，现有疫苗效力下降", "event");
      }
      if (this.research.done && this.veEffective(0.95) < 0.5) {
        this.research.restartFrom(this.cfg.new_vaccine_start_progress, "免疫逃逸");
        this.addNews("international", "💉 现有疫苗效力不足，新疫苗研发自动启动（30% 进度）");
      }
    }

    _governmentStep() {
      const diff = DIFFICULTY[this.cfg.difficulty];
      for (const c of Object.values(this.countries)) {
        const due = c.gov_actions.filter(a => a[0] <= this.day);
        for (const [_, action] of due) this._executeGovAction(c, action);
        c.gov_actions = c.gov_actions.filter(a => a[0] > this.day);
        const baseDelay = Math.max(1, Math.round(c.d.response_delay * diff.delay_scale));
        const delay = this.events.responseDelayEffective(c, baseDelay);
        if (c.infection_rate > this.cfg.response_threshold_infection_rate
          && c.venues.gathering.mode !== "closed"
          && !c.gov_actions.some(a => a[1] === "close_gathering")) {
          c.gov_actions.push([this.day + delay, "close_gathering", "感染率超阈值"]);
          this.announcements.push(`🏛 ${c.d.name_cn} 将于 ${delay} 天后关闭聚集场所`);
        }
        const rho = c.icu_occ / Math.max(1.0, this.events.icuBedsEffective(c));
        if (rho > this.cfg.response_threshold_rho && !c.emergency
          && !c.gov_actions.some(a => a[1] === "medical_emergency")) {
          c.gov_actions.push([this.day + delay, "medical_emergency", "ICU 承压"]);
          this.announcements.push(`🏥 ${c.d.name_cn} 将于 ${delay} 天后进入医疗紧急状态`);
        }
        for (const iso3 of Object.keys(this.countries)) {
          if (iso3 === c.iso3) continue;
          const nb = this.countries[iso3];
          if (nb.infection_rate > this.cfg.border_close_neighbor_rate
            && c.borders[iso3] !== false
            && !c.gov_actions.some(a => a[1] === `close_border:${iso3}`)) {
            c.gov_actions.push([this.day + delay, `close_border:${iso3}`, "邻国疫情"]);
          }
        }
        if (c.infection_rate < this.cfg.response_relax_rate) {
          c.relax_days += 1;
          if (c.relax_days >= this.cfg.response_relax_days) {
            c.relax_days = 0;
            if (c.venues.gathering.mode !== "normal") {
              c.gov_actions.push([this.day, "restore_venues", "疫情缓解"]);
              this.announcements.push(`🏛 ${c.d.name_cn} 解除场所限制`);
            }
          }
        } else {
          c.relax_days = 0;
        }
      }
    }

    _executeGovAction(c, action) {
      if (action === "close_gathering") {
        c.venues.gathering.mode = "closed";
        c.lockdown_days = Math.max(c.lockdown_days, 0);
        c.relax_days = 0;
        this.logLine(this.day, `🔒 ${c.d.name_cn} 关闭聚集场所（聚集人次降至民生必需）`, "gov");
      } else if (action === "medical_emergency") {
        c.emergency = true;
        c.icu_beds_eff += this.cfg.icu_expansion_per_month;
        this.logLine(this.day, `🏥 ${c.d.name_cn} 进入医疗紧急状态，一次性扩床 ${fmt0(this.cfg.icu_expansion_per_month)} 张`, "gov");
      } else if (action === "restore_venues") {
        for (const v of Object.values(c.venues)) v.mode = "normal";
        c.lockdown_days = 0;
      } else if (action.startsWith("close_border:")) {
        const target = action.split(":", 2)[1];
        c.borders[target] = false;
        this.logLine(this.day, `🚧 ${c.d.name_cn} 关闭对 ${target} 的口岸（保留偷渡通道）`, "gov");
      }
    }

    _applyMobility() {
      let quarantine = this.cfg.quarantine_capacity_base;
      if (this.who_level >= 1) quarantine = this.cfg.quarantine_capacity_who1;
      for (const c of Object.values(this.countries)) {
        let inflowE = 0.0, inflowI = 0.0;
        for (const src of Object.values(this.countries)) {
          if (src.iso3 === c.iso3) continue;
          const flow = this.borderFlow(src, c);
          const frac = flow / Math.max(1.0, src.pop);
          inflowE += src.E * frac;
          inflowI += src.I * frac;
          src.E -= src.E * frac;
          src.I -= src.I * frac;
        }
        const inflowTotal = inflowE + inflowI;
        const qCap = Math.min(quarantine, inflowTotal);
        const coverage = inflowTotal > 0 ? qCap / inflowTotal : 0.0;
        const qI = inflowI * coverage * (1.0 - this.asymp_frac);
        c.E += inflowE;
        c.I += inflowI - qI;
        c.Q += qI;
      }
    }

    _integrateAll() {
      const cfg = this.cfg;
      const veSus = this.veEffective(0.95);
      const veSev = this.veEffective(0.90);
      let escapeFrac = 0.0;
      if (this.antigen_distance >= this.cfg.escape_reinfection_threshold) {
        escapeFrac = 1.0 - Math.pow(0.5, this.antigen_distance / 30.0);
      }
      let totalNew = 0.0, deathsToday = 0.0;
      const deathMean = Math.max(1.0, cfg.death_delay_mean_days + this.death_delay_extra + this.treatment_death_delay);
      for (const c of Object.values(this.countries)) {
        c.death_queue.mean = deathMean;
        c.death_queue.rate = c.death_queue.stages / Math.max(0.5, deathMean);
        if (c.venues.gathering.mode === "closed") c.lockdown_days += 1;
        else c.lockdown_days = 0;
        c.compliance = this.events.complianceEffective(c, this.fatigueCompliance(c));

        const [beta, qBeta] = this.countryBeta(c);
        c.beta = beta;
        c.q_beta = qBeta;
        c.r_eff = (beta + qBeta) / (this.gamma + this.mu_base)
          * Math.min(1.0, c.pop ? c.S / c.pop : 0.0);

        const eventVol = this.events.testVolumeEffective(c);
        if (eventVol != null) {
          c.test_volume = eventVol;
        } else {
          c.test_volume = c.emergency ? c.d.daily_tests : Math.min(cfg.test_routine_volume, c.d.daily_tests);
        }
        c.test_volume = this.events.testVolumeCap(c, c.test_volume);

        const dt = 1.0 / cfg.dt_substeps;
        let countryNew = 0.0, newFromV = 0.0;
        for (let _ = 0; _ < cfg.dt_substeps; _++) {
          const sEff = c.S + c.V * (1.0 - veSus);
          let inf = (beta * c.I + qBeta * c.Q) * sEff / c.pop * dt;
          inf = Math.min(inf, sEff);
          const fromS = Math.min(inf * c.S / Math.max(1e-9, sEff), c.S);
          const fromV = Math.min(Math.max(0.0, inf - fromS), c.V);
          const moved = fromS + fromV;
          c.S -= fromS;
          c.V -= fromV;
          c.E += moved;
          const expo = Math.min(this.sigma * c.E * dt, c.E);
          c.E -= expo;
          c.I += expo;
          const icuBeds = this.events.icuBedsEffective(c);
          const rho = c.icu_occ / Math.max(1.0, icuBeds);
          const muEff = this.mu_base * this.rhoExcessMortality(rho);
          const out = Math.min((this.gamma + muEff) * c.I * dt, c.I);
          const rec = out * this.gamma / (this.gamma + muEff);
          const die = out - rec;
          c.I -= out;
          c.R += rec;
          c.death_queue.push(die);
          c.cum_infected += moved;
          countryNew += moved;
          newFromV += fromV;
        }
        c.mu_eff = this.mu_base * this.rhoExcessMortality(
          c.icu_occ / Math.max(1.0, this.events.icuBedsEffective(c)));
        c.new_today = countryNew;

        const vacShare = countryNew > 0 ? newFromV / countryNew : 0.0;
        const sevToday = Math.max(0.0, this.sev_rate + this.sev_rate_delta + this.treatment_sev_delta)
          * (1.0 - veSev * vacShare);
        c.icu_queue.push(countryNew * Math.min(1.0, sevToday));

        const sens = this.research.unlocked ? this.test_sensitivity : 0.001;
        const symNew = countryNew * (1.0 - this.asymp_frac);
        const det = Math.min(Math.min(c.test_volume * sens, symNew), c.I);
        c.I -= det;
        c.Q += det;
        c.cum_detected += det;
        const qOut = c.Q / cfg.quarantine_days;
        c.Q -= qOut;
        c.R += qOut;

        let doses = 0.0;
        if (this.research.done) {
          doses = Math.min(c.d.vaccine_capacity, this.vaccinationUptake(c));
        }
        if (doses > 0) {
          const elderlyLeft = Math.max(0.0, c.pop * cfg.vaccination_priority_elderly * cfg.elderly_coverage_cap - c.vac_elderly);
          const toElderly = Math.min(doses, elderlyLeft);
          const elderlyUnvac = Math.max(0.0, c.pop * cfg.vaccination_priority_elderly - c.vac_elderly);
          const unvac = Math.max(0.0, c.pop - c.V - c.R - c.D);
          const adultPool = Math.max(0.0, unvac - elderlyUnvac);
          const toAdult = Math.min(doses - toElderly, adultPool);
          const movedV = Math.min(toElderly + toAdult, c.S);
          c.S -= movedV;
          c.V += movedV;
          c.vac_elderly += toElderly;
          c.vac_adult += toAdult;
          c.vaccinated_doses += doses;
        }

        const reinf = Math.min(c.R * escapeFrac * this.reinfection_contacts, c.R);
        c.R -= reinf;
        c.E += reinf;

        const died = c.death_queue.step();
        c.D += died;
        c.cum_deaths = c.D;
        deathsToday += died;
        const icuIn = c.icu_queue.step();
        c.icu_occ += icuIn;
        c.icu_occ = Math.max(0.0, c.icu_occ - c.icu_occ / 14.0);

        totalNew += countryNew;
      }
      this._daily_new = totalNew;
      this._daily_deaths_delta = deathsToday;
    }

    _settlePoints() {
      const cfg = this.cfg;
      const diff = DIFFICULTY[cfg.difficulty];
      const bonus = diff.gain_bonus;
      let gain = 0.0;
      const newInf = this._daily_new;
      gain += (newInf / 10000.0) * cfg.points_per_10k_new_infected;
      if (newInf > 0) gain += bonus;
      const deaths = this._daily_deaths_delta;
      gain += (deaths / 1000.0) * cfg.points_per_1k_deaths;
      if (deaths > 0) gain += bonus;
      let newCountries = 0;
      for (const c of Object.values(this.countries)) {
        if (c.cum_infected >= 100.0 && !this._announced_countries.has(c.iso3)) {
          this._announced_countries.add(c.iso3);
          newCountries += 1;
        }
      }
      gain += newCountries * cfg.points_per_new_country;
      if (newCountries) gain += bonus;
      const inflDelta = Math.max(0.0, this.influence - this._last_influence);
      this._last_influence = this.influence;
      const inflGain = Math.floor(inflDelta / 10.0) * cfg.points_per_10_influence;
      gain += inflGain;
      if (inflGain) gain += bonus;
      if (gain > 0) {
        this.points += gain;
        this.ledger.push([this.day, "收入", gain,
          `新增感染${fmt0(newInf)}/死亡${fmt0(deaths)}/新国${newCountries}/影响力${fmt0(this.influence)}`]);
      }
      if (this.points < 0 && diff.overdraft) {
        this.debt = Math.max(this.debt, -this.points);
        const interest = this.debt * cfg.overdraft_interest;
        this.points -= interest;
        this.debt += interest;
        this.ledger.push([this.day, "利息", -interest, `欠款日息（欠款 ${this.debt.toFixed(1)}）`]);
        this.overdraft_days += 1;
        if (this.overdraft_days >= cfg.overdraft_days_to_degrade) {
          this.overdraft_days = 0;
          const degraded = this.evolution.randomDegrade(this.rng, this);
          if (degraded) {
            this.ledger.push([this.day, "退化", 0.0, `欠款未还，随机退化分支 ${degraded}`]);
            this.logLine(this.day, `⚠ 欠款未还，随机退化进化分支：${degraded}`, "points");
          }
        }
      } else {
        this.overdraft_days = 0;
        this.debt = Math.max(0.0, this.debt);
      }
    }

    balanceCheck() {
      let calc = this.initial_points;
      for (const [, , amt] of this.ledger) calc += amt;
      return this.points - calc;
    }

    _attentionStep() {
      let detected = 0;
      for (const c of Object.values(this.countries)) detected += c.cum_detected;
      const detDelta = Math.max(0.0, detected - this._last_attention);
      this._last_attention = detected;
      this.attention += detDelta * (1.0 - this.asymp_frac) / 1000.0;
      if (detected > 0 && this._seq_start_day == null) this._seq_start_day = this.day;
      if (this._seq_start_day != null) {
        const elapsed = this.day - this._seq_start_day + 1;
        const prev = this.sequenced;
        this.sequenced = Math.min(detected, 50000.0 * elapsed);
        const seqToday = Math.max(0.0, this.sequenced - prev);
        this.attention += seqToday / 50000.0 * 10.0;
        const timeFrac = elapsed / this.cfg.sequencing_days;
        this.sequencing_progress = Math.min(1.0, timeFrac, this.sequenced / Math.max(1.0, detected));
      }
      if (this.sequencing_progress >= 1.0 && !this.research.unlocked) {
        this.research.unlock();
        this.addNews("international", "🔬 测序完成，病原体全基因组公布，研发解锁");
        this.logLine(this.day, "🔬 官方公布病原体测序结果，疫苗研发解锁", "research");
      }
      let covered = 0;
      for (const c of Object.values(this.countries)) if (c.cum_infected >= 100) covered++;
      covered /= Object.keys(this.countries).length || 1;
      let totalCum = 0, totalPop = 0;
      for (const c of Object.values(this.countries)) { totalCum += c.cum_infected; totalPop += c.pop; }
      const frac = totalPop > 0 ? totalCum / totalPop : 0;
      const w = this.cfg.influence_weights;
      this.influence = this.attention * w[0] + covered * w[1] + frac * w[2] + (this.who_level / 4.0) * w[3];
    }

    _whoStep() {
      let infectedCountries = 0;
      const continents = new Set();
      let totalInf = 0, totalDeaths = 0;
      for (const c of Object.values(this.countries)) {
        if (c.cum_infected >= 100) {
          infectedCountries++;
          continents.add(c.d.continent);
        }
        totalInf += c.cum_infected;
        totalDeaths += c.cum_deaths;
      }
      let level = 0;
      if (infectedCountries >= this.cfg.who1_countries) level = 1;
      if (infectedCountries >= this.cfg.who2_countries && continents.size >= this.cfg.who2_continents) level = 2;
      if (infectedCountries >= this.cfg.who3_countries && totalInf >= this.cfg.who3_infected) level = 3;
      if (totalInf >= this.cfg.who4_infected && totalDeaths >= this.cfg.who4_deaths) level = 4;
      if (level > this.who_level) {
        for (let lv = this.who_level + 1; lv <= level; lv++) {
          if (!this.who_announced.has(lv)) {
            this.who_announced.add(lv);
            const names = { 1: "本土传播", 2: "跨洲传播", 3: "PHEIC 国际关注突发公共卫生事件", 4: "全球紧急状态" }[lv];
            this.addNews("international", `🏛 WHO 发布 ${lv} 级预警：${names}`);
            this.logLine(this.day, `🏛 WHO ${lv} 级预警：${names}`, "who");
            this.announcements.push(`🏛 WHO ${lv} 级预警：${names}`);
            if (lv >= 2 && !this.research.cooperation_used) {
              this.research.boostDays(this.cfg.research_boost_who2_days, "全球研发合作");
              this.research.cooperation_used = true;
            }
            if (lv >= 3) this.research.boostDays(this.cfg.research_boost_who3_days, "PHEIC 研发提速");
            if (lv >= 4) this._imposeGlobalLockdown();
          }
        }
      }
      this.who_level = level;
    }

    _imposeGlobalLockdown() {
      let forced = 0;
      for (const c of Object.values(this.countries)) {
        if (c.venues.gathering.mode !== "closed") {
          c.venues.gathering.mode = "closed";
          forced++;
        }
      }
      if (forced) {
        this.addNews("international", `🏛 WHO 4 级全球静态管理：${forced} 国聚集场所降至民生必需限值`);
        this.logLine(this.day, `🏛 WHO 4 级全球静态管理：${forced} 国聚集场所强制关闭`, "who");
      }
    }

    _checkWinloss() {
      let totalPop = 0, totalInf = 0;
      for (const c of Object.values(this.countries)) { totalPop += c.pop; totalInf += c.cum_infected; }
      if (totalPop > 0 && totalInf / totalPop >= this.cfg.win_infection_total) {
        this.game_over = "win";
        return;
      }
      let active = 0;
      for (const c of Object.values(this.countries)) active += c.E + c.I + c.Q;
      if (active < 1.0) this.game_over = "lose";
    }

    _recordHistory() {
      let cum = 0, active = 0, rec = 0, dead = 0;
      let r0Num = 0, r0Den = 0;
      for (const c of Object.values(this.countries)) {
        const row = [this.day, c.iso3, c.d.name_cn, c.pop, Math.round(c.S), Math.round(c.E),
          Math.round(c.I), Math.round(c.R), Math.round(c.D), Math.round(c.Q), Math.round(c.V),
          Math.round(c.cum_infected), c.infection_rate, c.beta, c.mu_eff, c.r_eff,
          c.temp, c.hum, c.ah, c.season, Math.round(c.icu_occ), Math.round(c.cum_detected),
          Math.round(c.vaccinated_doses)];
        (this.history[c.iso3] || (this.history[c.iso3] = [])).push(row);
        cum += Math.round(c.cum_infected);
        active += Math.round(c.I);
        rec += Math.round(c.R);
        dead += Math.round(c.D);
        r0Num += c.r_eff * c.I;
        r0Den += c.I;
      }
      const r0Live = r0Den > 1e-9 ? r0Num / r0Den : 0.0;
      this.global_history.push([this.day, cum, active, rec, dead, Math.round(this._daily_new),
        +r0Live.toFixed(4), +this.antigen_distance.toFixed(3), +this.points.toFixed(1)]);
    }

    globalStats() {
      let cum = 0, active = 0, rec = 0, dead = 0;
      let r0Num = 0, r0Den = 0;
      for (const c of Object.values(this.countries)) {
        cum += c.cum_infected;
        active += c.I;
        rec += c.R;
        dead += c.D;
        r0Num += c.r_eff * c.I;
        r0Den += c.I;
      }
      const r0Live = r0Den > 1e-9 ? r0Num / r0Den : 0.0;
      return { cum, active, recovered: rec, deaths: dead, r0_live: r0Live, new: this._daily_new };
    }

    dailyNews() {
      const home = this.countries[this.home_iso3];
      const out = [];
      if (home.new_today > 0) {
        out.push(["本地", `${this.city.name_cn} 当日新增感染 ${fmt0(home.new_today)} 例（累计 ${fmt0(home.cum_infected)}）`]);
      }
      const det = home.cum_detected - this._last_det_home;
      this._last_det_home = home.cum_detected;
      if (det > 0) out.push(["本地", `${this.city.name_cn} 当日检出 ${fmt0(det)} 例，隔离观察中`]);
      if (home.venues.gathering.mode === "closed") {
        out.push(["本地", `${home.d.name_cn} 聚集场所关闭（民生必需限值运营）`]);
      } else if (home.venues.gathering.mode === "half") {
        out.push(["本地", `${home.d.name_cn} 聚集场所半运营`]);
      }
      if (home.cum_deaths > 0) out.push(["国内", `${home.d.name_cn} 累计死亡 ${fmt0(home.cum_deaths)} 例`]);
      if (this.research.unlocked && !this.research.done) {
        out.push(["国内", `${home.d.name_cn} 疫苗研发进入 ${this.research.stage_name} 阶段（剩余约 ${Math.round(this.research.remainingDays())} 天）`]);
      }
      if (this.research.done) {
        out.push(["国内", `${home.d.name_cn} 已开展疫苗接种（日产能 ${fmt0(home.d.vaccine_capacity)} 剂）`]);
      }
      let infected = 0;
      for (const c of Object.values(this.countries)) if (c.cum_infected >= 100) infected++;
      out.push(["国际", `全球 ${infected} 国出现传播，累计感染 ${fmt0(this.globalStats().cum)} 例`]);
      const worst = Object.values(this.countries).sort((a, b) => b.I - a.I);
      for (const c of worst) {
        if (c.iso3 !== home.iso3 && c.cum_infected > 0) {
          out.push(["国际", `${c.d.name_cn} 活跃感染 ${fmt0(c.I)} 例`]);
          break;
        }
      }
      if (this.who_level >= 1) out.push(["国际", `WHO ${this.who_level} 级预警生效`]);
      if (this.antigen_distance > 2.0) {
        out.push(["国际", `变异株抗原距离 ${this.antigen_distance.toFixed(1)}，现有疫苗效力下降`]);
      }
      return out.slice(0, 8);
    }

    run(days) {
      const end = days != null ? this.day + days : null;
      while ((end == null || this.day < end) && !this.game_over) this.stepDay();
    }

    // 便捷：锁定国家数（UI 自动暂停用）
    lockedNations() {
      let n = 0;
      for (const c of Object.values(this.countries)) if (c.venues.gathering.mode === "closed") n++;
      return n;
    }
  }

  // =====================================================================
  // 数字格式
  // =====================================================================
  function fmt0(n) {
    return Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  }

  // =====================================================================
  // 对外接口
  // =====================================================================
  function newGame(opts) {
    opts = opts || {};
    const cfg = new Config();
    if (opts.difficulty) cfg.difficulty = opts.difficulty;
    const countries = opts.countries || builtinCountries();
    const pathogen = opts.pathogenKey ? pathogenLibrary()[opts.pathogenKey] : pathogenLibrary().covid;
    let city;
    if (opts.cityName) city = cityLibrary()[opts.cityName] || Object.values(cityLibrary())[0];
    else city = Object.values(cityLibrary())[0];
    return new World(cfg, countries, pathogen, city, opts.seed);
  }

  return {
    RNG, Config, World, CountryState, Venue, ErlangDelay, WeatherEngine,
    builtinCountries, pathogenLibrary, cityLibrary, matchCity, newGame,
    BRANCHES, CATEGORY_CN, EVENT_KEYS, EVENT_LABEL, RESEARCH_STAGES, RESEARCH_STAGE_FAIL,
    DIFFICULTY, DIFFICULTY_CN, ROUTE_CN, SEASON_LABEL, VENUE_BASE, RHO_CURVE, fmt0,
  };
});