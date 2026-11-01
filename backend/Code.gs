/**
 * 門市物料異常回報系統 — 後端（Google Apps Script Web App）
 * 功能：案件清單讀取、建立（含附件上傳 Google Drive）、處理結果更新、LINE 推播
 *
 * === 超簡易設定 ===
 * 1) 把本檔整個貼進 Apps Script。
 * 2) （可選）把下面的 API_TOKEN 改成你自己的密碼，要和前端 HTML 的 API_TOKEN 一致。
 * 3) 上方選單先執行一次 setup（會自動建立試算表＋附件資料夾，並跳出授權同意請按允許）。
 * 4) 右上「部署 → 新增部署作業 → 網頁應用程式」，執行身分=我、存取權=所有人 → 複製 /exec 網址。
 * 5) 把 /exec 網址貼到前端 HTML 的 API_URL。
 *
 * 試算表與 Drive 資料夾「會自動建立」，不必手動建檔或填 ID。
 * 之後想知道它們在哪，執行一次 showLinks 即可在記錄看到網址。
 */

// ===== 設定 =====
const CONFIG = {
  API_TOKEN:      'gkt00TlVXvaARtTtBthQ9MUechEw',  // ★必須與前端 HTML 的 API_TOKEN 完全一致
  ADMIN_PASSWORD: '',                              // ★留空＝管理後台不需密碼(admin.html 點進去直接進)；要恢復密碼就填回字串
  SHEET_NAME:     'cases',
  PRODUCTS_SHEET: 'products',           // 品名主檔工作表（可直接在試算表編輯）
  STORES_SHEET:   'stores',             // 門市主檔工作表（可直接在試算表編輯）
  ASSET_NAME:     '門市異常回報系統',    // 自動建立的試算表／資料夾名稱
  // LINE 推播（選填；前台「LINE 通知設定」填了就會用前台的，這裡可留空）
  LINE_TOKEN: '',
  LINE_TO:    '',                      // userId / groupId，多個用逗號分隔；留空 => 改用廣播
  // LINE 通知內容範本（前台「LINE 通知設定」可調整；可用的代入欄位見下）
  // {caseNo} 案件編號 {name} 品名 {qty} 異常數量 {mat} 異常料號 {mfg} 製造日期
  // {exp} 有效日期 {date} 異常日期 {desc} 異常說明 {cls} 異常分類 {store} 門市 {supervisor} 負責督導 {link} 連結
  LINE_TEMPLATE:
    '【門市物料異常通知】\n' +
    '案件編號：{caseNo}\n' +
    '品名：{name}\n' +
    '異常數量：{qty}\n' +
    '異常料號：{mat}\n' +
    '製造日期：{mfg}\n' +
    '有效日期：{exp}\n' +
    '異常日期：{date}\n' +
    '異常說明：{desc}\n' +
    '連結：{link}',
  LINE_LINK: 'https://johney8590-svg.github.io/store-anomaly-report-web/admin.html'  // {link} 代入值＝管理入口，人員點進去可直接登入處理
};

// ⚠ 新欄位一律加在最後（舊資料列不會錯位）
const HEADERS = ['caseNo','date','store','name','mat','mfg','exp','qty','cls','desc',
                 'mediaUrls','handle','method','result','status','createdAt',
                 'supp','history'];
// supp    ＝補件資料 JSON：{items, note, at, token, remindAt, remindCount, by}
// history ＝處理歷程 JSON：[{at, act, note}]
// status  ＝ pend 待處理 / doing 處理中 / supp 待補件 / done 已處理

// ===== 補件設定 =====
const SUPP = {
  SITE_URL: 'https://johney8590-svg.github.io/store-anomaly-report-web/index.html', // 門市補件頁（Script Property: SITE_URL 可覆寫）
  REMIND_DAYS: 1,                // 幾天沒補就催辦
  AFTER_STATUS: 'doing',         // 門市補件後回到「處理中」
  ITEMS: ['照片', '影片', '製造日期／有效日期', '批號或包裝標示照片', '異常數量', '其他說明']
};
// 督導 Email（預設值；會優先向「修繕進度系統」讀取最新督導信箱，讀不到才用這裡）
const DEFAULT_SUP_EMAILS = {
  '林雨慈 Ivory':  'ivorylin@1992sharetea.com',
  '呂韋興 Robert': 'Robertlu@1992sharetea.com',
  '許瑛琪 Lydia':  'lydiahsu@1992sharetea.com',
  '劉靜蓮 Jill':   'jillianliu@1992sharetea.com',
  '劉邦鑫 Benson': 'bensonliu@1992sharetea.com',
  '林凱琳 Liisa':  'liisalin@1992sharetea.com'
};

// 品名主檔初始資料（料號相同者已去重，保留 UG 版本）。
// 之後可直接在試算表的 products 分頁增刪改，前端下拉會即時同步。
const PRODUCTS_SEED = [
  ['UG 22oz-90打凸A白底雙層杯','M01030193'],
  ['UG 16oz-90打凸A白底雙層杯','M01030195'],
  ['PP-90注塑梅花分體蓋 白色','M01020297'],
  ['水蜜桃醬','F04020086'],
  ['稀釋版西柚糖漿','F04020088'],
  ['朱槿風味普洱紅茶','F01010104'],
  ['牛皮色紙漿二杯架','M01010155'],
  ['UG 牛皮色紙漿四杯架','M01010156'],
  ['蜜燕麥','F04040132'],
  ['茉香綠茶','F01010101'],
  ['桂花烏龍','F01010102'],
  ['鐵觀音','F01010103'],
  ['金絲紅茶','F01010108'],
  ['糯米香風味綠茶','F01010107'],
  ['山茶風味紅烏龍（B)','F01010112'],
  ['UG鮮乳','F07020048'],
  ['櫻島家鮮奶','F07020041'],
  ['歐登堡動物性鮮奶油','F07020042'],
  ['冰伯朗','F07020043'],
  ['紅西柚果粒罐頭','F04030108'],
  ['原味果凍粉','F03010256'],
  ['台糖精製細砂','F04010028'],
  ['靜岡抹茶粉360','F03010296'],
  ['綠哈密瓜風味糖漿','F04020087'],
  ['桂花糖漿','F04010069'],
  ['冷凍檸檬原汁','F04020101'],
  ['UG杯膜','M01020278'],
  ['UG杯膜B','DR12810001'],
  ['單杯魔術貼不織布提袋','M01040042'],
  ['雙杯無紡布保溫袋','M01040043'],
  ['四杯魔術貼不織布保冷袋','M01040057'],
  ['Mosa氣彈8.5g','M05010940'],
  ['電子發票','M08010023']
];

// 門市主檔初始資料。之後可直接在試算表 stores 分頁增刪改，前端下拉會即時同步。
const STORES_SEED = ['三重正義','中和南勢角','中壢中原','中壢新生','中山南西','信義永吉','信義虎林','信義通化','內壢忠孝','南投復興','台中中科','台中勤美','台中北平','台中大甲','台中大里','台中東山','台中東海','台中豐原','台中逢甲','台中黎明','台北大安','台北大巨蛋','台北石牌','台北萬芳','台北西湖','台南東寧','台南民生','台南永康','嘉義文化','基隆廟口','士林捷運','宜蘭礁溪','彰化員林','彰化彰基','忠孝敦化','斗六中山','新店民權','新竹民生','新竹清大','新莊幸福','板橋中正','林口長庚','桃園中正','桃園藝文','楊梅大成','永和永安市場','汐止中興','站前南陽','竹北勝利','竹北博愛','羅東民權','苗栗頭份','蘆洲光華','高雄巨蛋','高雄瑞隆','高雄美麗島'];

// ===== 一次性設定／查詢工具（在編輯器上方選單選擇後按執行）=====
function setup()     { getSpreadsheet_(); getFolder_(); getProductsSheet_(); getStoresSheet_(); showLinks(); }
function showLinks() {
  const p = props_();
  const ssId = p.getProperty('SPREADSHEET_ID');
  const fdId = p.getProperty('DRIVE_FOLDER_ID');
  Logger.log('試算表：' + (ssId ? 'https://docs.google.com/spreadsheets/d/' + ssId : '尚未建立'));
  Logger.log('附件資料夾：' + (fdId ? 'https://drive.google.com/drive/folders/' + fdId : '尚未建立'));
}

// ===== 自動建立／取得 試算表與 Drive 資料夾（ID 存在 Script Properties）=====
function props_() { return PropertiesService.getScriptProperties(); }

function getSpreadsheet_() {
  const p = props_();
  const id = p.getProperty('SPREADSHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* 被刪了就重建 */ } }
  const ss = SpreadsheetApp.create(CONFIG.ASSET_NAME);
  p.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getFolder_() {
  const p = props_();
  const id = p.getProperty('DRIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 被刪了就重建 */ } }
  const folder = DriveApp.createFolder(CONFIG.ASSET_NAME + ' 附件');
  p.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

// ===== 品名主檔（products 分頁，可直接在試算表編輯）=====
function getProductsSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CONFIG.PRODUCTS_SHEET);
  if (!sh) sh = ss.insertSheet(CONFIG.PRODUCTS_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['name', 'mat']);
    PRODUCTS_SEED.forEach(p => sh.appendRow(p));   // 首次自動帶入去重後的初始清單
  }
  return sh;
}
function listProducts_() {
  const sh = getProductsSheet_();
  const v = sh.getDataRange().getValues();
  if (v.length <= 1) return [];
  return v.slice(1)
    .filter(r => String(r[0] || '').trim() !== '')
    .map(r => ({ name: String(r[0]), mat: String(r[1] == null ? '' : r[1]) }));
}
// 管理端批次覆寫主檔（body.products = [{name,mat}, ...]）
function saveProducts_(body) {
  const list = (body.products || []).filter(p => p && String(p.name || '').trim() !== '');
  const sh = getProductsSheet_();
  sh.clearContents();
  sh.appendRow(['name', 'mat']);
  list.forEach(p => sh.appendRow([String(p.name), String(p.mat || '')]));
  return { saved: true, count: list.length };
}

// ===== 門市主檔（stores 分頁：name／supervisor 兩欄，可直接在試算表編輯）=====
function getStoresSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CONFIG.STORES_SHEET);
  if (!sh) sh = ss.insertSheet(CONFIG.STORES_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['name', 'supervisor', 'region']);
    STORES_SEED.forEach(n => sh.appendRow([n, '', '']));   // 首次自動帶入初始門市清單
  } else {
    if (sh.getLastColumn() < 2) sh.getRange(1, 2).setValue('supervisor');   // 舊資料只有一欄 → 補督導欄
    if (sh.getLastColumn() < 3) sh.getRange(1, 3).setValue('region');       // 再補區域欄
  }
  return sh;
}
// 門市名稱清單（維持舊格式，給既有前端用）
function listStores_() {
  return listStoreDir_().map(r => r.name);
}
// 門市＋督導＋區域 [{name, sup, region}]
function listStoreDir_() {
  const sh = getStoresSheet_();
  const v = sh.getDataRange().getValues();
  if (v.length <= 1) return [];
  return v.slice(1)
    .map(r => ({ name: String(r[0] || '').trim(), sup: String(r[1] || '').trim(), region: String(r[2] || '').trim() }))
    .filter(r => r.name !== '');
}
// 區域顯示順序（依門市清單出現順序）
function regionOrder_() {
  const seen = {}, out = [];
  listStoreDir_().forEach(r => { if (r.region && !seen[r.region]) { seen[r.region] = 1; out.push(r.region); } });
  return out;
}
// 某門市的負責督導（找不到回空字串；比對忽略「店」字尾）
function supOf_(store) {
  const list = listStoreDir_(), key = normStore_(store);
  const hit = list.filter(r => r.name === store)[0] || list.filter(r => normStore_(r.name) === key)[0];
  return hit ? hit.sup : '';
}
// 管理端批次覆寫門市主檔
// body.stores 可為 ['門市A', ...]、[['門市A','督導','區域'], ...] 或 [{name,sup,region}, ...]
function saveStores_(body) {
  const seen = {}, list = [];
  (body.stores || []).forEach(row => {
    let name = '', sup = '', region = '';
    if (Array.isArray(row)) {
      name = String(row[0] || '').trim(); sup = String(row[1] || '').trim(); region = String(row[2] || '').trim();
    } else if (row && typeof row === 'object') {
      name = String(row.name || '').trim();
      sup = String(row.sup || row.supervisor || '').trim();
      region = String(row.region || '').trim();
    } else { name = String(row || '').trim(); }
    if (!name || seen[name]) return;
    seen[name] = true;
    list.push([name, sup, region]);
  });
  const sh = getStoresSheet_();
  sh.clearContents();
  sh.appendRow(['name', 'supervisor', 'region']);
  list.forEach(r => sh.appendRow(r));
  return { saved: true, count: list.length };
}

// ===== 門市／督導主檔＝Google 試算表「門店資料表_UG」（三套系統共用）=====
// 文宣申請／修繕進度／本系統都同步自這份試算表；本系統仍可在「資料維護」手動增修，
// 同步時**只新增與更新，永不刪除**手動加的門市。
const MASTER_SHEET = {
  ID:  '1MMsKbGNR1gEnI04TLBpv3SR47bqh5CYrd1RSVwohdT4',   // Script Property: MASTER_SHEET_ID 可覆寫
  GID: 1076844819                                        // 門市資料分頁（MASTER_SHEET_GID 可覆寫）
};
const PEER_SYSTEMS = [
  { name: '文宣申請系統',
    url:  'https://script.google.com/macros/s/AKfycbwn-hiS6mPpxw3BmZCqTmH211g0AwI7KW7xiBMzWyYXdymk5eBYCeL3eRZq6kz1u9yrRw/exec',
    auth: { token: 'pr_kQ7mZ2xV9tLpA4nBwR8sYcEf' } },
  { name: '修繕進度系統',
    url:  'https://script.google.com/macros/s/AKfycbwF7YapsErRssEKCC_NkcxdlztXaJ_NKLi6LjJ2EvFCxn2U_FmW1I4oCrQ23uqhjcLh5g/exec',
    auth: { adminKey: 'UGfix-7Q2x9' } }
];
function normStore_(s) { return String(s == null ? '' : s).trim().replace(/店$/, ''); }
function masterSheet_() {
  const p = props_();
  const id  = p.getProperty('MASTER_SHEET_ID')  || MASTER_SHEET.ID;
  const gid = Number(p.getProperty('MASTER_SHEET_GID') || MASTER_SHEET.GID);
  const ss = SpreadsheetApp.openById(id);
  const hit = ss.getSheets().filter(sh => sh.getSheetId() === gid)[0];
  return hit || ss.getSheets()[0];
}
// 讀主檔 → [{name, sup, region}]（同門市直營／加盟兩列只取一筆；標題列自動偵測）
function masterStores_() {
  const values = masterSheet_().getDataRange().getValues();
  let hr = -1, cStore = -1, cSup = -1, cRegion = -1;
  for (let i = 0; i < Math.min(values.length, 12); i++) {
    const row = values[i].map(x => String(x == null ? '' : x).replace(/\s/g, ''));
    const si = row.indexOf('門市');
    const pi = row.map(x => x.indexOf('督導') >= 0).indexOf(true);
    if (si >= 0 && pi >= 0) { hr = i; cStore = si; cSup = pi; cRegion = row.indexOf('區域'); break; }
  }
  if (hr < 0) throw new Error('門店資料表找不到「門市」與「督導」欄位（請確認分頁 gid）');
  const out = [], idx = {};
  for (let i = hr + 1; i < values.length; i++) {
    const name = String(values[i][cStore] == null ? '' : values[i][cStore]).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const sup = String(values[i][cSup] == null ? '' : values[i][cSup]).replace(/\s+/g, ' ').trim();
    const region = cRegion >= 0 ? String(values[i][cRegion] == null ? '' : values[i][cRegion]).replace(/\s+/g, ' ').trim() : '';
    const key = normStore_(name);
    if (idx[key]) { if (sup && !idx[key].sup) idx[key].sup = sup; continue; }
    const rec = { name: name, sup: sup, region: region };
    idx[key] = rec; out.push(rec);
  }
  if (!out.length) throw new Error('門店資料表沒有讀到任何門市');
  return out;
}
function syncStoresFromMaster_(body) {
  const master = masterStores_();
  const cur = listStoreDir_();
  const idx = {};                                   // 正規化門市名 → 目前這裡的名稱
  cur.forEach(r => { idx[normStore_(r.name)] = r; });
  // 新門市要不要帶「店」字尾：跟著本系統既有清單的多數寫法走（避免同一份清單兩種命名）
  const useSuffix = cur.length ? (cur.filter(r => /店$/.test(r.name)).length * 2 >= cur.length) : true;
  const added = [], changed = [], moved = [], seen = {};
  master.forEach(rec => {
    const key = normStore_(rec.name);
    if (!key) return;
    seen[key] = 1;
    let row = idx[key];
    if (!row) {                                     // 主檔有、這裡沒有 → 新增
      row = { name: useSuffix ? rec.name : key, sup: '', region: '' };
      idx[key] = row; cur.push(row); added.push(row.name);
    }
    if (rec.sup && row.sup !== rec.sup) { row.sup = rec.sup; changed.push(row.name + '→' + rec.sup); }
    if (rec.region) {
      if (row.region && row.region !== rec.region) moved.push(row.name + '：' + row.region + '→' + rec.region);
      row.region = rec.region;
    }
  });
  const onlyHere = cur.filter(r => !seen[normStore_(r.name)]).map(r => r.name);
  saveStores_({ stores: cur.map(r => [r.name, r.sup, r.region || '']) });
  props_().setProperty('STORE_SYNC_AT', new Date().toISOString());
  const res = {
    stores: cur.length, added: added, supervisorChanged: changed, regionMoved: moved,
    onlyHere: onlyHere, at: props_().getProperty('STORE_SYNC_AT')
  };
  if (!(body && body.noFanout)) res.peers = fanoutSync_();
  return res;
}
// 同步後通知另外兩套系統也各自去主檔同步一次（失敗不影響本系統）
function fanoutSync_() {
  return PEER_SYSTEMS.map(p => {
    try {
      const res = UrlFetchApp.fetch(p.url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(Object.assign({ action: 'syncStores', noFanout: true }, p.auth)),
        muteHttpExceptions: true
      });
      const j = JSON.parse(res.getContentText());
      const d = j.data || j;
      return { system: p.name, ok: !!j.ok, stores: d.stores || 0,
               added: (d.added || []).length, changed: (d.supervisorChanged || []).length, error: j.error || '' };
    } catch (e) { return { system: p.name, ok: false, error: String((e && e.message) || e) }; }
  });
}
// 編輯器工具：確認主檔讀得到
function checkMasterSheet() {
  const list = masterStores_();
  Logger.log('主檔門市數：' + list.length);
  Logger.log(JSON.stringify(list.slice(0, 3)));
  return list.length;
}
// 每日自動同步：編輯器左側「觸發條件」新增 → 函式 dailySyncStores、時間驅動、每日
function dailySyncStores() {
  try { Logger.log('門市同步完成：' + JSON.stringify(syncStoresFromMaster_({ noFanout: true }))); }
  catch (e) { Logger.log('門市同步失敗：' + e); }
}

// ===== 入口 =====
function doGet() {
  return json_({ ok: true, data: { service: 'store-anomaly', time: new Date().toISOString() } });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    // LINE webhook 呼叫：帶 events 陣列、沒有我們的 token。擷取 groupId/userId 並回覆到聊天室。
    if (Array.isArray(body.events)) { handleWebhook_(body.events); return json_({ ok: true }); }
    if (body.token !== CONFIG.API_TOKEN) return json_({ ok: false, error: '未授權' });
    // 管理權限動作：需要正確的管理密碼（門市夥伴只能 create / 讀品名主檔）
    const adminActions = ['requestSupp', 'cancelSupp', 'list', 'update', 'delete', 'pushTest', 'saveLine', 'saveProducts', 'saveStores', 'diagLine', 'capturedIds', 'repairCaseNos', 'setCapture'];
    if (adminActions.indexOf(body.action) >= 0 && body.adminPass !== CONFIG.ADMIN_PASSWORD) {
      return json_({ ok: false, error: '管理密碼錯誤' });
    }
    switch (body.action) {
      case 'list':         return json_({ ok: true, data: listCases_() });
      case 'create':       return json_({ ok: true, data: createCase_(body) });
      case 'update':       return json_({ ok: true, data: updateCase_(body) });
      case 'delete':       return json_({ ok: true, data: deleteCase_(body) });        // 刪除案件
      case 'pushTest':     return json_({ ok: true, data: pushTest_(body) });
      case 'saveLine':     return json_({ ok: true, data: saveLine_(body) });
      case 'products':     return json_({ ok: true, data: listProducts_() });       // 門市端載入下拉用
      case 'saveProducts': return json_({ ok: true, data: saveProducts_(body) });    // 管理端批次覆寫主檔
      case 'stores':       return json_({ ok: true, data: listStores_() });          // 門市端載入門市下拉用（純名稱，相容舊前端）
      case 'storeDir':     return json_({ ok: true, data: { list: listStoreDir_(), regionOrder: regionOrder_(), syncAt: props_().getProperty('STORE_SYNC_AT') || '' } });  // 門市＋督導＋區域
      case 'saveStores':   return json_({ ok: true, data: saveStores_(body) });      // 管理端批次覆寫門市主檔
      case 'syncStores':   return json_({ ok: true, data: syncStoresFromMaster_(body) });  // 從門店資料表同步門市／督導
      case 'diagLine':     return json_({ ok: true, data: diagLine_() });             // 診斷：檢查後端 LINE 設定與目標推播結果
      case 'capturedIds':  return json_({ ok: true, data: getCapturedIds_() });        // 查詢 webhook 擷取到的 group/user ID
      case 'repairCaseNos':return json_({ ok: true, data: repairCaseNos_() });          // 一鍵修復歷史重複案號
      case 'setCapture':   return json_({ ok: true, data: setCapture_(body) });          // 開/關 webhook 擷取 ID 模式
      // ── 補件 ──
      case 'requestSupp':  return json_({ ok: true, data: requestSupp_(body) });   // 管理：要求門市補件（寄 Email）
      case 'cancelSupp':   return json_({ ok: true, data: cancelSupp_(body) });    // 管理：取消補件要求
      case 'suppPending':  return json_({ ok: true, data: suppPending_(body) });   // 門市：本店待補件清單
      case 'suppGet':      return json_({ ok: true, data: suppGet_(body) });       // 門市：用連結代碼讀取補件內容
      case 'suppSubmit':   return json_({ ok: true, data: suppSubmit_(body) });    // 門市：送出補件
      default:             return json_({ ok: false, error: '未知 action：' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== LINE webhook：擷取群組/使用者 ID =====
// 把 /exec 設為 LINE 的 Webhook URL 後，群組訊息或加入事件會打到這裡。
// 我們取出 groupId/roomId/userId：存進 Script Properties（保留最近 20 筆），並回覆到聊天室方便直接複製。
function handleWebhook_(events) {
  const p = props_();
  // 擷取模式預設關閉：不回覆、不擷取，避免 bot 在群組裡一直回 groupId。
  // 需要抓新群組/個人 ID 時，用 setCapture 動作打開(on)，抓完再關。
  if (p.getProperty('CAPTURE_ON') !== '1') return;
  const token = lineCfg_().token;
  let captured = [];
  try { captured = JSON.parse(p.getProperty('CAPTURED_IDS') || '[]'); } catch (e) { captured = []; }

  (events || []).forEach(ev => {
    const src = ev.source || {};
    const id = src.groupId || src.roomId || src.userId || '';
    if (!id) return;
    const kind = src.groupId ? 'group' : (src.roomId ? 'room' : 'user');
    captured.unshift({ kind: kind, id: id, event: ev.type || '', at: new Date().toISOString() });

    // 回覆 ID 到聊天室（需要有 token 與 replyToken；reply 不需目標 ID）
    if (token && ev.replyToken) {
      const label = kind === 'group' ? '群組 groupId' : (kind === 'room' ? '多人聊天 roomId' : '個人 userId');
      const text = '✅ 本' + (kind === 'group' ? '群組' : (kind === 'room' ? '聊天室' : '對話')) +
        '的推播目標 ID（' + label + '）：\n' + id +
        '\n\n請把這串貼到系統「LINE 通知設定 → 推播目標 ID」並按「儲存設定」。';
      try {
        UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'post', contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: text }] }),
          muteHttpExceptions: true
        });
      } catch (e) { /* 回覆失敗不影響擷取 */ }
    }
  });

  p.setProperty('CAPTURED_IDS', JSON.stringify(captured.slice(0, 20)));
}
function getCapturedIds_() {
  try { return JSON.parse(props_().getProperty('CAPTURED_IDS') || '[]'); } catch (e) { return []; }
}
// 開/關擷取模式（body.on = true/false）。關閉時 webhook 不回覆、不擷取。
function setCapture_(body) {
  props_().setProperty('CAPTURE_ON', body.on ? '1' : '0');
  return { captureOn: !!body.on };
}

// ===== 資料表 =====
function getSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  else if (sh.getLastColumn() < HEADERS.length) {   // 舊表補上新欄位標題（supp / history）
    const cur = sh.getLastColumn();
    sh.getRange(1, cur + 1, 1, HEADERS.length - cur).setValues([HEADERS.slice(cur)]);
  }
  // 把日期欄(date/mfg/exp)設為純文字，避免被試算表自動轉成 Date(時區位移/篩選問題)。只需做一次。
  if (props_().getProperty('DATE_COLS_TEXT') !== '1') {
    ['date', 'mfg', 'exp'].forEach(function (f) {
      sh.getRange(1, HEADERS.indexOf(f) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
    props_().setProperty('DATE_COLS_TEXT', '1');
  }
  return sh;
}

function rowToObj_(row) {
  const o = {};
  HEADERS.forEach((h, i) => { o[h] = row[i] !== undefined ? row[i] : ''; });
  ['date', 'mfg', 'exp'].forEach(function (f) { o[f] = ymdStr_(o[f]); });   // 統一輸出 yyyy-MM-dd
  try { o.media = o.mediaUrls ? JSON.parse(o.mediaUrls) : []; } catch (e) { o.media = []; }
  delete o.mediaUrls;
  try { o.supp = o.supp ? JSON.parse(o.supp) : null; } catch (e) { o.supp = null; }
  try { o.history = o.history ? JSON.parse(o.history) : []; } catch (e) { o.history = []; }
  if (o.createdAt && Object.prototype.toString.call(o.createdAt) === '[object Date]') o.createdAt = o.createdAt.toISOString();
  return o;
}

// 把任何形式的日期值統一成 yyyy-MM-dd 字串(Date 物件→格式化；字串→取前10碼；空→空)
function ymdStr_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, getTz_(), 'yyyy-MM-dd');
  }
  const s = String(v);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}
let TZ_;
function getTz_() {
  if (!TZ_) { try { TZ_ = getSpreadsheet_().getSpreadsheetTimeZone(); } catch (e) { TZ_ = 'Asia/Taipei'; } }
  return TZ_ || 'Asia/Taipei';
}

function listCases_() {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  return values.slice(1)
    .map(rowToObj_)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 新到舊
}

function pad3_(n) { return String(n).padStart(3, '0'); }

function genCaseNo_(sh, store, date) {
  const base = String(date).replace(/-/g, '');
  const prefix = store + base;
  const rows = sh.getDataRange().getValues().slice(1);
  let seq = 0;
  // 用「案件編號」欄(文字)的前綴計數；日期欄會被試算表轉成 Date 物件，直接比對日期會失敗導致每筆都算 001
  rows.forEach(r => { if (String(r[0]).indexOf(prefix) === 0) seq++; });
  return prefix + pad3_(seq + 1);
}

// 一鍵修復歷史重複案號：依列順序(=建立順序)，把同前綴(門市+日期)的案號重編為 001、002…
function repairCaseNos_() {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  const caseCol = HEADERS.indexOf('caseNo');
  const counter = {};
  const changes = [];
  for (let i = 1; i < values.length; i++) {
    const caseNo = String(values[i][caseCol] || '');
    if (!caseNo) continue;
    const prefix = caseNo.replace(/\d{1,3}$/, '');   // 去掉尾端 3 碼序號，留下 門市+日期
    counter[prefix] = (counter[prefix] || 0) + 1;
    const newNo = prefix + pad3_(counter[prefix]);
    if (newNo !== caseNo) {
      sh.getRange(i + 1, caseCol + 1).setValue(newNo);
      changes.push({ row: i + 1, from: caseNo, to: newNo });
    }
  }
  return { fixed: changes.length, changes: changes };
}

// ===== 附件上傳 Drive =====
function uploadMedia_(media) {
  if (!media || !media.length) return [];
  const folder = getFolder_();
  return media.map(m => {
    let b64 = m.data || '';
    let mime = m.type === 'video' ? 'video/mp4' : 'image/jpeg';
    const match = /^data:([^;]+);base64,(.*)$/.exec(b64);
    if (match) { mime = match[1]; b64 = match[2]; }
    const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, m.name || ('media_' + Date.now()));
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const id = file.getId();
    return {
      type:  m.type || (mime.indexOf('video') === 0 ? 'video' : 'image'),
      name:  m.name || file.getName(),
      id:    id,                                                  // 前端用它組縮圖/預覽網址
      url:   'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600', // 縮圖端點較穩定可內嵌
      view:  'https://drive.google.com/file/d/' + id + '/view'    // 點開檢視
    };
  });
}

// ===== 建立案件 =====
function createCase_(body) {
  // 蜜罐：機器人若填了隱藏欄位 hp → 直接忽略(不儲存、不推播)
  if (body.hp) return { caseNo: '', ignored: true };
  const c = body.case || {};
  const store = String(c.store || '');
  // 同門市 10 秒內僅能送一筆，避免重複點送/洗版
  const cache = CacheService.getScriptCache();
  const rlKey = 'rl_' + store;
  if (store && cache.get(rlKey)) throw new Error('送太快了，請 10 秒後再送出');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // 序列化，避免跨門市同時送出時案號重複
  try {
    const sh = getSheet_();
    const uploaded = uploadMedia_(body.media);
    const caseNo = genCaseNo_(sh, c.store, c.date);
    const obj = {
      caseNo: caseNo, date: c.date || '', store: c.store || '', name: c.name || '',
      mat: c.mat || '', mfg: c.mfg || '', exp: c.exp || '', qty: c.qty || '',
      cls: c.cls || '', desc: c.desc || '',
      mediaUrls: JSON.stringify(uploaded),
      handle: '', method: '', result: '', status: 'pend',
      createdAt: new Date().toISOString()
    };
    sh.appendRow(HEADERS.map(h => (obj[h] !== undefined ? obj[h] : '')));
    if (store) cache.put(rlKey, '1', 10);   // 成功後設 10 秒冷卻
    pushLine_(obj, uploaded, lineCfg_());   // 用後端儲存的 LINE 設定，任何門市裝置送出都會通知
    return rowToObj_(HEADERS.map(h => obj[h]));
  } finally {
    lock.releaseLock();
  }
}

// ===== 更新處理結果 =====
function updateCase_(body) {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  const col = HEADERS.indexOf('caseNo');
  // 審核人員可調整的欄位：品名/料號/數量/分類/製造/有效 ＋ 處理三欄與狀態。只更新「有帶到」的欄位。
  const editable = ['name', 'mat', 'qty', 'cls', 'mfg', 'exp', 'handle', 'method', 'result', 'status'];
  for (let i = 1; i < values.length; i++) {
    if (values[i][col] === body.caseNo) {
      const row = i + 1;
      const old = rowToObj_(values[i]);
      // 待補件中的案件：一般儲存不會把狀態蓋掉（要取消補件請用 cancelSupp）；
      //   但處理三欄都填完＝直接結案(done)，同時讓補件連結失效
      if (old.status === 'supp' && body.status !== undefined && body.status !== 'done' && !body.forceStatus) body.status = 'supp';
      if (old.status === 'supp' && body.status === 'done' && old.supp) {
        sh.getRange(row, HEADERS.indexOf('supp') + 1).setValue(JSON.stringify(Object.assign({}, old.supp, { token: '', closedAt: new Date().toISOString() })));
      }
      editable.forEach(f => {
        if (body[f] !== undefined) sh.getRange(row, HEADERS.indexOf(f) + 1).setValue(body[f]);
      });
      if (body.status !== undefined && body.status !== old.status) {
        addHistory_(sh, row, old.history, '狀態 ' + statusName_(old.status) + ' → ' + statusName_(body.status), '');
      }
      return rowToObj_(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]);
    }
  }
  throw new Error('找不到案件：' + body.caseNo);
}

// ===== 刪除案件 =====
function deleteCase_(body) {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  const col = HEADERS.indexOf('caseNo');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col]) === String(body.caseNo)) {
      sh.deleteRow(i + 1);   // 刪除整列（Drive 附件保留在資料夾，不一併刪除）
      return { deleted: true, caseNo: body.caseNo };
    }
  }
  return { deleted: false, caseNo: body.caseNo };
}

// ===== LINE 設定（存在 Script Properties，全門市共用）=====
function lineCfg_() {
  const p = props_();
  return {
    token:    p.getProperty('LINE_TOKEN')    || CONFIG.LINE_TOKEN,
    to:       p.getProperty('LINE_TO')       || CONFIG.LINE_TO,
    template: p.getProperty('LINE_TEMPLATE') || CONFIG.LINE_TEMPLATE,
    link:     p.getProperty('LINE_LINK')     || CONFIG.LINE_LINK
  };
}
function saveLine_(body) {
  const p = props_();
  const line = body.line || {};
  // 只更新「有帶到」的欄位，避免部分更新時誤清掉 token / 目標 ID
  if (line.token    !== undefined) p.setProperty('LINE_TOKEN',    String(line.token || '').trim());
  if (line.to       !== undefined) p.setProperty('LINE_TO',       String(line.to    || '').trim());
  if (line.template !== undefined) p.setProperty('LINE_TEMPLATE', String(line.template || ''));
  if (line.link     !== undefined) p.setProperty('LINE_LINK',     String(line.link || '').trim());
  return { saved: true };
}

// 依範本組訊息：把 {caseNo} 等代入欄位換成案件值。空值會代成空字串（製造/有效日期沒填即留空）。
function buildLineMsg_(obj, line) {
  const tpl  = (line && line.template) || CONFIG.LINE_TEMPLATE;
  const link = CONFIG.LINE_LINK;   // {link} 固定＝管理入口(admin.html)，不受前台儲存值覆蓋
  const map = {
    '{caseNo}': obj.caseNo || '', '{name}': obj.name || '', '{qty}': obj.qty || '',
    '{mat}':    obj.mat    || '', '{mfg}':  obj.mfg  || '', '{exp}': obj.exp || '',
    '{date}':   obj.date   || '', '{desc}': obj.desc || '', '{cls}': obj.cls || '',
    '{store}':  obj.store  || '', '{link}': link     || '',
    '{supervisor}': obj.supervisor || supOf_(obj.store) || ''
  };
  let s = String(tpl);
  Object.keys(map).forEach(k => { s = s.split(k).join(map[k]); });
  return s;
}

// ===== LINE 推播 =====
// 訊息內容依「LINE 通知設定」的範本組成。
// 有填目標 ID => push 給指定對象；沒填 ID => 改用 broadcast 廣播，確保至少會通知到（修正先前沒收到通知的問題）。
function pushLine_(obj, media, line) {
  const token = (line && line.token) || CONFIG.LINE_TOKEN;
  const toRaw = (line && line.to)    || CONFIG.LINE_TO;
  if (!token) return { targets: 0, results: [] };
  const messages = [{ type: 'text', text: buildLineMsg_(obj, line) }];
  const targets = String(toRaw || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!targets.length) {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/broadcast', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ messages: messages }),
      muteHttpExceptions: true
    });
    return { targets: 0, broadcast: true, results: [{ code: res.getResponseCode(), detail: res.getContentText() }] };
  }

  const results = targets.map(id => {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: id, messages: messages }),
      muteHttpExceptions: true
    });
    return { to: id, code: res.getResponseCode(), detail: res.getContentText() };
  });
  return { targets: targets.length, results: results };
}

// 診斷：回報後端是否已存 LINE token／目標 ID，並對每個目標實際 push 一則，回傳 LINE 的 HTTP 碼與訊息。
// 不回傳 token 內容；目標 ID 以遮罩呈現，保護隱私。
function diagLine_() {
  const cfg = lineCfg_();
  const token = cfg.token || '';
  const targets = String(cfg.to || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = {
    hasToken: !!token,
    tokenLen: token.length,
    targetCount: targets.length,
    templateLen: (cfg.template || '').length,
    link: cfg.link || '',
    results: []
  };
  if (token && targets.length) {
    const msg = '【診斷】門市異常回報系統 推播測試 ' +
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm:ss');
    out.results = targets.map(id => {
      const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
        method: 'post', contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ to: id, messages: [{ type: 'text', text: msg }] }),
        muteHttpExceptions: true
      });
      return {
        toMasked: id.length > 7 ? (id.slice(0, 4) + '...' + id.slice(-3)) : (id.slice(0, 2) + '...'),
        code: res.getResponseCode(),
        detail: res.getContentText()
      };
    });
  }
  return out;
}

// 測試訊息：用「廣播」發送，不需任何目標 ID（會送給所有加過此官方帳號好友的人＝測試時就是你自己）
function pushTest_(body) {
  const token = (body.line && body.line.token) || lineCfg_().token;
  if (!token) return { code: 0, detail: '缺少 LINE Channel access token' };
  const msg = '【測試訊息】門市物料異常回報系統\n收到這則代表 LINE 串接成功 ✅\n時間：' +
    Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm');
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ messages: [{ type: 'text', text: msg }] }),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), detail: res.getContentText() };
}

// ===================================================================
// ===== 補件（管理端要求 → Email 通知門市 → 門市用連結補件 → 回到處理中）=====
// ===================================================================
function statusName_(s) { return ({ pend: '待處理', doing: '處理中', supp: '待補件', done: '已處理' })[s] || s || '-'; }
function addHistory_(sh, row, hist, act, note) {
  const h = Array.isArray(hist) ? hist.slice() : [];
  h.push({ at: new Date().toISOString(), act: act, note: note || '' });
  sh.getRange(row, HEADERS.indexOf('history') + 1).setValue(JSON.stringify(h.slice(-50)));
  return h;
}
function findCase_(sh, caseNo) {
  const values = sh.getDataRange().getValues();
  const col = HEADERS.indexOf('caseNo');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col]) === String(caseNo)) return { row: i + 1, obj: rowToObj_(values[i]) };
  }
  throw new Error('找不到案件：' + caseNo);
}
function setField_(sh, row, f, v) { sh.getRange(row, HEADERS.indexOf(f) + 1).setValue(v); }
function siteUrl_() { return props_().getProperty('SITE_URL') || SUPP.SITE_URL; }
function suppLink_(c, token) { return siteUrl_() + '?supp=' + encodeURIComponent(c.caseNo) + '&t=' + encodeURIComponent(token); }

// 門市 Email：讀「門店資料表_UG」的「門市Email」欄（直營、加盟都有）
function storeEmail_(store) {
  const cache = CacheService.getScriptCache();
  let map = null;
  try { map = JSON.parse(cache.get('STORE_EMAILS') || 'null'); } catch (e) { map = null; }
  if (!map) {
    map = {};
    const values = masterSheet_().getDataRange().getValues();
    let hr = -1, cStore = -1, cMail = -1;
    for (let i = 0; i < Math.min(values.length, 12); i++) {
      const row = values[i].map(x => String(x == null ? '' : x).replace(/\s/g, ''));
      if (row.indexOf('門市') >= 0) {
        hr = i; cStore = row.indexOf('門市');
        cMail = row.indexOf('門市Email');
        if (cMail < 0) cMail = row.map(x => /mail|信箱/i.test(x)).indexOf(true);
        break;
      }
    }
    if (hr >= 0 && cMail >= 0) {
      for (let i = hr + 1; i < values.length; i++) {
        const n = normStore_(values[i][cStore]); const m = String(values[i][cMail] || '').trim();
        if (n && m.indexOf('@') > 0) map[n] = m;        // 同店兩列（直營→加盟）以後面的為準
      }
    }
    try { cache.put('STORE_EMAILS', JSON.stringify(map), 21600); } catch (e) {}
  }
  return map[normStore_(store)] || '';
}
// 督導 Email：優先向修繕進度系統讀（同一份設定），失敗才用預設
function supEmails_() {
  const cache = CacheService.getScriptCache();
  try { const c = cache.get('SUP_EMAILS'); if (c) return JSON.parse(c); } catch (e) {}
  let map = Object.assign({}, DEFAULT_SUP_EMAILS);
  try {
    const repair = PEER_SYSTEMS.filter(p => p.name === '修繕進度系統')[0];
    if (repair) {
      const res = UrlFetchApp.fetch(repair.url, { method: 'post', contentType: 'application/json',
        payload: JSON.stringify(Object.assign({ action: 'getEmails' }, repair.auth)), muteHttpExceptions: true });
      const j = JSON.parse(res.getContentText());
      if (j.ok && j.emails) map = Object.assign(map, j.emails);
    }
  } catch (e) {}
  try { cache.put('SUP_EMAILS', JSON.stringify(map), 3600); } catch (e) {}   // 1 小時更新一次
  return map;
}
function supEmailOf_(sup) {
  const map = supEmails_(), s = String(sup || '').trim();
  if (!s) return '';
  if (map[s]) return map[s];
  const first = s.split(/\s+/)[0];
  const k = Object.keys(map).filter(k => k.indexOf(s) >= 0 || s.indexOf(k) >= 0 || k.split(/\s+/)[0] === first)[0];
  return k ? map[k] : '';
}
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }

// 補件通知信（首次／催辦共用）
function sendSuppMail_(c, supp, isRemind) {
  const to = storeEmail_(c.store);
  if (!to) return { emailed: false, reason: '門店資料表找不到「' + c.store + '」的門市Email' };
  const sup = supOf_(c.store);
  const cc = supEmailOf_(sup);   // 副本：該門市負責督導（督導信箱以修繕系統「督導 Email 通知」為準）
  const ccReason = !sup ? '門市「' + c.store + '」未設定負責督導' : (!cc ? '督導「' + sup + '」未設定 Email' : '');
  const link = suppLink_(c, supp.token);
  const subject = (isRemind ? '【催辦｜請盡速補件】' : '【需補件】') + c.store + '｜' + c.name + '（' + c.caseNo + '）';
  const items = (supp.items || []).join('、') || '-';
  const rows = [['案件編號', c.caseNo], ['門市', c.store], ['品名', c.name], ['異常日期', c.date],
                ['異常數量', c.qty], ['狀況描述', c.desc], ['需補資料', items], ['總部說明', supp.note || '-']];
  let h = '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#2c2c2c">';
  h += '<p>' + esc_(c.store) + ' 夥伴您好：</p>';
  h += isRemind
    ? '<p>以下物料異常案件<b style="color:#c0392b">仍待補件</b>（已於 ' + esc_(fmtTw_(supp.at)) + ' 通知），補齊後總部才能繼續向廠商處理，請盡速完成：</p>'
    : '<p>總部在處理以下物料異常案件時，<b>需要門市補充資料</b>，請點下方按鈕上傳：</p>';
  h += '<table style="border-collapse:collapse">';
  rows.forEach(r => { h += '<tr><td style="padding:2px 12px 2px 0;color:#6b6b6b;white-space:nowrap;vertical-align:top">' + esc_(r[0]) + '</td><td style="padding:2px 0' + (r[0] === '需補資料' || r[0] === '總部說明' ? ';font-weight:700;color:#9a3412' : '') + '">' + esc_(r[1]) + '</td></tr>'; });
  h += '</table>';
  h += '<p style="margin-top:18px"><a href="' + link + '" style="display:inline-block;background:#2c6e49;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700">👉 前往補件</a></p>';
  h += '<p style="font-size:12px;color:#888">按鈕無法點擊時，請複製此網址到瀏覽器開啟：<br>' + esc_(link) + '</p>';
  h += '<p style="color:#999;font-size:12px;margin-top:16px">（本信由 UG 門市物料異常回報系統自動發送，請勿直接回覆）</p></div>';
  const text = c.store + ' 夥伴您好：\n\n' + (isRemind ? '以下案件仍待補件，請盡速完成。' : '總部需要門市補充以下案件資料。') + '\n\n' +
    rows.map(r => r[0] + '：' + r[1]).join('\n') + '\n\n前往補件：' + link;
  const opt = { to: to, subject: subject, body: text, htmlBody: h, name: 'UG 物料異常回報系統' };
  if (cc && cc.toLowerCase() !== to.toLowerCase()) opt.cc = cc;
  MailApp.sendEmail(opt);
  return { emailed: true, to: to, cc: opt.cc || '', sup: sup, ccReason: ccReason };
}
function fmtTw_(iso) { try { return Utilities.formatDate(new Date(iso), 'Asia/Taipei', 'MM/dd HH:mm'); } catch (e) { return String(iso || ''); } }

// 管理：要求補件
function requestSupp_(body) {
  const items = (body.items || []).map(String).filter(Boolean);
  const note = String(body.note || '').trim();
  if (!items.length && !note) throw new Error('請勾選需補的資料或填寫說明');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = getSheet_();
    const f = findCase_(sh, body.caseNo), c = f.obj;
    const supp = { items: items, note: note, at: new Date().toISOString(), by: String(body.by || '管理'),
                   token: Utilities.getUuid().replace(/-/g, '').slice(0, 20), remindAt: '', remindCount: 0,
                   prevStatus: c.status === 'supp' ? ((c.supp && c.supp.prevStatus) || 'pend') : c.status };
    setField_(sh, f.row, 'supp', JSON.stringify(supp));
    setField_(sh, f.row, 'status', 'supp');
    addHistory_(sh, f.row, c.history, '要求補件', (items.join('、') + (note ? '｜' + note : '')));
    let mail;
    try { mail = sendSuppMail_(c, supp, false); } catch (e) { mail = { emailed: false, reason: String(e.message || e) }; }
    return Object.assign({ caseNo: c.caseNo, status: 'supp' }, mail,
      { case: rowToObj_(sh.getRange(f.row, 1, 1, HEADERS.length).getValues()[0]) });
  } finally { lock.releaseLock(); }
}
// 管理：取消補件（回到要求前的狀態）
function cancelSupp_(body) {
  const sh = getSheet_();
  const f = findCase_(sh, body.caseNo), c = f.obj;
  if (c.status !== 'supp') return { caseNo: c.caseNo, status: c.status };
  const back = (c.supp && c.supp.prevStatus) || 'pend';
  const supp = Object.assign({}, c.supp || {}, { token: '', cancelledAt: new Date().toISOString() });
  setField_(sh, f.row, 'supp', JSON.stringify(supp));
  setField_(sh, f.row, 'status', back);
  addHistory_(sh, f.row, c.history, '取消補件要求', '');
  return { caseNo: c.caseNo, status: back, case: rowToObj_(sh.getRange(f.row, 1, 1, HEADERS.length).getValues()[0]) };
}
// 給門市看的精簡案件資料（不含處理結果等內部欄位）
function suppView_(c) {
  return { caseNo: c.caseNo, store: c.store, date: c.date, name: c.name, mat: c.mat, mfg: c.mfg, exp: c.exp,
           qty: c.qty, cls: c.cls, desc: c.desc, mediaCount: (c.media || []).length,
           items: (c.supp && c.supp.items) || [], note: (c.supp && c.supp.note) || '', at: (c.supp && c.supp.at) || '',
           token: (c.supp && c.supp.token) || '' };
}
// 門市：本店待補件
function suppPending_(body) {
  const key = normStore_(body.store);
  if (!key) return [];
  return listCases_().filter(c => c.status === 'supp' && normStore_(c.store) === key && c.supp && c.supp.token).map(suppView_);
}
// 門市：用連結讀取
function suppGet_(body) {
  const c = findCase_(getSheet_(), body.caseNo).obj;
  if (c.status !== 'supp' || !c.supp || !c.supp.token) return { done: true, caseNo: c.caseNo, status: c.status };
  if (String(body.t || '') !== String(c.supp.token)) throw new Error('補件連結無效或已過期');
  return suppView_(c);
}
// 門市：送出補件
function suppSubmit_(body) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = getSheet_();
    const f = findCase_(sh, body.caseNo), c = f.obj;
    if (c.status !== 'supp' || !c.supp || !c.supp.token) throw new Error('此案件目前不需要補件（可能已補過或已取消）');
    if (String(body.t || '') !== String(c.supp.token)) throw new Error('補件連結無效或已過期');
    const items = c.supp.items || [];
    const fx = body.fields || {};
    const media = body.media || [];
    const reply = String(body.reply || '').trim();
    // 必補項目檢查
    if ((items.indexOf('照片') >= 0 || items.indexOf('批號或包裝標示照片') >= 0) && !media.some(m => m.type !== 'video')) throw new Error('請上傳照片');
    if (items.indexOf('影片') >= 0 && !media.some(m => m.type === 'video')) throw new Error('請上傳影片');
    if (items.indexOf('製造日期／有效日期') >= 0 && !(fx.mfg || fx.exp)) throw new Error('請填寫製造日期或有效日期');
    if (items.indexOf('異常數量') >= 0 && !String(fx.qty || '').trim()) throw new Error('請填寫異常數量');
    if (!media.length && !reply && !fx.mfg && !fx.exp && !fx.qty) throw new Error('請至少上傳附件或填寫補充說明');

    const changed = [];
    if (media.length) {
      const up = uploadMedia_(media);
      setField_(sh, f.row, 'mediaUrls', JSON.stringify((c.media || []).concat(up)));
      changed.push('附件 +' + up.length);
    }
    ['mfg', 'exp', 'qty'].forEach(k => {
      const v = String(fx[k] || '').trim();
      if (v && v !== String(c[k] || '')) { setField_(sh, f.row, k, v); changed.push(({ mfg: '製造日期', exp: '有效日期', qty: '數量' })[k] + '：' + v); }
    });
    if (reply) {
      setField_(sh, f.row, 'desc', (c.desc ? c.desc + '\n' : '') + '【門市補件 ' + fmtTw_(new Date().toISOString()) + '】' + reply);
      changed.push('說明：' + reply);
    }
    const supp = Object.assign({}, c.supp, { token: '', doneAt: new Date().toISOString(), reply: reply });
    setField_(sh, f.row, 'supp', JSON.stringify(supp));
    setField_(sh, f.row, 'status', SUPP.AFTER_STATUS);
    addHistory_(sh, f.row, c.history, '門市已補件', changed.join('；'));
    // 通知管理群組（LINE）＋督導（Email）
    const text = '🔁【門市已補件】\n案件編號：' + c.caseNo + '\n門市：' + c.store + '\n品名：' + c.name +
      '\n補件內容：' + (changed.join('；') || '-') + '\n狀態：待補件 → ' + statusName_(SUPP.AFTER_STATUS) + '\n連結：' + CONFIG.LINE_LINK;
    try { pushText_(text); } catch (e) {}
    try {
      const sm = supEmailOf_(supOf_(c.store));
      if (sm) MailApp.sendEmail({ to: sm, subject: '【已補件】' + c.store + '｜' + c.name + '（' + c.caseNo + '）', body: text, name: 'UG 物料異常回報系統' });
    } catch (e) {}
    return { ok: true, caseNo: c.caseNo, status: SUPP.AFTER_STATUS };
  } finally { lock.releaseLock(); }
}
// 純文字推播到既有 LINE 目標（同新案通知的對象）
function pushText_(text) {
  const line = lineCfg_();
  if (!line.token) return;
  const msgs = [{ type: 'text', text: text }];
  const targets = String(line.to || '').split(',').map(x => x.trim()).filter(Boolean);
  const call = (url, payload) => UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + line.token }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (!targets.length) call('https://api.line.me/v2/bot/message/broadcast', { messages: msgs });
  else targets.forEach(id => call('https://api.line.me/v2/bot/message/push', { to: id, messages: msgs }));
}

// ===== 每日催辦（觸發條件：執行一次 installSuppTrigger 即自動每天早上 9 點跑）=====
function dailySuppReminder() {
  const sh = getSheet_();
  const values = sh.getDataRange().getValues();
  const now = Date.now(), gap = SUPP.REMIND_DAYS * 24 * 3600 * 1000 - 30 * 60 * 1000;   // 容許 30 分鐘誤差
  let sent = 0, overdue = [];
  for (let i = 1; i < values.length; i++) {
    const c = rowToObj_(values[i]);
    if (c.status !== 'supp' || !c.supp || !c.supp.token) continue;
    const last = new Date(c.supp.remindAt || c.supp.at).getTime();
    if (!(now - last >= gap)) continue;
    const supp = Object.assign({}, c.supp, { remindAt: new Date().toISOString(), remindCount: (c.supp.remindCount || 0) + 1 });
    try { sendSuppMail_(c, supp, true); sent++; } catch (e) { Logger.log('催辦失敗 ' + c.caseNo + '：' + e); }
    setField_(sh, i + 1, 'supp', JSON.stringify(supp));
    addHistory_(sh, i + 1, c.history, '催辦補件（第 ' + supp.remindCount + ' 次）', '');
    overdue.push(c.store + '｜' + c.name + '（' + c.caseNo + '，已催 ' + supp.remindCount + ' 次）');
  }
  if (overdue.length) {
    try { pushText_('⏰【待補件催辦】以下案件門市尚未補件，已再次寄信通知：\n' + overdue.map(x => '・' + x).join('\n')); } catch (e) {}
  }
  Logger.log('催辦完成：寄出 ' + sent + ' 封');
  return sent;
}
function installSuppTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailySuppReminder').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailySuppReminder').timeBased().everyDays(1).atHour(9).inTimezone('Asia/Taipei').create();
  Logger.log('已設定每日 09:00 自動催辦');
}
// 首次授權寄信（在編輯器執行一次，會寄一封測試信給你自己）
function forceAuthMail() {
  const me = DEFAULT_SUP_EMAILS['呂韋興 Robert'];   // 測試信收件人（可改成自己的信箱）
  MailApp.sendEmail(me, 'UG 物料異常回報系統｜Email 授權測試', '收到這封信代表補件 Email 功能已授權完成。');
  Logger.log('test mail sent to ' + me);
}
